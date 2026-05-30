/**
 * index.js
 * Main entry point.
 *
 * Outer loop:
 *  1. Start up: validate config, ensure on-chain approvals, init CLOB creds.
 *  2. Every 5 minutes: discover the next btc-updown-5m market.
 *  3. Spawn a Trader instance for that market and await completion.
 *  4. Session-level circuit breaker: halt if rolling hourly loss > limit.
 *  5. Print running PnL after each market completes.
 *
 * The Trader for market N starts *before* market N's window opens, so it can
 * post the ladder right at `t=0`. Meanwhile the previous market's Trader is
 * still in its RESOLVING phase (waiting for oracle, ~t=600s after its window
 * close). Both run concurrently in separate async tasks.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import {
  PRIVATE_KEY,
  API_KEY,
  API_SECRET,
  API_PASSPHRASE,
  IS_DEPOSIT_WALLET_FLOW,
  MAX_LOSS_PER_HOUR_USDC,
  MARKET_WINDOW_SECONDS,
  TARGET_WALLET,
  COPY_DRY_RUN,
} from './config.js';
import logger from './logger.js';
import { ClobClient }                 from './clob.js';
import { getSigner, ensureApprovals } from './onchain.js';
import { fetchMarketWithRetry, nextWindowTs, slugFor, msUntil } from './market.js';
import { Trader }                     from './trader.js';
import { PnlTracker }                 from './pnl.js';
import { CopyTrader }                 from './copy-trader.js';
import { main as runCopyMain }        from './copy/index.js';
import { main as runValueMain }       from './value/index.js';
import { main as runBeatMain }        from './beat/index.js';

// Startup
async function startup(wallet) {
  logger.info('Bot starting up...', { wallet: wallet.address });

  // 1. Ensure on-chain approvals (USDC for exchange, CTF for adapter)
  if (IS_DEPOSIT_WALLET_FLOW) {
    logger.info('Bot startup: skipping ensureApprovals for deposit wallet flow', {
      signatureType: 3,
    });
  } else {
    await ensureApprovals({
      skipCtfExchangeUsdcApproval: COPY_DRY_RUN,
    });
  }

  // 2. Initialise CLOB credentials from the signer via Polymarket's
  // documented L1 -> L2 auth flow.
  await ClobClient.init(wallet, {
    apiKey: API_KEY,
    secret: API_SECRET,
    passphrase: API_PASSPHRASE,
  });
  await ClobClient.probeL2Auth();

  logger.info('Bot startup complete');
}

// Interruptible sleep
let _resolveStop = () => {};
const _stopSignal = new Promise((r) => { _resolveStop = r; });

function sleep(ms) {
  return Promise.race([
    new Promise((r) => setTimeout(r, ms)),
    _stopSignal,
  ]);
}

// Main loop
async function main() {
  if ((process.env.TRADING_MODE ?? '').toLowerCase() === 'copy') {
    logger.info('Main: TRADING_MODE=copy detected, starting dedicated copy runtime', {
      dryRun: COPY_DRY_RUN,
    });
    await runCopyMain();
    return;
  }
  if ((process.env.TRADING_MODE ?? '').toLowerCase() === 'value') {
    logger.info('Main: TRADING_MODE=value detected, starting dedicated value runtime');
    await runValueMain();
    return;
  }
  if ((process.env.TRADING_MODE ?? '').toLowerCase() === 'beat') {
    logger.info('Main: TRADING_MODE=beat detected, starting dedicated beat runtime');
    await runBeatMain();
    return;
  }

  const wallet = getSigner();
  await startup(wallet);

  const pnl = new PnlTracker();

  // Copy trader (optional)
  let copyTrader = null;
  if (TARGET_WALLET) {
    copyTrader = new CopyTrader(wallet);
    try {
      await copyTrader.snapshot();
      copyTrader.start();
    } catch (err) {
      logger.warn('CopyTrader: snapshot failed, copy trading disabled for this session', {
        err: err.message,
      });
      copyTrader = null;
    }
  }

  const runningTasks = new Set();

  let stopping = false;
  const onStop = (sig) => {
    if (stopping) return;
    stopping = true;
    _resolveStop();
    copyTrader?.stop();
    logger.info(`${sig} received, shutting down...`);
    setTimeout(() => {
      logger.warn('Forced exit after grace period');
      process.exit(0);
    }, 5_000).unref();
  };
  process.once('SIGINT', () => onStop('SIGINT'));
  process.once('SIGTERM', () => onStop('SIGTERM'));

  while (!stopping) {
    const hourlyLoss = pnl.rollingHourlyLoss();
    if (hourlyLoss > MAX_LOSS_PER_HOUR_USDC) {
      logger.error('CIRCUIT BREAKER: rolling hourly loss exceeded limit', {
        hourlyLoss: hourlyLoss.toFixed(2),
        limit: MAX_LOSS_PER_HOUR_USDC,
      });
      break;
    }

    const wts = nextWindowTs();
    const slug = slugFor(wts);

    logger.info('Main: discovering next market', {
      slug,
      opensIn: `${Math.round(msUntil(wts) / 1000)}s`,
    });

    let market;
    try {
      const fetchDelay = msUntil(wts) - 30_000;
      if (fetchDelay > 0) {
        logger.debug('Main: waiting before market fetch', { waitSec: Math.round(fetchDelay / 1000) });
        await sleep(fetchDelay);
        if (stopping) break;
      }
      market = await fetchMarketWithRetry(slug, 30, 3_000);
    } catch (err) {
      logger.error('Main: failed to discover market, skipping window', { slug, err: err.message });
      const skipMs = msUntil(wts + MARKET_WINDOW_SECONDS);
      if (skipMs > 0) await sleep(skipMs);
      continue;
    }

    if (stopping) break;

    const trader = new Trader(market, wallet, pnl);
    const task = trader.run()
      .then(() => {
        runningTasks.delete(task);
        pnl.printSessionSummary();
      })
      .catch((err) => {
        runningTasks.delete(task);
        logger.error('Main: Trader threw', { slug, err: err.message, stack: err.stack });
      });
    runningTasks.add(task);

    const nextLoopTs = wts + MARKET_WINDOW_SECONDS;
    const nextLoopMs = msUntil(nextLoopTs);
    if (nextLoopMs > 0) {
      logger.debug('Main: waiting for next window boundary', { waitSec: Math.round(nextLoopMs / 1000) });
      await sleep(nextLoopMs);
    }
  }

  logger.info('Main: waiting for in-flight tasks to complete...', { count: runningTasks.size });
  await Promise.allSettled([...runningTasks]);
  pnl.printSessionSummary();
  logger.info('Bot stopped.');
  process.exit(0);
}

main().catch((err) => {
  logger.error('Fatal error in main()', { err: err.message, stack: err.stack });
  process.exit(1);
});
