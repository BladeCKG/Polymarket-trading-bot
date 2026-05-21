/**
 * copy/index.js
 * Entry point for the BUY-only copy trading bot.
 *
 * Run:  node src/copy/index.js
 *
 * Startup sequence:
 *   1. Load wallet & CLOB credentials (shared with the arb bot).
 *   2. Ensure on-chain USDC approvals (one-time per wallet).
 *   3. Start the configured trade feed (REST poller or direct chain logs).
 *   4. Wire every 'trade' event into CopyTrader.onTrade (non-blocking).
 *   5. Print stats every 60s; graceful SIGINT/SIGTERM shutdown.
 */
import 'dotenv/config';
import { fileURLToPath } from 'url';
import {
  API_KEY,
  API_SECRET,
  API_PASSPHRASE,
} from '../config.js';
import logger from '../logger.js';
import { ClobClient } from '../clob.js';
import { getSigner, ensureApprovals } from '../onchain.js';
import { CopyTrader } from './copyTrader.js';
import { DryRunPnlTracker } from './dryRunPnl.js';
import { CopyDashboardServer } from './dashboard.js';
import { createCopyFeed } from './feedFactory.js';
import {
  COPY_TARGETS,
  COPY_FEED_MODE,
  COPY_POLL_MS,
  COPY_DRY_RUN,
  COPY_SIZE_MODE,
  COPY_FIXED_USDC,
  COPY_RATIO,
  COPY_MAX_USDC_PER_TRADE,
  COPY_MAX_USDC_PER_MARKET,
  COPY_MAX_USDC_PER_HOUR,
  COPY_MAX_USDC_TOTAL,
  COPY_MAX_SLIPPAGE,
  COPY_MAX_PRICE,
  COPY_MIN_PRICE,
  COPY_STALE_MS,
  COPY_DASHBOARD_ENABLED,
  COPY_DASHBOARD_HOST,
  COPY_DASHBOARD_PORT,
} from './config.js';

export async function main() {
  const wallet = getSigner();
  const startedAt = Date.now();

  logger.info('copy.main: starting BUY-only copy trader', {
    wallet: wallet.address,
    dryRun: COPY_DRY_RUN,
    targets: COPY_TARGETS,
    feedMode: COPY_FEED_MODE,
    pollMs: COPY_POLL_MS,
    sizing: COPY_SIZE_MODE,
    fixedUsdc: COPY_FIXED_USDC,
    ratio: COPY_RATIO,
    caps: {
      perTrade: COPY_MAX_USDC_PER_TRADE,
      perMarket: COPY_MAX_USDC_PER_MARKET,
      perHour: COPY_MAX_USDC_PER_HOUR,
      total: COPY_MAX_USDC_TOTAL,
    },
    filters: {
      priceRange: [COPY_MIN_PRICE, COPY_MAX_PRICE],
      slippage: COPY_MAX_SLIPPAGE,
      staleMs: COPY_STALE_MS,
    },
  });

  const dashboard = COPY_DASHBOARD_ENABLED
    ? new CopyDashboardServer({
      host: COPY_DASHBOARD_HOST,
      port: COPY_DASHBOARD_PORT,
      runtime: {
        mode: 'copy',
        wallet: wallet.address,
        dryRun: COPY_DRY_RUN,
        startedAt,
      },
      config: {
        targets: COPY_TARGETS,
        feedMode: COPY_FEED_MODE,
        pollMs: COPY_POLL_MS,
        sizing: COPY_SIZE_MODE,
        fixedUsdc: COPY_FIXED_USDC,
        ratio: COPY_RATIO,
        caps: {
          perTrade: COPY_MAX_USDC_PER_TRADE,
          perMarket: COPY_MAX_USDC_PER_MARKET,
          perHour: COPY_MAX_USDC_PER_HOUR,
          total: COPY_MAX_USDC_TOTAL,
        },
        filters: {
          priceRange: [COPY_MIN_PRICE, COPY_MAX_PRICE],
          slippage: COPY_MAX_SLIPPAGE,
          staleMs: COPY_STALE_MS,
        },
      },
    })
    : null;

  if (dashboard) {
    const url = await dashboard.start();
    logger.info('copy.main: dashboard available', { url });
  }

  // ── Approvals (skip in dry-run to avoid gas) ────────────────────────────
  if (!COPY_DRY_RUN) {
    await ensureApprovals();
  } else {
    logger.info('copy.main: DRY RUN — skipping approvals and order submission');
  }

  // ── CLOB credentials ─────────────────────────────────────────────────────
  await ClobClient.init(wallet, {
    apiKey: API_KEY,
    secret: API_SECRET,
    passphrase: API_PASSPHRASE,
  });

  // ── Wire up feed → trader ────────────────────────────────────────────────
  const trader = new CopyTrader(wallet);
  const feed = createCopyFeed({
    mode: COPY_FEED_MODE,
    targets: COPY_TARGETS,
    pollMs: COPY_POLL_MS,
  });
  const dryRunPnl = COPY_DRY_RUN ? new DryRunPnlTracker() : null;

  if (dryRunPnl) {
    trader.on('copy', (payload) => {
      if (!payload?.dryRun) return;
      dryRunPnl.recordSimulatedCopy(payload);
    });
    dryRunPnl.on('recorded', (payload) => {
      dashboard?.recordDryRunRecorded(payload);
      dashboard?.setDryRunSnapshot(dryRunPnl.snapshot());
      dashboard?.setStats({
        ...trader.stats(),
        ...dryRunPnl.stats(),
      });
    });
    dryRunPnl.on('settled', (payload) => {
      dashboard?.recordDryRunSettled(payload);
      dashboard?.setDryRunSnapshot(dryRunPnl.snapshot());
      dashboard?.setStats({
        ...trader.stats(),
        ...dryRunPnl.stats(),
      });
    });
    dashboard?.setDryRunSnapshot(dryRunPnl.snapshot());
  }

  trader.on('copy', (payload) => {
    dashboard?.recordCopy({
      slug: payload.ev?.slug ?? null,
      conditionId: payload.ev?.conditionId ?? null,
      outcome: payload.ev?.outcome ?? null,
      targetPrice: payload.ev?.price ?? null,
      shares: payload.shares,
      maxPrice: payload.maxPrice,
      assumedSpent: payload.assumedSpent ?? null,
      dryRun: Boolean(payload.dryRun),
      timestamp: Date.now(),
    });
  });

  trader.on('skip', (payload) => {
    dashboard?.recordSkip({
      slug: payload.ev?.slug ?? null,
      conditionId: payload.ev?.conditionId ?? null,
      outcome: payload.ev?.outcome ?? null,
      reason: payload.reason,
      phase: payload.phase ?? null,
      price: payload.ev?.price ?? null,
      usdc: payload.ev?.usdc ?? null,
      timestamp: Date.now(),
    });
  });

  trader.on('copy-failed', ({ ev, err }) => {
    dashboard?.recordFailure({
      slug: ev?.slug ?? null,
      tokenId: ev?.tokenId ?? null,
      outcome: ev?.outcome ?? null,
      error: err?.message ?? String(err),
      timestamp: Date.now(),
    });
  });

  feed.on('trade', (ev) => {
    dashboard?.recordTrade({
      source: ev.source ?? COPY_FEED_MODE.toLowerCase(),
      target: ev.target,
      slug: ev.slug,
      conditionId: ev.conditionId,
      outcome: ev.outcome,
      price: ev.price,
      size: ev.size,
      usdc: ev.usdc?.toFixed?.(2) ?? ev.usdc,
      txHash: ev.txHash,
      seenAt: Date.now(),
    });

    // Fire-and-forget so the poller never blocks on an order round-trip.
    trader.onTrade(ev).catch((err) => {
      logger.error('copy.main: unexpected error in onTrade', { err: err.message, stack: err.stack });
    });
  });

  await feed.start();

  // ── Periodic stats ──────────────────────────────────────────────────────
  const statsTimer = setInterval(() => {
    const stats = {
      ...trader.stats(),
      ...(dryRunPnl ? dryRunPnl.stats() : {}),
    };
    logger.info('copy.main: stats', stats);
    dashboard?.setStats(stats);
  }, 60_000);

  dashboard?.setStats({
    ...trader.stats(),
    ...(dryRunPnl ? dryRunPnl.stats() : {}),
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = (sig) => {
    logger.info(`copy.main: ${sig} received, shutting down…`, {
      ...trader.stats(),
      ...(dryRunPnl ? dryRunPnl.stats() : {}),
    });
    clearInterval(statsTimer);
    feed.stop();
    dryRunPnl?.printSummary();
    dashboard?.stop();
    // Give any in-flight order a moment to flush.
    setTimeout(() => process.exit(0), 1_000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('copy.main: running — Ctrl+C to stop');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((err) => {
    logger.error('copy.main: fatal error', { err: err.message, stack: err.stack });
    process.exit(1);
  });
}
