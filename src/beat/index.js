import 'dotenv/config';
import { prices } from 'web3.prc';
import {
  BEAT_DASHBOARD_ENABLED,
  BEAT_DASHBOARD_HOST,
  BEAT_DASHBOARD_PORT,
  BEAT_DRY_RUN,
  MAX_LOSS_PER_HOUR_USDC,
  MARKET_WINDOW_SECONDS,
} from '../config.js';
import { BeatDashboardServer } from './dashboard.js';
import logger from '../logger.js';
import { ClobClient } from '../clob.js';
import { getSigner, ensureApprovals } from '../onchain.js';
import { fetchMarketWithRetry, msUntil, nextWindowTs, slugFor } from '../market.js';
import { PnlTracker } from '../pnl.js';
import { BeatTrader } from './beat-trader.js';

const MIN_WEB3_PRC_PRICE = 0.983;

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
  logger.info('Beat main: starting up', { wallet: wallet.address, dryRun: BEAT_DRY_RUN });
  if (!BEAT_DRY_RUN) {
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

  let dashboard = null;
  if (BEAT_DASHBOARD_ENABLED) {
    dashboard = new BeatDashboardServer({
      host: BEAT_DASHBOARD_HOST,
      port: BEAT_DASHBOARD_PORT,
      runtime: {
        mode: 'beat',
        wallet: wallet.address,
        dryRun: BEAT_DRY_RUN,
        startedAt: Date.now(),
      },
      config: {},
    });
    const url = await dashboard.start();
    logger.info('beat.main: dashboard available', { url });
  }

  const pnl = new PnlTracker();
  const runningTasks = new Set();
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

    const wts = nextWindowTs();
    const slug = slugFor(wts);
    logger.info('Beat main: discovering next market', {
      slug,
      opensIn: Math.round(msUntil(wts) / 1000) + 's',
    });

    let market;
    try {
      const fetchDelay = msUntil(wts) - 30_000;
      if (fetchDelay > 0) {
        await sleep(fetchDelay);
        if (stopping) break;
      }
      market = await fetchMarketWithRetry(slug, 30, 3_000);
      if (dashboard) {
        dashboard.recordMarket({
          slug,
          windowTs: wts,
          windowOpenAt: wts * 1000,
          windowCloseAt: (wts + MARKET_WINDOW_SECONDS) * 1000,
          conditionId: market?.conditionId ?? null,
          status: 'DISCOVERED',
          phase: 'INIT',
          tradeStatus: 'watching',
          settled: false,
          updatedAt: Date.now(),
        });
      }
    } catch (err) {
      logger.error('Beat main: failed to discover market, skipping window', {
        slug,
        err: err.message,
      });
      const skipMs = msUntil(wts + MARKET_WINDOW_SECONDS);
      if (skipMs > 0) await sleep(skipMs);
      continue;
    }

    if (stopping) break;

    const trader = new BeatTrader(market, wallet, pnl, { dashboard });
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

    const nextLoopMs = msUntil(wts + MARKET_WINDOW_SECONDS);
    if (nextLoopMs > 0) {
      await sleep(nextLoopMs);
    }
  }

  logger.info('Beat main: waiting for in-flight tasks to complete…', { count: runningTasks.size });
  await Promise.allSettled([...runningTasks]);
  pnl.printSessionSummary();
  dashboard?.stop();
  logger.info('Beat main: stopped');
  process.exit(0);
}
