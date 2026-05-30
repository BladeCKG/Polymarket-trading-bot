import 'dotenv/config';
import {
  API_KEY,
  API_SECRET,
  API_PASSPHRASE,
  IS_DEPOSIT_WALLET_FLOW,
  MAX_LOSS_PER_HOUR_USDC,
} from '../config.js';
import { BeatDashboardServer } from './dashboard.js';
import logger from '../logger.js';
import { ClobClient } from '../clob.js';
import { getSigner, ensureApprovals } from '../onchain.js';
import { fetchMarketWithRetry, currentWindowTs, msUntil, nextWindowTs, slugFor } from '../market.js';
import { PnlTracker } from '../pnl.js';
import { BeatTrader } from './beat-trader.js';
import { BtcPriceFeed } from './btc-price-feed.js';
import { BEAT_LIFECYCLE } from './lifecycle.js';
import { applyBeatRuntimeConfigPatch, createBeatRuntimeConfig } from './runtime-config.js';

const PRICE_FEED_SOURCE_ORDER = ['binance', 'okx', 'coinbase', 'hyperliquid'];
let beatConfig = createBeatRuntimeConfig();

function feedConfigsFor(symbol) {
  const normalized = String(symbol ?? 'BTC').trim().toUpperCase();
  const restUrl = `https://api.binance.com/api/v3/ticker/price?symbol=${normalized}USDT`;
  return {
    rtds: {
      url: 'wss://ws-live-data.polymarket.com',
      productId: `${normalized.toLowerCase()}usdt`,
      topic: 'crypto_prices',
      restUrl,
    },
    binance: {
      url: `wss://stream.binance.com:9443/ws/${normalized.toLowerCase()}usdt@ticker`,
      productId: `${normalized}USDT`,
      restUrl,
    },
    coinbase: {
      url: 'wss://ws-feed.exchange.coinbase.com',
      productId: `${normalized}-USD`,
      restUrl,
    },
    okx: {
      url: 'wss://ws.okx.com:8443/ws/v5/public',
      productId: `${normalized}-USDT`,
      restUrl,
    },
    hyperliquid: {
      url: 'wss://api.hyperliquid.xyz/ws',
      productId: normalized,
      restUrl,
    },
  };
}

async function startup(wallet) {
  logger.info('Beat main: starting up', { wallet: wallet.address, dryRun: beatConfig.BEAT_DRY_RUN });
  if (!beatConfig.BEAT_DRY_RUN) {
    if (IS_DEPOSIT_WALLET_FLOW) {
      logger.info('Beat main: skipping ensureApprovals for deposit wallet flow', {
        signatureType: 3,
      });
    } else {
      await ensureApprovals();
    }
  }
  await ClobClient.init(wallet, {
    apiKey: API_KEY,
    secret: API_SECRET,
    passphrase: API_PASSPHRASE,
  });
  await ClobClient.probeL2Auth();
  logger.info('Beat main: startup complete');
}

let resolveStop = () => {};
const stopSignal = new Promise((resolve) => {
  resolveStop = resolve;
});

function sleep(ms) {
  return Promise.race([
    new Promise((resolve) => setTimeout(resolve, ms)),
    stopSignal,
  ]);
}

export async function main() {
  beatConfig = createBeatRuntimeConfig();

  const wallet = getSigner();
  await startup(wallet);

  const symbols = Array.isArray(beatConfig.BEAT_SYMBOLS) && beatConfig.BEAT_SYMBOLS.length
    ? beatConfig.BEAT_SYMBOLS
    : ['BTC'];
  const priceFeeds = new Map();
  const primaryPriceFeeds = new Map();
  const primaryPriceHistories = new Map();
  let dashboard = null;
  const beatSessionStats = {
    settledMarkets: 0,
    tradedMarkets: 0,
    realizedPnl: 0,
  };
  const settledMarketSlugs = new Set();
  const tradedSettledMarketSlugs = new Set();
  const publishBeatSessionStats = () => {
    dashboard?.setStats(beatSessionStats);
  };
  const recordSettledMarketStats = ({ slug, pnl: marketPnl, tradeOccurred }) => {
    const marketSlug = String(slug ?? '').trim();
    if (!marketSlug || settledMarketSlugs.has(marketSlug)) return;

    settledMarketSlugs.add(marketSlug);
    beatSessionStats.settledMarkets += 1;
    beatSessionStats.realizedPnl += Number.isFinite(Number(marketPnl)) ? Number(marketPnl) : 0;

    if (tradeOccurred && !tradedSettledMarketSlugs.has(marketSlug)) {
      tradedSettledMarketSlugs.add(marketSlug);
      beatSessionStats.tradedMarkets += 1;
    }

    publishBeatSessionStats();
  };

  if (beatConfig.BEAT_DASHBOARD_ENABLED) {
    dashboard = new BeatDashboardServer({
      host: beatConfig.BEAT_DASHBOARD_HOST,
      port: beatConfig.BEAT_DASHBOARD_PORT,
      runtime: {
        mode: 'beat',
        wallet: wallet.address,
        marketSymbols: symbols,
        dryRun: beatConfig.BEAT_DRY_RUN,
        startedAt: Date.now(),
      },
      config: beatConfig,
      onConfigUpdate: (patch) => {
        applyBeatRuntimeConfigPatch(beatConfig, patch);
        return beatConfig;
      },
    });
    const url = await dashboard.start();
    publishBeatSessionStats();
    logger.info('beat.main: dashboard available', { url });
  }

  for (const symbol of symbols) {
    const feedConfigs = feedConfigsFor(symbol);
    for (const source of PRICE_FEED_SOURCE_ORDER) {
      const feedConfig = feedConfigs[source];
      const feed = new BtcPriceFeed({
        ...feedConfig,
        source,
      });
      feed.on('tick', (tick) => {
        dashboard?.recordPrice({ ...tick, symbol, source });
        if (primaryPriceFeeds.get(symbol) === feed && Number.isFinite(Number(tick?.price)) && Number.isFinite(Number(tick?.timeMs))) {
          const history = primaryPriceHistories.get(symbol) ?? [];
          history.push({
            timeMs: Number(tick.timeMs),
            price: Number(tick.price),
          });
          const keepAfterMs = Date.now() - 120_000;
          primaryPriceHistories.set(symbol, history.filter((entry) => Number(entry?.timeMs ?? 0) >= keepAfterMs));
        }
      });
      feed.on('error', (err) => {
        logger.warn('Beat main: price feed error', { symbol, source, err: err.message });
      });
      feed.start();
      priceFeeds.set(`${symbol}-${source}`, feed);
      if (!primaryPriceFeeds.has(symbol)) {
        primaryPriceFeeds.set(symbol, feed);
      }
    }
  }

  const pnl = new PnlTracker();
  const runningTasks = new Set();
  const latestUpcomingSlug = new Map();
  const latestFetchedSlug = new Map();
  let stopping = false;
  const onStop = (sig) => {
    if (stopping) return;
    stopping = true;
    resolveStop();
    logger.info(`Beat main: ${sig} received, shutting down...`);
    setTimeout(() => {
      logger.warn('Beat main: forced exit after grace period');
      process.exit(0);
    }, 5_000).unref();
  };
  process.once('SIGINT', () => onStop('SIGINT'));
  process.once('SIGTERM', () => onStop('SIGTERM'));

  const upcomingDiscoveryTask = (async () => {
    while (!stopping) {
      const wts = nextWindowTs(beatConfig.MARKET_WINDOW_SECONDS);
      const openMs = wts * 1000;
      const closeMs = (wts + beatConfig.MARKET_WINDOW_SECONDS) * 1000;

      for (const symbol of symbols) {
        const slug = slugFor(wts, symbol);
        const latestUpcoming = latestUpcomingSlug.get(symbol);
        if (slug !== latestUpcoming) {
          latestUpcomingSlug.set(symbol, slug);
          logger.info('Beat main: staging upcoming market', {
            slug,
            symbol,
            opensIn: `${Math.round(msUntil(wts) / 1000)}s`,
          });
          if (dashboard) {
            dashboard.recordMarket({
              slug,
              marketSymbol: symbol,
              windowTs: wts,
              windowOpenAt: openMs,
              windowCloseAt: closeMs,
              conditionId: null,
              lifecycle: BEAT_LIFECYCLE.UPCOMING,
              tradeStatus: 'upcoming',
              settled: false,
              updatedAt: Date.now(),
            });
          }
        }
      }

      const fetchDelay = msUntil(wts) - 30_000;
      if (fetchDelay > 0) {
        await sleep(Math.min(fetchDelay, 10_000));
        continue;
      }

      for (const symbol of symbols) {
        const slug = slugFor(wts, symbol);
        const latestFetched = latestFetchedSlug.get(symbol);
        if (slug !== latestFetched) {
          try {
            const market = await fetchMarketWithRetry(slug, 30, 3_000);
            latestFetchedSlug.set(symbol, slug);
            if (dashboard) {
              dashboard.recordMarket({
                slug,
                marketSymbol: symbol,
                windowTs: wts,
                windowOpenAt: openMs,
                windowCloseAt: closeMs,
                conditionId: market?.conditionId ?? null,
                lifecycle: BEAT_LIFECYCLE.UPCOMING,
                tradeStatus: 'upcoming',
                settled: false,
                updatedAt: Date.now(),
              });
            }
          } catch (err) {
            logger.warn('Beat main: upcoming market fetch not ready yet', {
              slug,
              symbol,
              err: err.message,
            });
          }
        }
      }

      await sleep(5_000);
    }
  })();

  while (!stopping) {
    const hourlyLoss = pnl.rollingHourlyLoss();
    if (hourlyLoss > MAX_LOSS_PER_HOUR_USDC) {
      logger.error('Beat main: circuit breaker triggered', {
        hourlyLoss: hourlyLoss.toFixed(2),
        limit: MAX_LOSS_PER_HOUR_USDC,
      });
      break;
    }

    const wts = currentWindowTs(beatConfig.MARKET_WINDOW_SECONDS);
    const symbolTasks = symbols.map(async (symbol) => {
      const slug = slugFor(wts, symbol);
      let market;
      try {
        market = await fetchMarketWithRetry(slug, 30, 3_000);
        market.marketSymbol = symbol;
        if (dashboard) {
          dashboard.recordMarket({
            slug,
            marketSymbol: symbol,
            windowTs: wts,
            windowOpenAt: wts * 1000,
            windowCloseAt: (wts + beatConfig.MARKET_WINDOW_SECONDS) * 1000,
            conditionId: market?.conditionId ?? null,
            lifecycle: BEAT_LIFECYCLE.UPCOMING,
            tradeStatus: 'upcoming',
            settled: false,
            updatedAt: Date.now(),
          });
        }
      } catch (err) {
        logger.error('Beat main: failed to discover market, skipping window', {
          slug,
          symbol,
          err: err.message,
        });
        return;
      }

      if (stopping) return;

      const symbolFeed = primaryPriceFeeds.get(symbol) ?? priceFeeds.get(`${symbol}-binance`) ?? priceFeeds.get(`${symbol}-rtds`);
      const trader = new BeatTrader(market, wallet, pnl, {
        dashboard,
        btcFeed: symbolFeed,
        config: beatConfig,
        onSettled: recordSettledMarketStats,
        btcHistoryProvider: () => primaryPriceHistories.get(symbol) ?? [],
      });
      const task = trader.run()
        .then(() => {
          runningTasks.delete(task);
          pnl.printSessionSummary();
        })
        .catch((err) => {
          runningTasks.delete(task);
          logger.error('Beat main: trader threw', {
            slug,
            symbol,
            err: err.message,
            stack: err.stack,
          });
        });
      runningTasks.add(task);
    });

    await Promise.all(symbolTasks);

    const nextLoopMs = msUntil(wts + beatConfig.MARKET_WINDOW_SECONDS);
    if (nextLoopMs > 0) {
      await sleep(nextLoopMs);
    }
  }

  stopping = true;
  resolveStop();
  logger.info('Beat main: waiting for in-flight tasks to complete...', { count: runningTasks.size });
  await Promise.allSettled([...runningTasks]);
  await upcomingDiscoveryTask;
  pnl.printSessionSummary();
  for (const feed of priceFeeds.values()) {
    feed.stop();
  }
  dashboard?.stop();
  logger.info('Beat main: stopped');
  process.exit(0);
}
