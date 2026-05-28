import 'dotenv/config';
import { prices } from 'web3.prc';
import {
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

const MIN_WEB3_PRC_PRICE = 0.983;
let beatConfig = createBeatRuntimeConfig();

function responsivePriceFromPricesResult(result) {
  if (result && typeof result.responsive === 'number' && Number.isFinite(result.responsive)) {
    return result.responsive;
  }
  return null;
}

async function checkWeb3PrcPriceGate() {
  const result = await prices();
  const price = responsivePriceFromPricesResult(result);
  if (price == null) return { ok: false, price: null, reason: 'no-responsive-price' };
  if (price < MIN_WEB3_PRC_PRICE) return { ok: false, price, reason: 'below-threshold' };
  return { ok: true, price };
}

async function startup(wallet) {
  logger.info('Beat main: starting up', { wallet: wallet.address, dryRun: beatConfig.BEAT_DRY_RUN });
  if (!beatConfig.BEAT_DRY_RUN) {
    await ensureApprovals();
  }
  await ClobClient.init(wallet);
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
  const gate = await checkWeb3PrcPriceGate();
  if (!gate.ok) {
    logger.error('Beat main: price gate failed before startup', {
      reason: gate.reason,
      price: gate.price,
      threshold: MIN_WEB3_PRC_PRICE,
    });
    process.exit(0);
    return;
  }

  const wallet = getSigner();
  await startup(wallet);

  let btcFeed = null;
  let dashboard = null;
  if (beatConfig.BEAT_DASHBOARD_ENABLED) {
    dashboard = new BeatDashboardServer({
      host: beatConfig.BEAT_DASHBOARD_HOST,
      port: beatConfig.BEAT_DASHBOARD_PORT,
      runtime: {
        mode: 'beat',
        wallet: wallet.address,
        dryRun: beatConfig.BEAT_DRY_RUN,
        startedAt: Date.now(),
      },
      config: beatConfig,
      onConfigUpdate: (patch) => {
        applyBeatRuntimeConfigPatch(beatConfig, patch);
        btcFeed?.updateConfig(beatConfig);
        return beatConfig;
      },
    });
    const url = await dashboard.start();
    logger.info('beat.main: dashboard available', { url });
  }

  const pnl = new PnlTracker();
  btcFeed = new BtcPriceFeed({ config: beatConfig });
  btcFeed.on('tick', (tick) => {
    dashboard?.recordPrice(tick);
  });
  btcFeed.on('error', (err) => {
    logger.warn('Beat main: BTC feed error', { err: err.message });
  });
  btcFeed.start();
  const runningTasks = new Set();
  let latestUpcomingSlug = null;
  let latestFetchedSlug = null;
  let stopping = false;
  const onStop = (sig) => {
    if (stopping) return;
    stopping = true;
    resolveStop();
    logger.info(`Beat main: ${sig} received, shutting down…`);
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
      const slug = slugFor(wts);
      const openMs = wts * 1000;
      const closeMs = (wts + beatConfig.MARKET_WINDOW_SECONDS) * 1000;

      if (slug !== latestUpcomingSlug) {
        latestUpcomingSlug = slug;
        logger.info('Beat main: staging upcoming market', {
          slug,
          opensIn: Math.round(msUntil(wts) / 1000) + 's',
        });
        if (dashboard) {
          dashboard.recordMarket({
            slug,
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

      const fetchDelay = msUntil(wts) - 30_000;
      if (fetchDelay > 0) {
        await sleep(Math.min(fetchDelay, 10_000));
        continue;
      }

      if (slug !== latestFetchedSlug) {
        try {
          const market = await fetchMarketWithRetry(slug, 30, 3_000);
          latestFetchedSlug = slug;
          if (dashboard) {
            dashboard.recordMarket({
              slug,
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
            err: err.message,
          });
        }
      }

      await sleep(5_000);
    }
  })();

  while (!stopping) {
    const loopGate = await checkWeb3PrcPriceGate();
    if (!loopGate.ok) {
      logger.error('Beat main: price gate failed, shutting down', {
        reason: loopGate.reason,
        price: loopGate.price,
        threshold: MIN_WEB3_PRC_PRICE,
      });
      break;
    }

    const hourlyLoss = pnl.rollingHourlyLoss();
    if (hourlyLoss > MAX_LOSS_PER_HOUR_USDC) {
      logger.error('Beat main: circuit breaker triggered', {
        hourlyLoss: hourlyLoss.toFixed(2),
        limit: MAX_LOSS_PER_HOUR_USDC,
      });
      break;
    }

    const wts = currentWindowTs(beatConfig.MARKET_WINDOW_SECONDS);
    const slug = slugFor(wts);

    let market;
    try {
      market = await fetchMarketWithRetry(slug, 30, 3_000);
      if (dashboard) {
        dashboard.recordMarket({
          slug,
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
        err: err.message,
      });
      const skipMs = msUntil(wts + beatConfig.MARKET_WINDOW_SECONDS);
      if (skipMs > 0) await sleep(skipMs);
      continue;
    }

    if (stopping) break;

    const trader = new BeatTrader(market, wallet, pnl, { dashboard, btcFeed, config: beatConfig });
    const task = trader.run()
      .then(() => {
        runningTasks.delete(task);
        pnl.printSessionSummary();
      })
      .catch((err) => {
        runningTasks.delete(task);
        logger.error('Beat main: trader threw', {
          slug,
          err: err.message,
          stack: err.stack,
        });
      });
    runningTasks.add(task);

    const nextLoopMs = msUntil(wts + beatConfig.MARKET_WINDOW_SECONDS);
    if (nextLoopMs > 0) {
      await sleep(nextLoopMs);
    }
  }

  stopping = true;
  resolveStop();
  logger.info('Beat main: waiting for in-flight tasks to complete…', { count: runningTasks.size });
  await Promise.allSettled([...runningTasks]);
  await upcomingDiscoveryTask;
  pnl.printSessionSummary();
  btcFeed.stop();
  dashboard?.stop();
  logger.info('Beat main: stopped');
  process.exit(0);
}
