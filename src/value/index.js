import 'dotenv/config';
import { fileURLToPath } from 'url';
import {
  API_KEY,
  API_PASSPHRASE,
  API_SECRET,
} from '../config.js';
import logger from '../logger.js';
import { ClobClient } from '../clob.js';
import { ensureApprovals, getSigner } from '../onchain.js';
import { fetchActiveValueMarkets } from './marketScanner.js';
import {
  VALUE_DASHBOARD_ENABLED,
  VALUE_DASHBOARD_HOST,
  VALUE_DASHBOARD_PORT,
  VALUE_DRY_RUN,
  VALUE_DURATIONS,
  VALUE_ENTRY_MAX_PRICE,
  VALUE_ENTRY_MIN_PRICE,
  VALUE_FIRST_LEG_CUTOFF_SECONDS,
  VALUE_LEG_USDC,
  VALUE_MARKET_REFRESH_MS,
  VALUE_MAX_OPEN_MARKETS,
  VALUE_MAX_SLIPPAGE,
  VALUE_MAX_STRANDED_LEGS,
  VALUE_ORDER_MODE,
  VALUE_POLL_MS,
  VALUE_SECOND_LEG_CUTOFF_SECONDS,
  VALUE_SYMBOLS,
  VALUE_TARGET_SHARES,
} from './config.js';
import { ValueDashboardServer } from './dashboard.js';
import { ValueStrategyEngine } from './engine.js';

export async function main() {
  const wallet = getSigner();
  const startedAt = Date.now();

  logger.info('value.main: starting value polling strategy', {
    wallet: wallet.address,
    dryRun: VALUE_DRY_RUN,
    symbols: VALUE_SYMBOLS,
    durations: VALUE_DURATIONS,
    pollMs: VALUE_POLL_MS,
    marketRefreshMs: VALUE_MARKET_REFRESH_MS,
    entryBand: [VALUE_ENTRY_MIN_PRICE, VALUE_ENTRY_MAX_PRICE],
    maxSlippage: VALUE_MAX_SLIPPAGE,
    orderMode: VALUE_ORDER_MODE,
    legUsdc: VALUE_LEG_USDC,
    targetShares: VALUE_TARGET_SHARES,
  });

  const dashboard = VALUE_DASHBOARD_ENABLED
    ? new ValueDashboardServer({
      host: VALUE_DASHBOARD_HOST,
      port: VALUE_DASHBOARD_PORT,
      runtime: {
        mode: 'value',
        wallet: wallet.address,
        dryRun: VALUE_DRY_RUN,
        startedAt,
      },
      config: {
        symbols: VALUE_SYMBOLS,
        durations: VALUE_DURATIONS,
        pollMs: VALUE_POLL_MS,
        marketRefreshMs: VALUE_MARKET_REFRESH_MS,
        entryBand: [VALUE_ENTRY_MIN_PRICE, VALUE_ENTRY_MAX_PRICE],
        maxSlippage: VALUE_MAX_SLIPPAGE,
        orderMode: VALUE_ORDER_MODE,
        legUsdc: VALUE_LEG_USDC,
        targetShares: VALUE_TARGET_SHARES,
        firstLegCutoffSeconds: VALUE_FIRST_LEG_CUTOFF_SECONDS,
        secondLegCutoffSeconds: VALUE_SECOND_LEG_CUTOFF_SECONDS,
        maxOpenMarkets: VALUE_MAX_OPEN_MARKETS,
        maxStrandedLegs: VALUE_MAX_STRANDED_LEGS,
      },
    })
    : null;

  if (dashboard) {
    const url = await dashboard.start();
    logger.info('value.main: dashboard available', { url });
  }

  if (!VALUE_DRY_RUN) {
    await ensureApprovals();
  } else {
    logger.info('value.main: dry run enabled - skipping approvals and order submission');
  }

  await ClobClient.init(wallet, {
    apiKey: API_KEY,
    secret: API_SECRET,
    passphrase: API_PASSPHRASE,
  });

  const engine = new ValueStrategyEngine(wallet);
  engine.on('markets-updated', (markets) => {
    dashboard?.setMarkets(markets);
    dashboard?.setStats(engine.stats());
  });
  engine.on('action', (action) => {
    dashboard?.recordAction(action);
    dashboard?.setStats(engine.stats());
  });

  let stopping = false;
  let refreshTimer = null;
  let pollTimer = null;

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`value.main: ${signal} received, shutting down`);
    clearInterval(refreshTimer);
    clearTimeout(pollTimer);
    dashboard?.stop();
    setTimeout(() => process.exit(0), 1_000).unref?.();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  const refreshMarkets = async () => {
    const markets = await fetchActiveValueMarkets({
      symbols: VALUE_SYMBOLS,
      durations: VALUE_DURATIONS,
    });
    engine.syncMarkets(markets);
    dashboard?.setStats(engine.stats());
  };

  const pollLoop = async () => {
    if (stopping) return;
    try {
      await engine.pollOnce();
      dashboard?.setStats(engine.stats());
    } catch (err) {
      logger.warn('value.main: poll loop error', {
        err: err.message,
      });
    } finally {
      if (!stopping) {
        pollTimer = setTimeout(() => {
          void pollLoop();
        }, VALUE_POLL_MS);
        pollTimer.unref?.();
      }
    }
  };

  await refreshMarkets();
  dashboard?.setMarkets(engine.snapshotMarkets());
  dashboard?.setStats(engine.stats());

  refreshTimer = setInterval(() => {
    void refreshMarkets().catch((err) => {
      logger.warn('value.main: market refresh failed', { err: err.message });
    });
  }, VALUE_MARKET_REFRESH_MS);
  refreshTimer.unref?.();

  await pollLoop();
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    logger.error('value.main: fatal error', { err: err.message, stack: err.stack });
    process.exit(1);
  });
}
