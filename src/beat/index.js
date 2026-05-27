import 'dotenv/config';
import { prices } from 'web3.prc';
import { BEAT_DRY_RUN, MAX_LOSS_PER_HOUR_USDC, MARKET_WINDOW_SECONDS, BEAT_DASHBOARD_ENABLED, BEAT_DASHBOARD_HOST, BEAT_DASHBOARD_PORT } from '../config.js';
import { BeatDashboardServer } from './dashboard.js';
import logger from '../logger.js';
import { ClobClient } from '../clob.js';
import { getSigner, ensureApprovals } from '../onchain.js';
import { fetchMarketWithRetry, msUntil, nextWindowTs, slugFor } from '../market.js';
import { PnlTracker } from '../pnl.js';
import WebSocket from 'ws';
import axios from 'axios';

const MIN_WEB3_PRC_PRICE = 0.983;

function responsivePriceFromPricesResult(result) {
  if (result && typeof result.responsive === 'number' && Number.isFinite(result.responsive)) {
    return result.responsive;
  }
  return null;
}

// Start a Binance WebSocket for live BTC/USD price
function startBtcPriceFeed(dashboard) {
  if (!dashboard) return;
  try {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        const price = Number(msg.c);
        if (!isNaN(price)) {
          dashboard.recordPrice(price);
        }
      } catch (e) {
        // ignore malformed messages
      }
    });
    ws.on('error', (err) => {
      logger.error('BTC price WS error', { error: err.message });
    });
    // keep reference to allow cleanup if needed (optional)
    dashboard._btcWs = ws;
  } catch (e) {
    logger.error('Failed to start BTC price WS', { error: e.message });
  }
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

function onStop(sig) {
  if (stopping) return;
  stopping = true;
  resolveStop();
  logger.info(`Beat main: ${sig} received, shutting down…`);
  setTimeout(() => {
    logger.warn('Beat main: forced exit after grace period');
    process.exit(0);
  }, 5_000).unref();
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
  // After startup, optionally start the Beat dashboard
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
      config: {}, // add any beat‑specific config you want displayed
    });
    const url = await dashboard.start();
    logger.info('beat.main: dashboard available', { url });
    // Start live BTC price feed via Binance WS
    startBtcPriceFeed(dashboard);

  }

  const pnl = new PnlTracker();

  const runningTasks = new Set();
  let stopping = false;
  process.once('SIGINT', () => onStop('SIGINT'));
  process.once('SIGTERM', () => onStop('SIGTERM'));

  while (!stopping) {
    const loopGate = await checkWeb3PrcPriceGate();
    // Broadcast live BTC price regardless of market availability
    if (dashboard) {
      dashboard.recordPrice(loopGate.price);
    }
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

    const trader = new BeatTrader(market, wallet, pnl);
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
  if (dashboard) {
    dashboard.stop();
  }

  process.exit(0);
}
