import 'dotenv/config';
import { fileURLToPath } from 'url';
import {
  API_KEY,
  API_PASSPHRASE,
  API_SECRET,
} from '../config.js';
import logger from '../logger.js';
import { ClobClient, FillFeed } from '../clob.js';
import { ensureApprovals, getSigner } from '../onchain.js';
import { fetchActiveValueMarkets } from './marketScanner.js';
import {
  VALUE_DASHBOARD_ENABLED,
  VALUE_DASHBOARD_HOST,
  VALUE_DASHBOARD_PORT,
  VALUE_DRY_RUN,
  VALUE_DURATIONS,
  VALUE_ABSOLUTE_FIRST_LEG_MAX_PRICE,
  VALUE_ENDGAME_EXIT_BELOW_PRICE,
  VALUE_FIRST_LEG_MIN_PRICE,
  VALUE_EXTENDED_HOLD_MAX_MS_15M,
  VALUE_EXTENDED_HOLD_MAX_MS_5M,
  VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_15M,
  VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_5M,
  VALUE_IMMEDIATE_EXIT_BELOW_PRICE,
  VALUE_CONTINUE_MIN_PROFIT_PER_SHARE,
  VALUE_DIRECT_TAKE_PROFIT_PER_SHARE,
  VALUE_FIRST_LEG_CUTOFF_SECONDS,
  VALUE_LEG_USDC,
  VALUE_MAX_BOOK_AGE_MS,
  VALUE_MAX_ONE_LEG_HOLD_MS_15M,
  VALUE_MAX_ONE_LEG_HOLD_MS_5M,
  VALUE_MARKET_REFRESH_MS,
  VALUE_MAX_SPREAD,
  VALUE_MAX_OPEN_MARKETS,
  VALUE_MAX_SLIPPAGE,
  VALUE_MAX_STRANDED_LEGS,
  VALUE_MAX_UNPAIRED_LOSS_PER_SHARE,
  VALUE_MERGE_ON_SECOND_LEG,
  VALUE_NO_UNPAIRED_HOLD_LAST_MS_15M,
  VALUE_NO_UNPAIRED_HOLD_LAST_MS_5M,
  VALUE_OPPOSITE_GAP_TO_TARGET_MAX,
  VALUE_OPPOSITE_MAX_PRICE,
  VALUE_ORDER_MODE,
  VALUE_OPEN_WAIT_SECONDS,
  VALUE_POLL_MS,
  VALUE_REQUIRED_DEPTH_MULTIPLIER,
  VALUE_SECOND_LEG_CUTOFF_SECONDS,
  VALUE_SECOND_LEG_EXTREME_SPREAD,
  VALUE_SECOND_LEG_HARD_MAX_PRICE,
  VALUE_SECOND_LEG_MIN_LOCK_PROFIT_EARLY_PER_SHARE,
  VALUE_SECOND_LEG_MIN_LOCK_PROFIT_LATE_PER_SHARE,
  VALUE_SECOND_LEG_MIN_LOCK_PROFIT_MID_PER_SHARE,
  VALUE_SECOND_LEG_MAX_SPREAD,
  VALUE_SECOND_LEG_MIN_DEPTH_MULTIPLIER,
  VALUE_SECOND_LEG_MIN_LOCK_PROFIT_PER_SHARE,
  VALUE_SYMBOLS,
  VALUE_STABLE_SNAPSHOTS_REQUIRED,
  VALUE_TARGET_PRICE,
  VALUE_TARGET_SHARES,
  VALUE_TRAILING_DRAWDOWN_PER_SHARE_15M,
  VALUE_TRAILING_DRAWDOWN_PER_SHARE_5M,
  VALUE_EXTREME_SPREAD,
} from './config.js';
import { ValueDashboardServer } from './dashboard.js';
import { ValueStrategyEngine } from './engine.js';
import { ValueTraceFile } from './traceFile.js';

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
    targetPrice: VALUE_TARGET_PRICE,
    absoluteFirstLegMaxPrice: VALUE_ABSOLUTE_FIRST_LEG_MAX_PRICE,
    firstLegMinPrice: VALUE_FIRST_LEG_MIN_PRICE,
    oppositeMaxPrice: VALUE_OPPOSITE_MAX_PRICE,
    oppositeGapToTargetMax: VALUE_OPPOSITE_GAP_TO_TARGET_MAX,
    maxSlippage: VALUE_MAX_SLIPPAGE,
    orderMode: VALUE_ORDER_MODE,
    legUsdc: VALUE_LEG_USDC,
    targetShares: VALUE_TARGET_SHARES,
    openWaitSeconds: VALUE_OPEN_WAIT_SECONDS,
    stableSnapshotsRequired: VALUE_STABLE_SNAPSHOTS_REQUIRED,
    maxSpread: VALUE_MAX_SPREAD,
    extremeSpread: VALUE_EXTREME_SPREAD,
    requiredDepthMultiplier: VALUE_REQUIRED_DEPTH_MULTIPLIER,
    secondLegMinLockProfitPerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_PER_SHARE,
    secondLegMinLockProfitEarlyPerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_EARLY_PER_SHARE,
    secondLegMinLockProfitMidPerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_MID_PER_SHARE,
    secondLegMinLockProfitLatePerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_LATE_PER_SHARE,
    secondLegHardMaxPrice: VALUE_SECOND_LEG_HARD_MAX_PRICE,
    secondLegMaxSpread: VALUE_SECOND_LEG_MAX_SPREAD,
    secondLegExtremeSpread: VALUE_SECOND_LEG_EXTREME_SPREAD,
    secondLegMinDepthMultiplier: VALUE_SECOND_LEG_MIN_DEPTH_MULTIPLIER,
    maxOneLegHoldMs5m: VALUE_MAX_ONE_LEG_HOLD_MS_5M,
    maxOneLegHoldMs15m: VALUE_MAX_ONE_LEG_HOLD_MS_15M,
    extendedHoldMaxMs5m: VALUE_EXTENDED_HOLD_MAX_MS_5M,
    extendedHoldMaxMs15m: VALUE_EXTENDED_HOLD_MAX_MS_15M,
    finalExitBeforeExpiryMs5m: VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_5M,
    finalExitBeforeExpiryMs15m: VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_15M,
    continueMinProfitPerShare: VALUE_CONTINUE_MIN_PROFIT_PER_SHARE,
    directTakeProfitPerShare: VALUE_DIRECT_TAKE_PROFIT_PER_SHARE,
    trailingDrawdownPerShare5m: VALUE_TRAILING_DRAWDOWN_PER_SHARE_5M,
    trailingDrawdownPerShare15m: VALUE_TRAILING_DRAWDOWN_PER_SHARE_15M,
    noUnpairedHoldLastMs5m: VALUE_NO_UNPAIRED_HOLD_LAST_MS_5M,
    noUnpairedHoldLastMs15m: VALUE_NO_UNPAIRED_HOLD_LAST_MS_15M,
    maxBookAgeMs: VALUE_MAX_BOOK_AGE_MS,
    maxUnpairedLossPerShare: VALUE_MAX_UNPAIRED_LOSS_PER_SHARE,
    mergeOnSecondLeg: VALUE_MERGE_ON_SECOND_LEG,
    immediateExitBelowPrice: VALUE_IMMEDIATE_EXIT_BELOW_PRICE,
    endgameExitBelowPrice: VALUE_ENDGAME_EXIT_BELOW_PRICE,
  });

  const traceFile = new ValueTraceFile();
  const tracePath = traceFile.start();
  traceFile.write('startup', {
    wallet: wallet.address,
    dryRun: VALUE_DRY_RUN,
    symbols: VALUE_SYMBOLS,
    durations: VALUE_DURATIONS,
    pollMs: VALUE_POLL_MS,
    marketRefreshMs: VALUE_MARKET_REFRESH_MS,
    targetPrice: VALUE_TARGET_PRICE,
    absoluteFirstLegMaxPrice: VALUE_ABSOLUTE_FIRST_LEG_MAX_PRICE,
    firstLegMinPrice: VALUE_FIRST_LEG_MIN_PRICE,
    oppositeMaxPrice: VALUE_OPPOSITE_MAX_PRICE,
    oppositeGapToTargetMax: VALUE_OPPOSITE_GAP_TO_TARGET_MAX,
    maxSlippage: VALUE_MAX_SLIPPAGE,
    orderMode: VALUE_ORDER_MODE,
    legUsdc: VALUE_LEG_USDC,
    targetShares: VALUE_TARGET_SHARES,
    openWaitSeconds: VALUE_OPEN_WAIT_SECONDS,
    stableSnapshotsRequired: VALUE_STABLE_SNAPSHOTS_REQUIRED,
    maxSpread: VALUE_MAX_SPREAD,
    extremeSpread: VALUE_EXTREME_SPREAD,
    requiredDepthMultiplier: VALUE_REQUIRED_DEPTH_MULTIPLIER,
    secondLegMinLockProfitPerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_PER_SHARE,
    secondLegMinLockProfitEarlyPerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_EARLY_PER_SHARE,
    secondLegMinLockProfitMidPerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_MID_PER_SHARE,
    secondLegMinLockProfitLatePerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_LATE_PER_SHARE,
    secondLegHardMaxPrice: VALUE_SECOND_LEG_HARD_MAX_PRICE,
    secondLegMaxSpread: VALUE_SECOND_LEG_MAX_SPREAD,
    secondLegExtremeSpread: VALUE_SECOND_LEG_EXTREME_SPREAD,
    secondLegMinDepthMultiplier: VALUE_SECOND_LEG_MIN_DEPTH_MULTIPLIER,
    maxOneLegHoldMs5m: VALUE_MAX_ONE_LEG_HOLD_MS_5M,
    maxOneLegHoldMs15m: VALUE_MAX_ONE_LEG_HOLD_MS_15M,
    extendedHoldMaxMs5m: VALUE_EXTENDED_HOLD_MAX_MS_5M,
    extendedHoldMaxMs15m: VALUE_EXTENDED_HOLD_MAX_MS_15M,
    finalExitBeforeExpiryMs5m: VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_5M,
    finalExitBeforeExpiryMs15m: VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_15M,
    continueMinProfitPerShare: VALUE_CONTINUE_MIN_PROFIT_PER_SHARE,
    directTakeProfitPerShare: VALUE_DIRECT_TAKE_PROFIT_PER_SHARE,
    trailingDrawdownPerShare5m: VALUE_TRAILING_DRAWDOWN_PER_SHARE_5M,
    trailingDrawdownPerShare15m: VALUE_TRAILING_DRAWDOWN_PER_SHARE_15M,
    noUnpairedHoldLastMs5m: VALUE_NO_UNPAIRED_HOLD_LAST_MS_5M,
    noUnpairedHoldLastMs15m: VALUE_NO_UNPAIRED_HOLD_LAST_MS_15M,
    maxBookAgeMs: VALUE_MAX_BOOK_AGE_MS,
    maxUnpairedLossPerShare: VALUE_MAX_UNPAIRED_LOSS_PER_SHARE,
    mergeOnSecondLeg: VALUE_MERGE_ON_SECOND_LEG,
    immediateExitBelowPrice: VALUE_IMMEDIATE_EXIT_BELOW_PRICE,
    endgameExitBelowPrice: VALUE_ENDGAME_EXIT_BELOW_PRICE,
  });
  logger.info('value.main: trace file enabled', { path: tracePath });

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
        targetPrice: VALUE_TARGET_PRICE,
        absoluteFirstLegMaxPrice: VALUE_ABSOLUTE_FIRST_LEG_MAX_PRICE,
        firstLegMinPrice: VALUE_FIRST_LEG_MIN_PRICE,
        oppositeMaxPrice: VALUE_OPPOSITE_MAX_PRICE,
        oppositeGapToTargetMax: VALUE_OPPOSITE_GAP_TO_TARGET_MAX,
        maxSlippage: VALUE_MAX_SLIPPAGE,
        orderMode: VALUE_ORDER_MODE,
        legUsdc: VALUE_LEG_USDC,
        targetShares: VALUE_TARGET_SHARES,
        openWaitSeconds: VALUE_OPEN_WAIT_SECONDS,
        stableSnapshotsRequired: VALUE_STABLE_SNAPSHOTS_REQUIRED,
        maxSpread: VALUE_MAX_SPREAD,
        extremeSpread: VALUE_EXTREME_SPREAD,
        requiredDepthMultiplier: VALUE_REQUIRED_DEPTH_MULTIPLIER,
        secondLegMinLockProfitPerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_PER_SHARE,
        secondLegMinLockProfitEarlyPerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_EARLY_PER_SHARE,
        secondLegMinLockProfitMidPerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_MID_PER_SHARE,
        secondLegMinLockProfitLatePerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_LATE_PER_SHARE,
        secondLegHardMaxPrice: VALUE_SECOND_LEG_HARD_MAX_PRICE,
        secondLegMaxSpread: VALUE_SECOND_LEG_MAX_SPREAD,
        secondLegExtremeSpread: VALUE_SECOND_LEG_EXTREME_SPREAD,
        secondLegMinDepthMultiplier: VALUE_SECOND_LEG_MIN_DEPTH_MULTIPLIER,
        maxOneLegHoldMs5m: VALUE_MAX_ONE_LEG_HOLD_MS_5M,
        maxOneLegHoldMs15m: VALUE_MAX_ONE_LEG_HOLD_MS_15M,
        extendedHoldMaxMs5m: VALUE_EXTENDED_HOLD_MAX_MS_5M,
        extendedHoldMaxMs15m: VALUE_EXTENDED_HOLD_MAX_MS_15M,
        finalExitBeforeExpiryMs5m: VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_5M,
        finalExitBeforeExpiryMs15m: VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_15M,
        continueMinProfitPerShare: VALUE_CONTINUE_MIN_PROFIT_PER_SHARE,
        directTakeProfitPerShare: VALUE_DIRECT_TAKE_PROFIT_PER_SHARE,
        trailingDrawdownPerShare5m: VALUE_TRAILING_DRAWDOWN_PER_SHARE_5M,
        trailingDrawdownPerShare15m: VALUE_TRAILING_DRAWDOWN_PER_SHARE_15M,
        noUnpairedHoldLastMs5m: VALUE_NO_UNPAIRED_HOLD_LAST_MS_5M,
        noUnpairedHoldLastMs15m: VALUE_NO_UNPAIRED_HOLD_LAST_MS_15M,
        maxBookAgeMs: VALUE_MAX_BOOK_AGE_MS,
        maxUnpairedLossPerShare: VALUE_MAX_UNPAIRED_LOSS_PER_SHARE,
        mergeOnSecondLeg: VALUE_MERGE_ON_SECOND_LEG,
        firstLegCutoffSeconds: VALUE_FIRST_LEG_CUTOFF_SECONDS,
        secondLegCutoffSeconds: VALUE_SECOND_LEG_CUTOFF_SECONDS,
        immediateExitBelowPrice: VALUE_IMMEDIATE_EXIT_BELOW_PRICE,
        endgameExitBelowPrice: VALUE_ENDGAME_EXIT_BELOW_PRICE,
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
  const fillFeed = !VALUE_DRY_RUN ? new FillFeed() : null;
  engine.on('markets-updated', (markets) => {
    dashboard?.setMarkets(markets);
    dashboard?.setStats(engine.stats());
  });
  engine.on('action', (action) => {
    dashboard?.recordAction(action);
    dashboard?.setStats(engine.stats());
    traceFile.write('action', {
      action,
      stats: engine.stats(),
    });
    traceFile.writeMarket(action.slug, 'action', {
      action,
      stats: engine.stats(),
    });
  });
  engine.on('quote', (quote) => {
    traceFile.writeMarket(quote.slug, 'quote', quote);
  });
  engine.on('decision', (decision) => {
    traceFile.writeMarket(decision.slug, 'decision', decision);
  });

  let stopping = false;
  let refreshTimer = null;
  let pollTimer = null;

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`value.main: ${signal} received, shutting down`);
    traceFile.write('shutdown', {
      signal,
      stats: engine.stats(),
      markets: engine.snapshotMarkets(),
    });
    clearInterval(refreshTimer);
    clearTimeout(pollTimer);
    fillFeed?.stop();
    dashboard?.stop();
    traceFile.stop();
    setTimeout(() => process.exit(0), 1_000).unref?.();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  const refreshMarkets = async () => {
    const markets = await fetchActiveValueMarkets({
      symbols: VALUE_SYMBOLS,
      durations: VALUE_DURATIONS,
    });
    logger.info('value.main: markets refreshed', {
      count: markets.length,
      slugs: markets.slice(0, 12).map((market) => market.slug),
    });
    traceFile.write('markets-refreshed', {
      count: markets.length,
      slugs: markets.map((market) => market.slug),
    });
    engine.syncMarkets(markets);
    dashboard?.setStats(engine.stats());
  };

  const pollLoop = async () => {
    if (stopping) return;
    const cycleStartedAt = Date.now();
    try {
      await engine.pollOnce();
      dashboard?.setStats(engine.stats());
    } catch (err) {
      logger.warn('value.main: poll loop error', {
        err: err.message,
      });
      traceFile.write('poll-error', {
        err: err.message,
      });
    } finally {
      if (!stopping) {
        const elapsedMs = Date.now() - cycleStartedAt;
        const delayMs = Math.max(0, VALUE_POLL_MS - elapsedMs);
        pollTimer = setTimeout(() => {
          void pollLoop();
        }, delayMs);
        pollTimer.unref?.();
      }
    }
  };

  await refreshMarkets();
  dashboard?.setMarkets(engine.snapshotMarkets());
  dashboard?.setStats(engine.stats());

  if (fillFeed) {
    fillFeed.on('fill', (fill) => {
      void engine.handleFill(fill).catch((err) => {
        logger.warn('value.main: fill handling failed', { err: err.message });
      });
    });
    fillFeed.start();
  }

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
