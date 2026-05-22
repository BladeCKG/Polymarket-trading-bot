/**
 * copy/copyTrader.js
 * Execution engine for the BUY-only copy trader.
 *
 * On every ActivityFeed 'trade' event:
 *   1. Filter (price band, slippage, staleness, spend caps, allow/block lists).
 *   2. Compute our size (MIRROR / FIXED / RATIO), capped by every configured limit.
 *   3. Fire a FAK BUY via ClobClient.postIOCBuy at maxPrice = target.price + slippage.
 *   4. Record spend and emit a 'copy' event for observability.
 *
 * No REST/WS calls happen in the hot path beyond the single order POST.
 */
import { EventEmitter } from 'events';
import { ClobClient } from '../clob.js';
import logger from '../logger.js';
import {
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
  COPY_DRY_RUN,
  COPY_ALLOWED_CONDITIONS,
  COPY_BLOCKED_CONDITIONS,
} from './config.js';

const HOUR_MS = 60 * 60 * 1000;

export class CopyTrader extends EventEmitter {
  /**
   * @param {ethers.Wallet} wallet
   */
  constructor(wallet) {
    super();
    this.wallet       = wallet;

    // Spend tracking (USDC, human units).
    this.totalSpent   = 0;
    this.spentByMarket = new Map();  // conditionId → usdc
    this.estimatedFeesTotal = 0;
    this.estimatedFeesByMarket = new Map(); // conditionId → estimated fee usdc
    this.hourlySpends  = [];         // [{ ts, usdc }, …] pruned on query

    // Stats
    this.copyCount    = 0;
    this.skipCount    = 0;
    this.failCount    = 0;
  }

  /** Handle a normalized trade event from ActivityFeed. */
  async onTrade(ev) {
    const skipHypothetical = this._skipHypothetical(ev);
    const decisionBase = this._decisionSnapshot(ev);
    // ── Pre-flight filters (O(1), no I/O) ──────────────────────────────────
    const reason = this._rejectReason(ev);
    if (reason) {
      this.skipCount++;
      const details = { ...decisionBase, reason, phase: 'filter', hypothetical: skipHypothetical };
      this.emit('skip', { reason, ev, phase: 'filter', hypothetical: skipHypothetical, details });
      logger.info('copy.CopyTrader: skipped trade', details);
      return;
    }

    // ── Compute our size ──────────────────────────────────────────────────
    const ourUsdc = this._ourUsdc(ev);
    if (!ourUsdc || ourUsdc < 1) {
      this.skipCount++;
      const details = { ...decisionBase, reason: 'computed-size-too-small', phase: 'size', ourUsdc, hypothetical: skipHypothetical };
      this.emit('skip', { reason: 'computed-size-too-small', ev, ourUsdc, phase: 'size', hypothetical: skipHypothetical, details });
      logger.info('copy.CopyTrader: skipped trade', details);
      return;
    }

    // ── Max price we'll pay (target's fill + slippage, capped at COPY_MAX_PRICE) ──
    const maxPrice = Math.min(
      COPY_MAX_PRICE,
      Number((ev.price + COPY_MAX_SLIPPAGE).toFixed(4)),
    );
    // Size in shares at maxPrice (guarantees we never exceed ourUsdc in USDC).
    const shares = Math.max(1, Math.floor(ourUsdc / maxPrice));
    const assumedSpent = shares * maxPrice;
    let executionEstimate = null;
    try {
      executionEstimate = await ClobClient.estimateMarketBuyFill(ev.tokenId, maxPrice, ourUsdc);
    } catch (err) {
      logger.debug('copy.CopyTrader: execution estimate unavailable', {
        tokenId: ev.tokenId,
        err: err.message,
      });
    }
    const simulatedShares = Number.isFinite(executionEstimate?.fillShares) && executionEstimate.fillShares > 0
      ? executionEstimate.fillShares
      : shares;
    const simulatedSpent = Number.isFinite(executionEstimate?.spentUsdc) && executionEstimate.spentUsdc > 0
      ? executionEstimate.spentUsdc
      : assumedSpent;
    const simulatedPrice = Number.isFinite(executionEstimate?.avgFillPrice) && executionEstimate.avgFillPrice > 0
      ? executionEstimate.avgFillPrice
      : maxPrice;
    const estimatedFee = Number.isFinite(executionEstimate?.estimatedFeeUsdc)
      ? executionEstimate.estimatedFeeUsdc
      : 0;
    const feeRateBps = Number.isFinite(executionEstimate?.feeRateBps)
      ? executionEstimate.feeRateBps
      : 0;

    const fireAt = Date.now();
    const latencyMs = fireAt - ev.timestamp * 1000;

    logger.info('copy.CopyTrader: copying BUY', {
      ...decisionBase,
      targetPx:   ev.price,
      targetSize: ev.size,
      ourUsdc,
      maxPrice,
      shares,
      assumedSpent,
      simulatedShares,
      simulatedSpent,
      simulatedPrice,
      executionEstimate,
      estimatedFee: estimatedFee.toFixed(5),
      feeRateBps,
      latencyMs,
    });

    if (COPY_DRY_RUN) {
      this._recordEstimatedFee(ev.conditionId, estimatedFee);
      this.copyCount++;
      this.emit('copy', { ev, ourUsdc, shares: simulatedShares, maxPrice, executionPrice: simulatedPrice, dryRun: true, assumedSpent: simulatedSpent, estimatedFee, feeRateBps, executionEstimate, details: {
        ...decisionBase,
        ourUsdc,
        maxPrice,
        shares,
        assumedSpent,
        simulatedShares,
        simulatedSpent,
        simulatedPrice,
        executionEstimate,
        estimatedFee,
        feeRateBps,
        dryRun: true,
      } });
      return;
    }

    // ── Fire the order ─────────────────────────────────────────────────────
    try {
      // postIOCBuy expects a USDC amount, not a share count.
      const res = await ClobClient.postIOCBuy(this.wallet, ev.tokenId, maxPrice, assumedSpent);
      const elapsedMs = Date.now() - fireAt;

      // Assume we filled the full shares at maxPrice for accounting (conservative).
      // If Polymarket returns a `makingAmount` / `takingAmount` we can refine,
      // but for spend-caps overshooting never hurts.
      this._recordSpend(ev.conditionId, assumedSpent);
      this._recordEstimatedFee(ev.conditionId, estimatedFee);
      this.copyCount++;

      logger.info('copy.CopyTrader: order sent', {
        ...decisionBase,
        shares,
        maxPrice,
        ourUsdc,
        assumedSpent,
        estimatedFee,
        feeRateBps,
        orderLatencyMs: elapsedMs,
        signalLatencyMs: fireAt - ev.timestamp * 1000,
        res,
      });
      this.emit('copy', { ev, ourUsdc, shares, maxPrice, res, dryRun: false, assumedSpent, estimatedFee, feeRateBps, details: {
        ...decisionBase,
        ourUsdc,
        maxPrice,
        shares,
        assumedSpent,
        estimatedFee,
        feeRateBps,
        dryRun: false,
        orderLatencyMs: elapsedMs,
        signalLatencyMs: fireAt - ev.timestamp * 1000,
      } });
    } catch (err) {
      this.failCount++;
      logger.warn('copy.CopyTrader: order failed', {
        ...decisionBase,
        maxPrice,
        shares,
        ourUsdc,
        assumedSpent,
        estimatedFee,
        feeRateBps,
        err: err.message,
      });
      this.emit('copy-failed', { ev, err });
    }
  }

  // ── Filters ─────────────────────────────────────────────────────────────

  _rejectReason(ev) {
    if (ev.side !== 'BUY')                          return 'not-a-buy';
    if (ev.ageMs > COPY_STALE_MS)                   return `stale(${ev.ageMs}ms)`;
    if (ev.price < COPY_MIN_PRICE)                  return `price-too-low(${ev.price})`;
    if (ev.price > COPY_MAX_PRICE)                  return `price-too-high(${ev.price})`;

    const cid = (ev.conditionId || '').toLowerCase();
    if (COPY_BLOCKED_CONDITIONS.has(cid))           return 'blocked-condition';
    if (COPY_ALLOWED_CONDITIONS.size > 0 && !COPY_ALLOWED_CONDITIONS.has(cid)) {
      return 'not-in-allow-list';
    }

    if (this.totalSpent >= COPY_MAX_USDC_TOTAL)     return 'total-cap';
    if ((this.spentByMarket.get(cid) ?? 0) >= COPY_MAX_USDC_PER_MARKET) {
      return 'per-market-cap';
    }
    if (this._rollingHourSpent() >= COPY_MAX_USDC_PER_HOUR) return 'hourly-cap';

    return null;
  }

  _ourUsdc(ev) {
    const raw = this._baseUsdc(ev);

    // Apply every cap.
    const perTradeCap = COPY_MAX_USDC_PER_TRADE;
    const remainingPerMarket =
      COPY_MAX_USDC_PER_MARKET - (this.spentByMarket.get(ev.conditionId) ?? 0);
    const remainingHourly   = COPY_MAX_USDC_PER_HOUR - this._rollingHourSpent();
    const remainingTotal    = COPY_MAX_USDC_TOTAL    - this.totalSpent;

    return Math.max(0, Math.min(
      raw,
      perTradeCap,
      remainingPerMarket,
      remainingHourly,
      remainingTotal,
    ));
  }

  _baseUsdc(ev) {
    switch (COPY_SIZE_MODE) {
      case 'MIRROR': return ev.usdc;
      case 'RATIO':  return ev.usdc * COPY_RATIO;
      case 'FIXED':
      default:       return COPY_FIXED_USDC;
    }
  }

  _skipHypothetical(ev) {
    const desiredUsdc = this._baseUsdc(ev);
    const maxPrice = Math.min(
      COPY_MAX_PRICE,
      Number((ev.price + COPY_MAX_SLIPPAGE).toFixed(4)),
    );
    if (!Number.isFinite(desiredUsdc) || desiredUsdc <= 0 || !Number.isFinite(maxPrice) || maxPrice <= 0) {
      return null;
    }
    const shares = Math.max(0, Math.floor(desiredUsdc / maxPrice));
    return {
      desiredUsdc,
      maxPrice,
      shares,
      hypotheticalSpent: shares * maxPrice,
    };
  }

  // ── Spend tracking ──────────────────────────────────────────────────────

  _recordSpend(conditionId, usdc) {
    const cid = (conditionId || '').toLowerCase();
    this.totalSpent += usdc;
    this.spentByMarket.set(cid, (this.spentByMarket.get(cid) ?? 0) + usdc);
    this.hourlySpends.push({ ts: Date.now(), usdc });
  }

  _recordEstimatedFee(conditionId, feeUsdc) {
    const fee = Number(feeUsdc ?? 0);
    if (!Number.isFinite(fee) || fee <= 0) return;
    const cid = (conditionId || '').toLowerCase();
    this.estimatedFeesTotal += fee;
    this.estimatedFeesByMarket.set(cid, (this.estimatedFeesByMarket.get(cid) ?? 0) + fee);
  }

  _rollingHourSpent() {
    const cutoff = Date.now() - HOUR_MS;
    // Prune while-we-look-up (keeps array bounded).
    while (this.hourlySpends.length && this.hourlySpends[0].ts < cutoff) {
      this.hourlySpends.shift();
    }
    return this.hourlySpends.reduce((a, b) => a + b.usdc, 0);
  }

  // ── Stats / helpers ─────────────────────────────────────────────────────

  stats() {
    return {
      copies:   this.copyCount,
      skips:    this.skipCount,
      failures: this.failCount,
      totalSpent:      this.totalSpent.toFixed(2),
      totalEstimatedFees: this.estimatedFeesTotal.toFixed(5),
      rollingHourUsdc: this._rollingHourSpent().toFixed(2),
      markets:         this.spentByMarket.size,
    };
  }

  _evSummary(ev) {
    return {
      target:     ev.target,
      tokenId:    ev.tokenId,
      conditionId: ev.conditionId,
      slug:       ev.slug,
      question:   ev.question,
      outcome:    ev.outcome,
      side:       ev.side,
      price:      ev.price,
      size:       ev.size,
      usdc:       ev.usdc,
      ageMs:      ev.ageMs,
      timestamp:  ev.timestamp,
      txHash:     ev.txHash,
      source:     ev.source ?? null,
      raw:        ev.raw ?? null,
    };
  }

  _decisionSnapshot(ev) {
    const cid = (ev.conditionId || '').toLowerCase();
    const rollingHourSpent = this._rollingHourSpent();
    const marketSpent = this.spentByMarket.get(cid) ?? 0;
    return {
      event: this._evSummary(ev),
      sizingMode: COPY_SIZE_MODE,
      fixedUsdc: COPY_FIXED_USDC,
      ratio: COPY_RATIO,
      filters: {
        minPrice: COPY_MIN_PRICE,
        maxPrice: COPY_MAX_PRICE,
        maxSlippage: COPY_MAX_SLIPPAGE,
        staleMs: COPY_STALE_MS,
      },
      caps: {
        perTrade: COPY_MAX_USDC_PER_TRADE,
        perMarket: COPY_MAX_USDC_PER_MARKET,
        perHour: COPY_MAX_USDC_PER_HOUR,
        total: COPY_MAX_USDC_TOTAL,
      },
      spendState: {
        totalSpent: this.totalSpent,
        rollingHourSpent,
        marketSpent,
        remainingPerMarket: COPY_MAX_USDC_PER_MARKET - marketSpent,
        remainingPerHour: COPY_MAX_USDC_PER_HOUR - rollingHourSpent,
        remainingTotal: COPY_MAX_USDC_TOTAL - this.totalSpent,
      },
    };
  }
}
