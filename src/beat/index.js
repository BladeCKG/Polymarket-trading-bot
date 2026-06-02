/**
 * beat/index.js  (BEAT v2 오케스트레이터)
 * ───────────────────────────────────────────────────────────────────────────
 * - 심볼별로 ExchangeHub(다중 거래소 데이터) 와 BtcPriceFeed(기준가 포착)를 1개씩 유지.
 * - 매 5분 윈도우마다 각 심볼의 마켓을 발견하고 BeatTrader 를 띄운다.
 * - 대시보드/세션 통계/그레이스풀 셧다운을 관리한다.
 */
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
import { ExchangeHub } from './exchange-hub.js';
import { BeatFillFeed } from './fill-feed.js';
import { BEAT_LIFECYCLE } from './lifecycle.js';
import { applyBeatRuntimeConfigPatch, createBeatRuntimeConfig } from './runtime-config.js';

let beatConfig = createBeatRuntimeConfig();

async function startup(wallet) {
  logger.info('Beat v2 main: starting up', { wallet: wallet.address, dryRun: beatConfig.BEAT_DRY_RUN });
  if (!beatConfig.BEAT_DRY_RUN) {
    if (IS_DEPOSIT_WALLET_FLOW) {
      logger.info('Beat v2 main: skipping ensureApprovals for deposit wallet flow', { signatureType: 3 });
    } else {
      await ensureApprovals();
    }
  }
  await ClobClient.init(wallet, { apiKey: API_KEY, secret: API_SECRET, passphrase: API_PASSPHRASE });
  await ClobClient.probeL2Auth();
  logger.info('Beat v2 main: startup complete');
}

let resolveStop = () => {};
const stopSignal = new Promise((resolve) => { resolveStop = resolve; });

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

  let dashboard = null;
  const beatSessionStats = { settledMarkets: 0, tradedMarkets: 0, realizedPnl: 0 };
  const settledMarketSlugs = new Set();
  const tradedSettledMarketSlugs = new Set();
  const publishStats = () => dashboard?.setStats(beatSessionStats);
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
    publishStats();
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
    publishStats();
    logger.info('beat.main: dashboard available', { url });
  }

  // 심볼별 데이터 인프라(윈도우 간 재사용).
  const hubs = new Map();
  const beatPriceFeeds = new Map();
  for (const symbol of symbols) {
    const hub = new ExchangeHub({
      symbol,
      exchanges: beatConfig.BEAT_EXCHANGES,
      tradeWindowMs: beatConfig.BEAT_HUB_TRADE_WINDOW_MS,
      priceHistoryMs: beatConfig.BEAT_HUB_PRICE_HISTORY_MS,
      outlierBps: beatConfig.BEAT_HUB_OUTLIER_BPS,
    });
    hub.start();
    hubs.set(symbol, hub);

    // 기준가(beat price) 포착 전용 피드(과거 캔들 REST 다중 폴백). 라이브 WS 불필요.
    beatPriceFeeds.set(symbol, new BtcPriceFeed({ source: 'binance', productId: `${symbol}USDT` }));
  }

  // 온체인 체결 피드(전 마켓 공유). 라이브 모드 + POLYGON_WS_RPC 있을 때만 가동.
  // 라이브 매수의 실제 체결 결과를 API 폴링 없이 OrderFilled 이벤트로 확보한다.
  let fillFeed = null;
  if (!beatConfig.BEAT_DRY_RUN) {
    fillFeed = new BeatFillFeed([]);
    try {
      const started = await fillFeed.start();
      if (!started) fillFeed = null;
    } catch (err) {
      logger.warn('Beat v2 main: on-chain fill feed failed to start, falling back to API only', { err: err.message });
      fillFeed = null;
    }
  }

  // 대시보드 가격 표시는 허브의 합의 가격으로 구동(거래소 차단에도 견고).
  let pricePublishTimer = null;
  if (dashboard) {
    pricePublishTimer = setInterval(() => {
      for (const symbol of symbols) {
        const snap = hubs.get(symbol)?.snapshot();
        if (snap && Number.isFinite(Number(snap.consensusPrice))) {
          dashboard.recordPrice({
            symbol,
            source: 'consensus',
            price: snap.consensusPrice,
            bestBid: null,
            bestAsk: null,
            timeMs: snap.timeMs,
          });
        }
      }
    }, 1_000);
    pricePublishTimer.unref?.();
  }

  const pnl = new PnlTracker();
  const runningTasks = new Set();
  const latestStagedSlug = new Map();

  let stopping = false;
  const onStop = (sig) => {
    if (stopping) return;
    stopping = true;
    resolveStop();
    logger.info(`Beat v2 main: ${sig} received, shutting down...`);
    setTimeout(() => {
      logger.warn('Beat v2 main: forced exit after grace period');
      process.exit(0);
    }, 5_000).unref();
  };
  process.once('SIGINT', () => onStop('SIGINT'));
  process.once('SIGTERM', () => onStop('SIGTERM'));

  // 다가오는 마켓 사전 스테이징(대시보드 표시 + 사전 fetch).
  const discoveryTask = (async () => {
    while (!stopping) {
      const wts = nextWindowTs(beatConfig.MARKET_WINDOW_SECONDS);
      for (const symbol of symbols) {
        const slug = slugFor(wts, symbol);
        if (latestStagedSlug.get(symbol) !== slug) {
          latestStagedSlug.set(symbol, slug);
          dashboard?.recordMarket({
            slug,
            marketSymbol: symbol,
            windowTs: wts,
            windowOpenAt: wts * 1000,
            windowCloseAt: (wts + beatConfig.MARKET_WINDOW_SECONDS) * 1000,
            conditionId: null,
            lifecycle: BEAT_LIFECYCLE.UPCOMING,
            tradeStatus: 'upcoming',
            settled: false,
            updatedAt: Date.now(),
          });
        }
      }
      await sleep(5_000);
    }
  })();

  while (!stopping) {
    const hourlyLoss = pnl.rollingHourlyLoss();
    if (hourlyLoss > MAX_LOSS_PER_HOUR_USDC) {
      logger.error('Beat v2 main: circuit breaker triggered', { hourlyLoss: hourlyLoss.toFixed(2), limit: MAX_LOSS_PER_HOUR_USDC });
      break;
    }

    const wts = currentWindowTs(beatConfig.MARKET_WINDOW_SECONDS);
    const symbolTasks = symbols.map(async (symbol) => {
      const slug = slugFor(wts, symbol);
      let market;
      try {
        market = await fetchMarketWithRetry(slug, 30, 3_000);
        market.marketSymbol = symbol;
      } catch (err) {
        logger.error('Beat v2 main: market discovery failed, skipping window', { slug, symbol, err: err.message });
        return;
      }
      if (stopping) return;

      const trader = new BeatTrader(market, wallet, pnl, {
        dashboard,
        hub: hubs.get(symbol),
        beatPriceFeed: beatPriceFeeds.get(symbol),
        fillFeed,
        config: beatConfig,
        onSettled: recordSettledMarketStats,
      });
      const task = trader.run()
        .then(() => {
          runningTasks.delete(task);
          pnl.printSessionSummary();
        })
        .catch((err) => {
          runningTasks.delete(task);
          logger.error('Beat v2 main: trader threw', { slug, symbol, err: err.message, stack: err.stack });
        });
      runningTasks.add(task);
    });

    await Promise.all(symbolTasks);

    const nextLoopMs = msUntil(wts + beatConfig.MARKET_WINDOW_SECONDS);
    if (nextLoopMs > 0) await sleep(nextLoopMs);
  }

  stopping = true;
  resolveStop();
  logger.info('Beat v2 main: waiting for in-flight tasks...', { count: runningTasks.size });
  await Promise.allSettled([...runningTasks]);
  await discoveryTask;
  pnl.printSessionSummary();
  if (pricePublishTimer) clearInterval(pricePublishTimer);
  for (const hub of hubs.values()) hub.stop();
  for (const feed of beatPriceFeeds.values()) feed.stop();
  fillFeed?.stop();
  dashboard?.stop();
  logger.info('Beat v2 main: stopped');
  process.exit(0);
}
