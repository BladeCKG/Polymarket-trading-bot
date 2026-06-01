import { BtcPriceFeed } from './btc-price-feed.js';
import { BeatOfiTracker } from './ofi.js';
import { BEAT_LIFECYCLE } from './lifecycle.js';
import { createBeatRuntimeConfig } from './runtime-config.js';
import { BookFeed, ClobClient } from '../clob.js';
import { getTokenBalances, getUsdcBalance, sleep } from '../onchain.js';
import { msUntil, waitForResolution } from '../market.js';
import { getMarketLogFilePath, marketFileLogger, marketLogger } from '../logger.js';

function bestBid(book) {
  return Array.isArray(book?.bids) && book.bids.length
    ? book.bids.reduce((a, b) => (a.price >= b.price ? a : b))
    : null;
}

function bestAsk(book) {
  return Array.isArray(book?.asks) && book.asks.length
    ? book.asks.reduce((a, b) => (a.price <= b.price ? a : b))
    : null;
}

function clampMaxPrice(askPrice, capPrice, maxSlippage) {
  return Math.min(capPrice, askPrice + maxSlippage);
}

function estimateSharesFromBook(book, maxPrice, targetShares) {
  const asks = Array.isArray(book?.asks) ? [...book.asks] : [];
  const eligible = asks
    .filter((row) =>
      Number.isFinite(row.price) &&
      Number.isFinite(row.size) &&
      row.price > 0 &&
      row.size > 0 &&
      row.price <= maxPrice)
    .sort((a, b) => a.price - b.price);

  let remainingShares = Number(targetShares ?? 0);
  let fillShares = 0;
  let spentUsdc = 0;

  for (const ask of eligible) {
    if (remainingShares <= 0) break;
    const takeShares = Math.min(remainingShares, ask.size);
    fillShares += takeShares;
    spentUsdc += takeShares * ask.price;
    remainingShares -= takeShares;
  }

  return {
    fillShares,
    spentUsdc,
    fullyFilled: remainingShares <= 1e-9,
  };
}

function tradeStatusFromLifecycle(lifecycle, hasTrade) {
  if (lifecycle === BEAT_LIFECYCLE.WAITING_SKIP) return BEAT_LIFECYCLE.WAITING_SKIP;
  if (lifecycle === BEAT_LIFECYCLE.MONITORING) return hasTrade ? 'buy placed' : BEAT_LIFECYCLE.MONITORING;
  if (lifecycle === BEAT_LIFECYCLE.RESOLVING) return BEAT_LIFECYCLE.RESOLVING;
  if (lifecycle === BEAT_LIFECYCLE.SETTLED) return hasTrade ? BEAT_LIFECYCLE.SETTLED : 'settled without trade';
  if (lifecycle === BEAT_LIFECYCLE.HALTED) return 'halted';
  return BEAT_LIFECYCLE.UPCOMING;
}

function traderSymbol(market, config) {
  const marketSymbol = String(market?.marketSymbol ?? '').trim().toUpperCase();
  if (marketSymbol) return marketSymbol;
  const symbols = Array.isArray(config?.BEAT_SYMBOLS) ? config.BEAT_SYMBOLS : [];
  return String(symbols[0] ?? 'BTC').trim().toUpperCase();
}

function momentsForConfig(market, config) {
  const symbol = traderSymbol(market, config);
  const key = `BEAT_MOMENTS_${symbol}`;
  const moments = config?.[key];
  return Array.isArray(moments) ? moments : [];
}

function summarizeBook(book) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  return {
    bidLevels: bids.length,
    askLevels: asks.length,
    totalBidSize: bids.reduce((sum, row) => sum + Number(row?.size ?? 0), 0),
    totalAskSize: asks.reduce((sum, row) => sum + Number(row?.size ?? 0), 0),
    bids,
    asks,
  };
}

function positiveFiniteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + (p * absX));
  const y = 1 - ((((((a5 * t) + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-(absX * absX));
  return sign * y;
}

function normalCDF(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

function logReturn(currentPrice, priorPrice) {
  const current = Number(currentPrice);
  const prior = Number(priorPrice);
  if (!Number.isFinite(current) || !Number.isFinite(prior) || current <= 0 || prior <= 0) {
    return null;
  }
  return Math.log(current / prior);
}

function lowerLogBarrierHitProbability({
  currentValue,
  targetValue,
  secondsLeft,
  driftPerSecond,
  sigmaPerSqrtSecond,
}) {
  const current = Number(currentValue);
  const target = Number(targetValue);
  const horizon = Number(secondsLeft);
  const mu = Number(driftPerSecond);
  const sigma = Number(sigmaPerSqrtSecond);
  if (!Number.isFinite(current) || !Number.isFinite(target) || current <= 0 || target <= 0) {
    return null;
  }
  if (!Number.isFinite(horizon) || horizon <= 0) {
    return current <= target ? 1 : 0;
  }
  if (current <= target) {
    return 1;
  }

  const barrierDistance = Math.log(current / target);
  if (!Number.isFinite(barrierDistance) || barrierDistance <= 0) {
    return 1;
  }

  if (!Number.isFinite(sigma) || sigma <= 1e-12) {
    if (!Number.isFinite(mu) || mu >= 0) {
      return 0;
    }
    const hitTimeSeconds = barrierDistance / Math.abs(mu);
    return hitTimeSeconds <= horizon ? 1 : 0;
  }

  const sigmaSqrtT = sigma * Math.sqrt(horizon);
  if (!Number.isFinite(sigmaSqrtT) || sigmaSqrtT <= 1e-12) {
    return 0;
  }

  const reflectedDrift = -mu;
  const term1 = (reflectedDrift * horizon) - barrierDistance;
  const term2 = (-reflectedDrift * horizon) - barrierDistance;
  const exponent = clamp((2 * reflectedDrift * barrierDistance) / (sigma * sigma), -60, 60);
  const probability = normalCDF(term1 / sigmaSqrtT) + (Math.exp(exponent) * normalCDF(term2 / sigmaSqrtT));
  return clamp(probability, 0, 1);
}

function roundShareAmount(value, precision = 1e-9) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.abs(num) <= precision ? 0 : num;
}

function reconstructActualFillsFromEstimate(estimatedPlan, actualShares, actualSpentUsdc) {
  const fills = Array.isArray(estimatedPlan?.fills) ? estimatedPlan.fills : [];
  let remainingShares = Number(actualShares);
  let remainingSpentUsdc = Number(actualSpentUsdc);
  if (!Number.isFinite(remainingShares) || !Number.isFinite(remainingSpentUsdc) || remainingShares <= 1e-9 || remainingSpentUsdc <= 1e-9) {
    return [];
  }

  const reconstructed = [];
  for (const fill of fills) {
    if (remainingShares <= 1e-9 || remainingSpentUsdc <= 1e-9) break;
    const price = Number(fill?.price);
    const fillShares = Number(fill?.shares);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(fillShares) || fillShares <= 1e-9) continue;

    const sharesAtRemainingSpent = remainingSpentUsdc / price;
    const takeShares = Math.min(fillShares, remainingShares, sharesAtRemainingSpent);
    if (!Number.isFinite(takeShares) || takeShares <= 1e-9) continue;

    let takeSpentUsdc = takeShares * price;
    if (takeSpentUsdc > remainingSpentUsdc) {
      takeSpentUsdc = remainingSpentUsdc;
    }
    reconstructed.push({
      price,
      shares: takeShares,
      spentUsdc: takeSpentUsdc,
      feeUsdc: 0,
    });
    remainingShares -= takeShares;
    remainingSpentUsdc -= takeSpentUsdc;
  }

  if (remainingShares > 1e-9 && Number.isFinite(estimatedPlan?.avgFillPrice) && Number(estimatedPlan.avgFillPrice) > 0) {
    const fallbackPrice = Number(estimatedPlan.avgFillPrice);
    reconstructed.push({
      price: fallbackPrice,
      shares: remainingShares,
      spentUsdc: Math.max(0, remainingSpentUsdc),
      feeUsdc: 0,
    });
  } else if (reconstructed.length && Math.abs(remainingSpentUsdc) > 1e-9) {
    reconstructed[reconstructed.length - 1].spentUsdc += remainingSpentUsdc;
  }

  return reconstructed.filter((fill) =>
    Number.isFinite(fill.price) &&
    Number.isFinite(fill.shares) &&
    Number.isFinite(fill.spentUsdc) &&
    fill.price > 0 &&
    fill.shares > 1e-9 &&
    fill.spentUsdc > 1e-9);
}

function bookAgeMs(book, nowMs = Date.now()) {
  const sourceTs = Number(book?.sourceTimestampMs);
  if (Number.isFinite(sourceTs) && sourceTs > 0) {
    return Math.max(0, nowMs - sourceTs);
  }
  const fetchedTs = Number(book?.fetchedAtMs);
  if (Number.isFinite(fetchedTs) && fetchedTs > 0) {
    return Math.max(0, nowMs - fetchedTs);
  }
  return Infinity;
}

export class BeatTrader {
  constructor(
    market,
    wallet,
    pnl,
    { dashboard = null, btcFeed = null, bookFeed = null, config = null, onSettled = null, btcHistoryProvider = null } = {},
  ) {
    this.market = market;
    this.wallet = wallet;
    this.pnl = pnl;
    this.dashboard = dashboard;
    this.onSettled = typeof onSettled === 'function' ? onSettled : null;
    this.log = marketLogger(market.slug);
    this.auditLog = marketFileLogger(market.slug);
    this.config = config ?? createBeatRuntimeConfig();

    this.lifecycle = BEAT_LIFECYCLE.UPCOMING;
    this.halted = false;
    this.stopBuying = false;
    this.balanceUp = 0;
    this.balanceDown = 0;
    this.walletBalanceUp = 0;
    this.walletBalanceDown = 0;
    this.totalSpent = 0;
    this.settledPayoutUsdc = 0;
    this.lastBuyAt = 0;
    this.beatPrice = null;
    this.latestBtcTick = null;
    this.latestQuotes = { up: null, down: null };
    this.tradeSummary = null;
    this.lastOutcome = null;
    this.nextBuyLotId = 1;
    this.nextPairId = 1;
    this.openLots = { Up: [], Down: [] };
    this.pairedLots = [];
    this._tokenFeeBpsCache = new Map();
    this._btcFeed = btcFeed;
    this._ownsBtcFeed = !btcFeed;
    this._btcFeedAttached = false;
    this._btcHistoryProvider = typeof btcHistoryProvider === 'function' ? btcHistoryProvider : null;
    this._bookFeed = bookFeed;
    this._ownsBookFeed = !bookFeed;
    this._bookFeedAttached = false;
    this.signalHistory = [];
    this.ofi = new BeatOfiTracker({
      enabled: this.config.BEAT_OFI_ENABLED,
      windowMs: this.config.BEAT_OFI_WINDOW_MS,
      toxicityThreshold: this.config.BEAT_OFI_TOXICITY_THRESHOLD,
      ratioEnter: this.config.BEAT_OFI_RATIO_ENTER,
      ratioExit: this.config.BEAT_OFI_RATIO_EXIT,
      exitRatio: this.config.BEAT_OFI_EXIT_RATIO,
    });
    this._loopCount = 0;
  }

  async run() {
    const cfg = this.config;
    const { windowTs, conditionId, upToken, downToken } = this.market;
    const windowClose = windowTs + cfg.MARKET_WINDOW_SECONDS;
    const momentsForLog = momentsForConfig(this.market, cfg);
    const firstStart = Number(momentsForLog[0]?.start ?? 0);

    this.log.info('BeatTrader: starting', {
      conditionId,
      dryRun: cfg.BEAT_DRY_RUN,
      upTokenId: upToken.tokenId,
      downTokenId: downToken.tokenId,
      windowOpen: new Date(windowTs * 1000).toISOString(),
      windowClose: new Date(windowClose * 1000).toISOString(),
      skipSeconds: firstStart,
      orderMode: cfg.BEAT_ORDER_MODE,
    });
    this._recordAudit('market_start', {
      marketSymbol: traderSymbol(this.market, cfg),
      conditionId,
      upTokenId: upToken.tokenId,
      downTokenId: downToken.tokenId,
      windowTs,
      windowClose,
      config: {
        dryRun: cfg.BEAT_DRY_RUN,
        orderMode: cfg.BEAT_ORDER_MODE,
        orderSizeUsdc: cfg.BEAT_ORDER_SIZE_USDC,
        orderSizeShares: cfg.BEAT_ORDER_SIZE_SHARES,
        maxSlippage: cfg.BEAT_MAX_SLIPPAGE,
        buyCooldownMs: cfg.BEAT_BUY_COOLDOWN_MS,
        maxSpendPerMarket: cfg.MAX_SPEND_PER_MARKET,
        maxInventoryImbalanceShares: cfg.BEAT_MAX_INVENTORY_IMBALANCE_SHARES,
        ofiEnabled: cfg.BEAT_OFI_ENABLED,
        ofiWindowMs: cfg.BEAT_OFI_WINDOW_MS,
        ofiToxicityThreshold: cfg.BEAT_OFI_TOXICITY_THRESHOLD,
        ofiRatioEnter: cfg.BEAT_OFI_RATIO_ENTER,
        ofiRatioExit: cfg.BEAT_OFI_RATIO_EXIT,
        ofiExitRatio: cfg.BEAT_OFI_EXIT_RATIO,
        probabilityEnabled: cfg.BEAT_PROBABILITY_ENABLED,
        probabilityHistoryMs: cfg.BEAT_PROBABILITY_HISTORY_MS,
        probabilityRequiredEdge: cfg.BEAT_PROBABILITY_REQUIRED_EDGE,
        probabilityPairCostMax: cfg.BEAT_PROBABILITY_PAIR_COST_MAX,
        arbPairEnabled: cfg.BEAT_ARB_PAIR_ENABLED,
        arbPairCostMax: cfg.BEAT_ARB_PAIR_COST_MAX,
        moments: momentsForLog,
      },
      auditLogPath: getMarketLogFilePath(this.market.slug),
    });

    this._startBtcFeed();
    this._startBookFeed();

    try {
      const waitMs = msUntil(windowTs);
      if (waitMs > 0) {
        this.log.debug('BeatTrader: waiting for market open', { waitMs: Math.round(waitMs) });
        this._recordAudit('wait_for_market_open', { waitMs: Math.round(waitMs) });
        await sleep(waitMs);
      }

      try {
        this.beatPrice = await this._captureBeatPrice(windowTs);
      } catch (err) {
        this.lifecycle = BEAT_LIFECYCLE.HALTED;
        this.log.warn('BeatTrader: unable to capture trustworthy beat price, halting market', {
          err: err.message,
          windowOpen: new Date(windowTs * 1000).toISOString(),
        });
        this._recordAudit('beat_price_capture_failed', {
          err: err.message,
          windowTs,
          reason: 'untrusted-beat-price',
        });
        this._publishMarket({
          lifecycle: BEAT_LIFECYCLE.HALTED,
          tradeStatus: BEAT_LIFECYCLE.HALTED,
        });
        return;
      }

      await this._primeCurrentBtcTick();
      this._seedSignalHistoryFromBtcHistory();

      // Determine first allowed buy time from the symbol-specific moments.
      const firstAllowedMs = (windowTs + firstStart) * 1000;
      const remainingSkipMs = firstAllowedMs - Date.now();
      if (remainingSkipMs > 0) {
        this.lifecycle = BEAT_LIFECYCLE.WAITING_SKIP;
        this._publishMarket({
          lifecycle: BEAT_LIFECYCLE.WAITING_SKIP,
          tradeStatus: BEAT_LIFECYCLE.WAITING_SKIP,
        });
        this.log.info('BeatTrader: waiting until first buy moment', {
          firstStart,
          beatPrice: this.beatPrice,
          waitMs: Math.round(remainingSkipMs),
        });
        this._recordAudit('wait_for_first_buy_moment', {
          firstStart,
          beatPrice: this.beatPrice,
          waitMs: Math.round(remainingSkipMs),
        });
        await sleep(remainingSkipMs);
      }

      this.lifecycle = BEAT_LIFECYCLE.MONITORING;
      this._publishMarket({ lifecycle: BEAT_LIFECYCLE.MONITORING, tradeStatus: BEAT_LIFECYCLE.MONITORING });
      await this._syncBalances(upToken.tokenId, downToken.tokenId);
      await this._monitorLoop(windowClose);

      this.lifecycle = BEAT_LIFECYCLE.RESOLVING;
      this._publishMarket({ lifecycle: BEAT_LIFECYCLE.RESOLVING, tradeStatus: BEAT_LIFECYCLE.RESOLVING });
    } finally {
      if (this._ownsBtcFeed) {
        this._btcFeed?.stop();
      }
      if (this._ownsBookFeed) {
        this._bookFeed?.stop();
      }
    }

    this.lifecycle = BEAT_LIFECYCLE.RESOLVING;
    const settled = await this._redeemPhase(conditionId, windowClose);
    if (!settled) {
      this.log.warn('BeatTrader: resolution still pending, market not marked settled', {
        beatPrice: this.beatPrice,
        totalSpent: this.totalSpent.toFixed(4),
        settledPayoutUsdc: this.settledPayoutUsdc.toFixed(4),
      });
      this._recordAudit('market_resolution_pending', {
        beatPrice: this.beatPrice,
        totalSpent: this.totalSpent,
        settledPayoutUsdc: this.settledPayoutUsdc,
        tradeSummary: this.tradeSummary,
        outcome: this.lastOutcome,
      });
      return;
    }

    this.lifecycle = BEAT_LIFECYCLE.SETTLED;
    this.log.info('BeatTrader: market complete', {
      beatPrice: this.beatPrice,
      totalSpent: this.totalSpent.toFixed(4),
      settledPayoutUsdc: this.settledPayoutUsdc.toFixed(4),
      netPnl: (this.settledPayoutUsdc - this.totalSpent).toFixed(4),
    });
    this._recordAudit('market_complete', {
      beatPrice: this.beatPrice,
      totalSpent: this.totalSpent,
      settledPayoutUsdc: this.settledPayoutUsdc,
      netPnl: this.settledPayoutUsdc - this.totalSpent,
      tradeSummary: this.tradeSummary,
      outcome: this.lastOutcome,
    });
  }

  _startBtcFeed() {
    if (!this._btcFeed) {
      this._btcFeed = new BtcPriceFeed({ config: this.config });
    }
    if (this._btcFeedAttached) return;

    this._btcFeedAttached = true;
    this._btcFeed.on('tick', (tick) => {
      this.latestBtcTick = tick;
      this._publishMarket({
        btcPrice: tick.price,
        btcBestBid: tick.bestBid ?? null,
        btcBestAsk: tick.bestAsk ?? null,
      });
    });
    this._btcFeed.on('error', (err) => {
      this.log.warn('BeatTrader: BTC feed error', { err: err.message });
    });
    if (this._ownsBtcFeed) {
      this._btcFeed.start();
    }
  }

  _startBookFeed() {
    if (!this._bookFeed) {
      this._bookFeed = new BookFeed([this.market.upToken.tokenId, this.market.downToken.tokenId]);
    }
    if (this._bookFeedAttached) return;

    this._bookFeedAttached = true;
    this._bookFeed.on('trade', (trade) => {
      this.ofi.recordTrade(trade);
    });
    this._bookFeed.on('error', (err) => {
      this.log.warn('BeatTrader: market book feed error', { err: err.message });
    });
    if (this._ownsBookFeed) {
      this._bookFeed.start();
    }
  }

  _syncOfiConfig() {
    this.ofi.enabled = Boolean(this.config.BEAT_OFI_ENABLED);
    this.ofi.windowMs = Math.max(250, Number(this.config.BEAT_OFI_WINDOW_MS) || 3_000);
    this.ofi.toxicityThreshold = Math.max(1, Number(this.config.BEAT_OFI_TOXICITY_THRESHOLD) || 200);
    this.ofi.ratioEnter = Math.max(0, Math.min(1, Number(this.config.BEAT_OFI_RATIO_ENTER) || 0.70));
    this.ofi.ratioExit = Math.max(0, Math.min(this.ofi.ratioEnter, Number(this.config.BEAT_OFI_RATIO_EXIT) || 0.40));
    this.ofi.exitRatio = Math.max(0.05, Math.min(0.99, Number(this.config.BEAT_OFI_EXIT_RATIO) || 0.85));
    this.ofi.hotThreshold = this.ofi.toxicityThreshold * 0.5;
  }

  async _captureBeatPrice(windowTs) {
    const windowOpenMs = windowTs * 1000;
    const deadlineMs = Date.now() + 20_000;
    let tick = null;
    let lastErr = null;

    while (Date.now() <= deadlineMs) {
      try {
        tick = await this._btcFeed.fetchHistoricalTickAt(windowOpenMs);
        break;
      } catch (err) {
        lastErr = err;
        await sleep(500);
      }
    }

    if (!tick || !Number.isFinite(Number(tick.price))) {
      const reason = lastErr?.message ? `: ${lastErr.message}` : '';
      throw new Error(`Historical beat price unavailable for ${new Date(windowOpenMs).toISOString()}${reason}`);
    }
    if (!tick.historical) {
      throw new Error(`Beat tick for ${new Date(windowOpenMs).toISOString()} was not historical`);
    }
    if (Number(tick.timeMs) !== windowOpenMs) {
      throw new Error(
        `Historical beat tick time ${new Date(tick.timeMs).toISOString()} does not match market open ${new Date(windowOpenMs).toISOString()}`,
      );
    }

    this._publishMarket({
      lifecycle: BEAT_LIFECYCLE.WAITING_SKIP,
      beatPrice: tick.price,
    });
    this.log.info('BeatTrader: captured BTC beat price', {
      beatPrice: tick.price,
      btcTime: tick.isoTime,
      historical: Boolean(tick.historical),
      source: tick.source,
      bestBid: tick.bestBid,
      bestAsk: tick.bestAsk,
    });
    this._recordAudit('beat_price_captured', {
      beatPrice: tick.price,
      btcTime: tick.isoTime,
      historical: Boolean(tick.historical),
      source: tick.source,
      bestBid: tick.bestBid ?? null,
      bestAsk: tick.bestAsk ?? null,
      tick,
    });
    return tick.price;
  }

  async _primeCurrentBtcTick() {
    if (this.latestBtcTick && !this.latestBtcTick.historical && Number.isFinite(Number(this.latestBtcTick.price))) {
      return this.latestBtcTick;
    }

    try {
      const refreshed = await this._btcFeed.fetchRestTick(1_500);
      if (refreshed && Number.isFinite(Number(refreshed.price))) {
        this.latestBtcTick = refreshed;
        this._recordAudit('current_btc_tick_primed', {
          strategy: 'rest',
          source: refreshed.source,
          btcPrice: refreshed.price,
          btcTime: refreshed.isoTime,
        });
        return refreshed;
      }
    } catch (err) {
      this.log.debug('BeatTrader: current BTC refresh failed before monitoring', { err: err.message });
      this._recordAudit('current_btc_tick_prime_failed', {
        strategy: 'rest',
        err: err.message,
      });
    }

    return null;
  }

  async _monitorLoop(windowClose) {
    const cfg = this.config;
      while (true) {
      const nowSec = Math.floor(Date.now() / 1000);
      this._loopCount += 1;
      // Stop buying when past the last moment's end (seconds after open)
      const momentsLocal = momentsForConfig(this.market, cfg);
      const lastEnd = Number(momentsLocal.length ? momentsLocal[momentsLocal.length - 1].end ?? cfg.MARKET_WINDOW_SECONDS : cfg.MARKET_WINDOW_SECONDS);
      if (nowSec >= (this.market.windowTs + lastEnd)) {
        this.log.info('BeatTrader: buy window closed (moments end)', { lastEnd });
        this._recordAudit('buy_window_closed', {
          loop: this._loopCount,
          nowSec,
          lastEnd,
          secondsAfterOpen: nowSec - this.market.windowTs,
        });
        break;
      }

      if (this._checkCircuitBreakers()) break;

      try {
        const snapshot = await this._snapshotMarketState();
        this._recordAudit('market_snapshot', {
          loop: this._loopCount,
          secondsAfterOpen: nowSec - this.market.windowTs,
          snapshot,
          latestBtcTick: this.latestBtcTick,
          quoteBooks: {
            up: summarizeBook(this.latestQuotes.up?.book),
            down: summarizeBook(this.latestQuotes.down?.book),
          },
          balances: {
            up: this.balanceUp,
            down: this.balanceDown,
          },
        });
        this._publishMarket({
          ...snapshot,
          lifecycle: BEAT_LIFECYCLE.MONITORING,
          tradeStatus: tradeStatusFromLifecycle(this.lifecycle, this.tradeSummary?.buyShares > 0),
        });
        this._recordSignalSample(snapshot);
        await this._maybeBuy(snapshot);
      } catch (err) {
        this.log.warn('BeatTrader: monitor iteration failed', { err: err.message });
        this._recordAudit('monitor_iteration_failed', {
          loop: this._loopCount,
          err: err.message,
          stack: err.stack ?? null,
        });
      }

      if (nowSec % 30 === 0) {
        await this._syncBalances(this.market.upToken.tokenId, this.market.downToken.tokenId);
      }

      await sleep(cfg.BEAT_BOOK_POLL_MS);
    }
  }

  async _snapshotMarketState() {
    const snapshotAtMs = Date.now();
    const [upBook, downBook] = await Promise.all([
      ClobClient.getBook(this.market.upToken.tokenId),
      ClobClient.getBook(this.market.downToken.tokenId),
    ]);

    const upBid = bestBid(upBook);
    const upAsk = bestAsk(upBook);
    const downBid = bestBid(downBook);
    const downAsk = bestAsk(downBook);

    this.latestQuotes = {
      up: { book: upBook, bid: upBid, ask: upAsk },
      down: { book: downBook, bid: downBid, ask: downAsk },
    };

    const secondsAfterOpen = Math.max(0, (Date.now() - (this.market.windowTs * 1000)) / 1000);
    const btcPrice = Number.isFinite(Number(this.latestBtcTick?.price)) ? Number(this.latestBtcTick.price) : null;
    const beatPrice = Number.isFinite(Number(this.beatPrice)) ? Number(this.beatPrice) : null;
    let upAskPrice = positiveFiniteOrNull(upAsk?.price);
    let downAskPrice = positiveFiniteOrNull(downAsk?.price);
    if (upAskPrice == null && downAskPrice == null) {
      upAskPrice = null;
      downAskPrice = null;
    }
    const chartPoint = {
      second: Math.min(this.config.MARKET_WINDOW_SECONDS, secondsAfterOpen),
      move: Number.isFinite(btcPrice) && Number.isFinite(beatPrice) ? btcPrice - beatPrice : null,
      upAsk: upAskPrice,
      downAsk: downAskPrice,
    };

    return {
      snapshotAtMs,
      upBestBid: upBid?.price ?? null,
      upBestAsk: upAsk?.price ?? null,
      upBookAgeMs: bookAgeMs(upBook, snapshotAtMs),
      downBestBid: downBid?.price ?? null,
      downBestAsk: downAsk?.price ?? null,
      downBookAgeMs: bookAgeMs(downBook, snapshotAtMs),
      beatPrice,
      btcPrice,
      chartPoint,
    };
  }

  _recordSignalSample(snapshot = {}) {
    const timestampMs = Number(snapshot.snapshotAtMs ?? Date.now());
    const btcPrice = Number(snapshot.btcPrice);
    const beatPrice = Number(snapshot.beatPrice);
    const move = Number.isFinite(btcPrice) && Number.isFinite(beatPrice)
      ? btcPrice - beatPrice
      : null;

    this.signalHistory.push({
      timestampMs,
      price: Number.isFinite(btcPrice) ? btcPrice : null,
      move,
      upAsk: positiveFiniteOrNull(snapshot.upBestAsk),
      downAsk: positiveFiniteOrNull(snapshot.downBestAsk),
    });

    const historyWindowMs = Math.max(1_000, Number(this.config.BEAT_PROBABILITY_HISTORY_MS) || 15_000);
    const keepAfterMs = timestampMs - historyWindowMs;
    this.signalHistory = this.signalHistory.filter((entry) => Number(entry?.timestampMs ?? 0) >= keepAfterMs);
  }

  _providerBackedSignalEntries(nowMs = Date.now()) {
    if (!Number.isFinite(Number(this.beatPrice))) return [];
    const historyWindowMs = Math.max(30_000, Number(this.config.BEAT_PROBABILITY_HISTORY_MS) || 30_000);
    const rawHistory = Array.isArray(this._btcHistoryProvider?.()) ? this._btcHistoryProvider() : [];
    if (!rawHistory.length) return [];

    const keepAfterMs = nowMs - historyWindowMs;
    const normalized = rawHistory
      .map((entry) => ({
        timestampMs: Number(entry?.timeMs),
        price: Number(entry?.price),
      }))
      .filter((entry) => (
        Number.isFinite(entry.timestampMs) &&
        Number.isFinite(entry.price) &&
        entry.timestampMs <= nowMs
      ))
      .sort((a, b) => a.timestampMs - b.timestampMs);

    if (!normalized.length) return [];

    const anchorBeforeWindow = [...normalized]
      .reverse()
      .find((entry) => entry.timestampMs < keepAfterMs) ?? null;
    const inWindow = normalized.filter((entry) => entry.timestampMs >= keepAfterMs);
    const selected = anchorBeforeWindow ? [anchorBeforeWindow, ...inWindow] : inWindow;

    return selected
      .map((entry) => ({
        timestampMs: entry.timestampMs,
        price: entry.price,
        move: entry.price - Number(this.beatPrice),
        upAsk: null,
        downAsk: null,
      }));
  }

  _mergeSignalHistory(entries = [], nowMs = Date.now()) {
    const historyWindowMs = Math.max(30_000, Number(this.config.BEAT_PROBABILITY_HISTORY_MS) || 30_000);
    const keepAfterMs = nowMs - historyWindowMs;
    const merged = [...entries]
      .filter((entry) => Number.isFinite(Number(entry?.timestampMs ?? 0)))
      .sort((a, b) => Number(a?.timestampMs ?? 0) - Number(b?.timestampMs ?? 0));

    const deduped = [];
    for (const entry of merged) {
      const ts = Number(entry?.timestampMs ?? 0);
      const prev = deduped[deduped.length - 1];
      if (prev && Math.abs(Number(prev.timestampMs) - ts) <= 1) {
        deduped[deduped.length - 1] = {
          timestampMs: ts,
          price: Number.isFinite(Number(entry.price)) ? Number(entry.price) : (prev.price ?? null),
          move: Number.isFinite(Number(entry.move)) ? Number(entry.move) : prev.move,
          upAsk: entry.upAsk ?? prev.upAsk ?? null,
          downAsk: entry.downAsk ?? prev.downAsk ?? null,
        };
        continue;
      }
      deduped.push({
        timestampMs: ts,
        price: Number.isFinite(Number(entry.price)) ? Number(entry.price) : null,
        move: Number.isFinite(Number(entry.move)) ? Number(entry.move) : null,
        upAsk: entry.upAsk ?? null,
        downAsk: entry.downAsk ?? null,
      });
    }

    const anchorBeforeWindow = [...deduped]
      .reverse()
      .find((entry) => Number(entry?.timestampMs ?? 0) < keepAfterMs) ?? null;
    const inWindow = deduped.filter((entry) => Number(entry?.timestampMs ?? 0) >= keepAfterMs);
    return anchorBeforeWindow ? [anchorBeforeWindow, ...inWindow] : inWindow;
  }

  _effectiveSignalHistory(nowMs = Date.now()) {
    return this._mergeSignalHistory([
      ...this.signalHistory,
      ...this._providerBackedSignalEntries(nowMs),
    ], nowMs);
  }

  _seedSignalHistoryFromBtcHistory(nowMs = Date.now()) {
    this.signalHistory = this._effectiveSignalHistory(nowMs);
  }

  _hasGuaranteedProbabilityHistory(nowMs = Date.now()) {
    const historyWindowMs = Math.max(30_000, Number(this.config.BEAT_PROBABILITY_HISTORY_MS) || 30_000);
    const history = this._effectiveSignalHistory(nowMs);
    if (!history.length) return false;
    const earliestTs = Number(history[0]?.timestampMs ?? 0);
    const latestTs = Number(history[history.length - 1]?.timestampMs ?? 0);
    if (!Number.isFinite(earliestTs) || !Number.isFinite(latestTs)) return false;
    return earliestTs <= (nowMs - historyWindowMs) && latestTs <= nowMs;
  }

  _sampleAgo(msAgo, nowMs = Date.now(), history = this.signalHistory) {
    const cutoffMs = nowMs - msAgo;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const sample = history[i];
      if (Number(sample?.timestampMs ?? 0) <= cutoffMs) {
        return sample;
      }
    }
    return history[0] ?? null;
  }

  _seriesSampleAgo(series = [], msAgo, nowMs = Date.now()) {
    const cutoffMs = nowMs - msAgo;
    for (let i = series.length - 1; i >= 0; i -= 1) {
      const sample = series[i];
      if (Number(sample?.timestampMs ?? 0) <= cutoffMs) {
        return sample;
      }
    }
    return series[0] ?? null;
  }

  _askHistorySeries(side, nowMs = Date.now(), history = null) {
    const sourceHistory = Array.isArray(history) ? history : this._effectiveSignalHistory(nowMs);
    const askKey = side === 'Up' ? 'upAsk' : (side === 'Down' ? 'downAsk' : null);
    if (!askKey) return [];
    return sourceHistory
      .map((entry) => ({
        timestampMs: Number(entry?.timestampMs),
        value: positiveFiniteOrNull(entry?.[askKey]),
      }))
      .filter((entry) => Number.isFinite(entry.timestampMs) && Number.isFinite(entry.value) && entry.value > 0)
      .sort((a, b) => a.timestampMs - b.timestampMs);
  }

  _ewmaSigmaPerSqrtSecond(history = []) {
    const lambda = clamp(Number(this.config.BEAT_PROBABILITY_VOL_LAMBDA) || 0.97, 0.5, 0.9999);
    let variance = null;
    for (let i = 1; i < history.length; i += 1) {
      const prev = history[i - 1];
      const next = history[i];
      const prevPrice = Number(prev?.price);
      const nextPrice = Number(next?.price);
      const prevTs = Number(prev?.timestampMs);
      const nextTs = Number(next?.timestampMs);
      if (!Number.isFinite(prevPrice) || !Number.isFinite(nextPrice) || prevPrice <= 0 || nextPrice <= 0) continue;
      if (!Number.isFinite(prevTs) || !Number.isFinite(nextTs) || nextTs <= prevTs) continue;
      const dtSeconds = (nextTs - prevTs) / 1000;
      if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) continue;
      const r = logReturn(nextPrice, prevPrice);
      if (!Number.isFinite(r)) continue;
      const perSecondVariance = (r * r) / dtSeconds;
      variance = variance == null
        ? perSecondVariance
        : ((lambda * variance) + ((1 - lambda) * perSecondVariance));
    }
    return variance != null && variance > 0 ? Math.sqrt(variance) : null;
  }

  _ewmaSigmaPerSqrtSecondForSeries(series = [], lambda = null) {
    const normalizedLambda = clamp(
      Number.isFinite(Number(lambda))
        ? Number(lambda)
        : (Number(this.config.BEAT_PROBABILITY_VOL_LAMBDA) || 0.97),
      0.5,
      0.9999,
    );
    let variance = null;
    for (let i = 1; i < series.length; i += 1) {
      const prev = series[i - 1];
      const next = series[i];
      const prevValue = Number(prev?.value);
      const nextValue = Number(next?.value);
      const prevTs = Number(prev?.timestampMs);
      const nextTs = Number(next?.timestampMs);
      if (!Number.isFinite(prevValue) || !Number.isFinite(nextValue) || prevValue <= 0 || nextValue <= 0) continue;
      if (!Number.isFinite(prevTs) || !Number.isFinite(nextTs) || nextTs <= prevTs) continue;
      const dtSeconds = (nextTs - prevTs) / 1000;
      if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) continue;
      const r = logReturn(nextValue, prevValue);
      if (!Number.isFinite(r)) continue;
      const perSecondVariance = (r * r) / dtSeconds;
      variance = variance == null
        ? perSecondVariance
        : ((normalizedLambda * variance) + ((1 - normalizedLambda) * perSecondVariance));
    }
    return variance != null && variance > 0 ? Math.sqrt(variance) : null;
  }

  async _getTokenTakerFeeBps(tokenId) {
    const key = String(tokenId ?? '').trim();
    if (!key) return 0;
    if (this._tokenFeeBpsCache.has(key)) {
      return Number(this._tokenFeeBpsCache.get(key) ?? 0);
    }
    try {
      const feeRateBps = Number(await ClobClient.getTakerFeeBps(key));
      const normalized = Number.isFinite(feeRateBps) && feeRateBps > 0 ? feeRateBps : 0;
      this._tokenFeeBpsCache.set(key, normalized);
      return normalized;
    } catch (err) {
      this._recordAudit('token_fee_bps_lookup_failed', {
        tokenId: key,
        err: err.message,
      });
      this._tokenFeeBpsCache.set(key, 0);
      return 0;
    }
  }

  _pairFeeUsdc(shares, price, feeRateBps) {
    return ClobClient.estimateTakerFeeUsdc({ shares, price, feeRateBps });
  }

  _pairTotalUnitCost(existingUnitCost, buyPrice, feeRateBps) {
    const existing = Number(existingUnitCost);
    const price = Number(buyPrice);
    if (!Number.isFinite(existing) || !Number.isFinite(price) || price <= 0) return null;
    return existing + price + this._pairFeeUsdc(1, price, feeRateBps);
  }

  _maxFeeAdjustedPairBuyPrice(existingUnitCost, feeRateBps, pairCostCap) {
    const existing = Number(existingUnitCost);
    const cap = Number(pairCostCap);
    if (!Number.isFinite(existing) || !Number.isFinite(cap) || cap <= 0 || existing >= cap) {
      return null;
    }
    let low = 0;
    let high = Math.min(0.999999, cap - existing);
    if (!(high > 0)) return null;
    for (let i = 0; i < 40; i += 1) {
      const mid = (low + high) / 2;
      const totalUnitCost = this._pairTotalUnitCost(existing, mid, feeRateBps);
      if (Number.isFinite(totalUnitCost) && totalUnitCost <= cap) low = mid;
      else high = mid;
    }
    return low > 0 ? low : null;
  }

  async _pairCompletionModel({ buySide, buyPrice, snapshot = {}, history = null } = {}) {
    const cfg = this.config;
    if (!cfg.BEAT_PAIR_COMPLETION_ENABLED) {
      return null;
    }

    const normalizedBuyPrice = Number(buyPrice);
    const oppositeSide = this._oppositeSide(buySide);
    if (!oppositeSide || !Number.isFinite(normalizedBuyPrice) || normalizedBuyPrice <= 0) {
      return null;
    }

    const nowMs = Number(snapshot.snapshotAtMs ?? Date.now());
    const effectiveHistory = Array.isArray(history) ? history : this._effectiveSignalHistory(nowMs);
    const currentOppositeAsk = positiveFiniteOrNull(
      oppositeSide === 'Up' ? snapshot.upBestAsk : snapshot.downBestAsk,
    );
    const pairCostThreshold = this._pairCostThreshold();
    const oppositeTokenId = oppositeSide === 'Up' ? this.market.upToken?.tokenId : this.market.downToken?.tokenId;
    const oppositeFeeRateBps = await this._getTokenTakerFeeBps(oppositeTokenId);
    const targetOppositeAsk = this._maxFeeAdjustedPairBuyPrice(
      normalizedBuyPrice,
      oppositeFeeRateBps,
      pairCostThreshold,
    );
    const secondsLeft = Math.max(1, ((this.market.windowTs + this.config.MARKET_WINDOW_SECONDS) * 1000 - nowMs) / 1000);
    if (!Number.isFinite(currentOppositeAsk) || !Number.isFinite(targetOppositeAsk) || targetOppositeAsk <= 0) {
      return {
        oppositeSide,
        currentOppositeAsk,
        targetOppositeAsk,
        oppositeFeeRateBps,
        secondsLeft,
        completionProbability: 0,
        reason: 'missing-opposite-ask-or-target',
      };
    }
    if (currentOppositeAsk <= targetOppositeAsk) {
      return {
        oppositeSide,
        currentOppositeAsk,
        targetOppositeAsk,
        oppositeFeeRateBps,
        secondsLeft,
        completionProbability: 1,
        reason: 'already-pairable',
      };
    }

    const askSeries = this._askHistorySeries(oppositeSide, nowMs, effectiveHistory);
    if (askSeries.length < 2) {
      return {
        oppositeSide,
        currentOppositeAsk,
        targetOppositeAsk,
        oppositeFeeRateBps,
        secondsLeft,
        completionProbability: 0,
        reason: 'insufficient-ask-history',
      };
    }

    const checkpointsMs = [1_000, 3_000, 10_000, 30_000];
    const perSecondMomentum = Object.fromEntries(checkpointsMs.map((ms) => {
      const sample = this._seriesSampleAgo(askSeries, ms, nowMs);
      const priorValue = Number(sample?.value);
      const value = logReturn(currentOppositeAsk, priorValue);
      return [ms, Number.isFinite(value) ? value / (ms / 1000) : 0];
    }));

    const askMomentum1 = perSecondMomentum[1_000];
    const askMomentum3 = perSecondMomentum[3_000];
    const askMomentum10 = perSecondMomentum[10_000];
    const askMomentum30 = perSecondMomentum[30_000];
    const askDriftRaw = (
      (0.45 * askMomentum1) +
      (0.30 * askMomentum3) +
      (0.20 * askMomentum10) +
      (0.05 * askMomentum30)
    );
    const askDrift = clamp(Number(cfg.BEAT_PAIR_COMPLETION_DRIFT_SHRINK) || 0.25, 0, 1) * askDriftRaw;
    const askSigmaPerSqrtSecond = this._ewmaSigmaPerSqrtSecondForSeries(askSeries);
    const barrierLogDistance = Math.log(currentOppositeAsk / targetOppositeAsk);
    const completionProbability = lowerLogBarrierHitProbability({
      currentValue: currentOppositeAsk,
      targetValue: targetOppositeAsk,
      secondsLeft,
      driftPerSecond: askDrift,
      sigmaPerSqrtSecond: askSigmaPerSqrtSecond,
    });

    return {
      oppositeSide,
      currentOppositeAsk,
      targetOppositeAsk,
      oppositeFeeRateBps,
      secondsLeft,
      barrierLogDistance: Number.isFinite(barrierLogDistance) ? barrierLogDistance : null,
      sigmaPerSqrtSecond: askSigmaPerSqrtSecond,
      driftPerSecond: askDrift,
      driftRawPerSecond: askDriftRaw,
      momentum1s: askMomentum1,
      momentum3s: askMomentum3,
      momentum10s: askMomentum10,
      momentum30s: askMomentum30,
      completionProbability: Number.isFinite(completionProbability) ? completionProbability : 0,
      reason: 'modeled',
    };
  }

  _probabilityModel(snapshot = {}) {
    const nowMs = Number(snapshot.snapshotAtMs ?? Date.now());
    const historyWindowMs = Math.max(30_000, Number(this.config.BEAT_PROBABILITY_HISTORY_MS) || 30_000);
    const history = this._effectiveSignalHistory(nowMs);
    if (!history.length) {
      return null;
    }
    const earliestTs = Number(history[0]?.timestampMs ?? 0);
    const latestTs = Number(history[history.length - 1]?.timestampMs ?? 0);
    if (!Number.isFinite(earliestTs) || !Number.isFinite(latestTs) || earliestTs > (nowMs - historyWindowMs) || latestTs > nowMs) {
      return null;
    }
    const btcPrice = Number(snapshot.btcPrice);
    const beatPrice = Number(snapshot.beatPrice);
    const move = Number.isFinite(btcPrice) && Number.isFinite(beatPrice)
      ? btcPrice - beatPrice
      : 0;
    const upAsk = positiveFiniteOrNull(snapshot.upBestAsk);
    const downAsk = positiveFiniteOrNull(snapshot.downBestAsk);
    const pairCost = Number.isFinite(upAsk) && Number.isFinite(downAsk) ? upAsk + downAsk : null;

    const checkpointsMs = [500, 1_000, 2_000, 3_000, 10_000, 30_000];
    const checkpointPrices = Object.fromEntries(checkpointsMs.map((ms) => {
      const sample = this._sampleAgo(ms, nowMs, history);
      const samplePrice = Number(sample?.price);
      return [ms, Number.isFinite(samplePrice) && samplePrice > 0 ? samplePrice : btcPrice];
    }));
    const perSecondMomentum = Object.fromEntries(checkpointsMs.map((ms) => {
      const priorPrice = checkpointPrices[ms];
      const value = logReturn(btcPrice, priorPrice);
      return [ms, Number.isFinite(value) ? value / (ms / 1000) : 0];
    }));

    const momentum0To0_5 = perSecondMomentum[500];
    const momentum0To1 = perSecondMomentum[1_000];
    const momentum0To2 = perSecondMomentum[2_000];
    const momentum0To3 = perSecondMomentum[3_000];
    const momentum0To10 = perSecondMomentum[10_000];
    const momentum0To30 = perSecondMomentum[30_000];

    const microMomentum = (
      (0.50 * momentum0To0_5) +
      (0.30 * momentum0To1) +
      (0.20 * momentum0To2)
    );
    const slowMomentum = (
      (0.50 * momentum0To3) +
      (0.35 * momentum0To10) +
      (0.15 * momentum0To30)
    );
    const velocityComposite = (
      (0.45 * microMomentum) +
      (0.55 * slowMomentum)
    );
    const accelerationFast = momentum0To0_5 - momentum0To1;
    const accelerationMid = momentum0To1 - momentum0To3;
    const accelerationSlow = momentum0To3 - momentum0To10;
    const accelerationComposite = (
      (0.50 * accelerationFast) +
      (0.30 * accelerationMid) +
      (0.20 * accelerationSlow)
    );
    const momentumComposite = (
      (0.65 * slowMomentum) +
      (0.35 * microMomentum) +
      (0.25 * accelerationComposite)
    );

    const upOfi = this.ofi.snapshotFor(this.market.upToken.tokenId, nowMs);
    const downOfi = this.ofi.snapshotFor(this.market.downToken.tokenId, nowMs);
    const ofiDiff = Number(upOfi?.ofiScore ?? 0) - Number(downOfi?.ofiScore ?? 0);
    const ofiThreshold = Math.max(1, Number(this.config.BEAT_OFI_TOXICITY_THRESHOLD) || 200);
    const ofiMomentumFactor = clamp(ofiDiff / ofiThreshold, -1, 1);

    const sigmaPerSqrtSecond = this._ewmaSigmaPerSqrtSecond(history);
    const secondsLeft = Math.max(1, ((this.market.windowTs + this.config.MARKET_WINDOW_SECONDS) * 1000 - nowMs) / 1000);
    const x = logReturn(btcPrice, beatPrice);
    const muRaw = (
      (0.50 * momentum0To3) +
      (0.35 * momentum0To10) +
      (0.15 * momentum0To30)
    );
    const muMicro = microMomentum;
    const momentumScale = Math.max(
      Math.abs(muRaw),
      Math.abs(muMicro),
      Math.abs(momentumComposite),
      Number.isFinite(sigmaPerSqrtSecond) && sigmaPerSqrtSecond > 0
        ? (sigmaPerSqrtSecond / Math.sqrt(secondsLeft))
        : 0,
      1e-6,
    );
    const ofiWeight = Math.max(0, Number(this.config.BEAT_PROBABILITY_OFI_WEIGHT) || 0.20);
    const ofiMomentumAdjustment = ofiWeight * ofiMomentumFactor * momentumScale;
    const muBlended = (
      (0.75 * muRaw) +
      (0.25 * muMicro) +
      ofiMomentumAdjustment
    );
    const driftShrink = clamp(Number(this.config.BEAT_PROBABILITY_DRIFT_SHRINK) || 0.35, 0, 1);
    const mu = driftShrink * muBlended;
    const upCheapness = Number.isFinite(upAsk) ? clamp((0.5 - upAsk) / 0.25, -1, 1) : -1;
    const downCheapness = Number.isFinite(downAsk) ? clamp((0.5 - downAsk) / 0.25, -1, 1) : -1;
    const pairFeature = Number.isFinite(pairCost) ? clamp((1 - pairCost) / 0.08, -1, 1) : -1;
    const flipPotential = clamp(1 - (Math.abs(move) / 40), 0, 1);
    const zDenominator = Number.isFinite(sigmaPerSqrtSecond) && sigmaPerSqrtSecond > 0
      ? sigmaPerSqrtSecond * Math.sqrt(secondsLeft)
      : null;
    const zRaw = Number.isFinite(x) && Number.isFinite(mu) && Number.isFinite(zDenominator) && zDenominator > 0
      ? (x + (mu * secondsLeft)) / zDenominator
      : 0;
    const pRaw = normalCDF(clamp(zRaw, -8, 8));
    const confidence = clamp(Number(this.config.BEAT_PROBABILITY_CONFIDENCE) || 0.80, 0, 1);
    const minProbability = clamp(Number(this.config.BEAT_PROBABILITY_MIN) || 0.05, 0, 0.5);
    const maxProbability = clamp(Number(this.config.BEAT_PROBABILITY_MAX) || 0.95, 0.5, 1);
    const pUpFair = clamp(0.5 + (confidence * (pRaw - 0.5)), minProbability, maxProbability);
    const pDownFair = 1 - pUpFair;
    const upScore = Math.log(Math.max(1e-9, pUpFair));
    const downScore = Math.log(Math.max(1e-9, pDownFair));

    return {
      pairCost,
      pUp: pUpFair,
      pDown: pDownFair,
      features: {
        move,
        checkpointsMs,
        priceLogDistance: x,
        secondsLeft,
        sigmaPerSqrtSecond,
        driftPerSecond: mu,
        driftRawPerSecond: muRaw,
        microDriftPerSecond: muMicro,
        ofiMomentumFactor,
        ofiMomentumAdjustment,
        momentum0To0_5,
        momentum0To1,
        momentum0To2,
        momentum0To3,
        momentum0To10,
        momentum0To30,
        velocityComposite,
        accelerationFast,
        accelerationMid,
        accelerationSlow,
        accelerationComposite,
        momentumComposite,
        ofiDiff,
        upCheapness,
        downCheapness,
        pairFeature,
        flipPotential,
        zRaw,
        pRaw,
      },
      scores: {
        up: upScore,
        down: downScore,
      },
    };
  }

  async _maybeBuy(snapshot = {}) {
    const cfg = this.config;
    this._syncOfiConfig();
    if (!this.beatPrice) {
      this._recordAudit('decision_skip', { reason: 'missing-beat-price', snapshot });
      return;
    }
    if (this.stopBuying && this.halted) {
      this._recordAudit('decision_skip', {
        reason: 'buying-stopped',
        stopReason: 'halted',
        totalSpent: this.totalSpent,
        maxSpendPerMarket: cfg.MAX_SPEND_PER_MARKET,
      });
      return;
    }
    if (Date.now() - this.lastBuyAt < cfg.BEAT_BUY_COOLDOWN_MS) {
      this._recordAudit('decision_skip', {
        reason: 'buy-cooldown',
        cooldownMs: cfg.BEAT_BUY_COOLDOWN_MS,
        msSinceLastBuy: Date.now() - this.lastBuyAt,
      });
      return;
    }

    let tick = this.latestBtcTick;
    if (!tick) {
      this._recordAudit('decision_skip', { reason: 'missing-btc-tick', snapshot });
      return;
    }

    let ageMs = Date.now() - tick.timeMs;
    if (ageMs > cfg.BTC_PRICE_MAX_AGE_MS) {
      try {
        const refreshed = await this._btcFeed.fetchRestTick(1_500);
        tick = refreshed;
        this.latestBtcTick = refreshed;
        ageMs = Date.now() - refreshed.timeMs;
      } catch (err) {
        this.log.debug('BeatTrader: stale tick refresh failed', { err: err.message });
        this._recordAudit('stale_tick_refresh_failed', { err: err.message });
      }
      if (ageMs > cfg.BTC_PRICE_MAX_AGE_MS) {
        this.log.debug('BeatTrader: skipping stale BTC tick', { ageMs, maxAgeMs: cfg.BTC_PRICE_MAX_AGE_MS });
        this._recordAudit('decision_skip', {
          reason: 'stale-btc-tick',
          ageMs,
          maxAgeMs: cfg.BTC_PRICE_MAX_AGE_MS,
          tick,
        });
        return;
      }
    }

    const delta = tick.price - this.beatPrice;
    const probabilityModel = cfg.BEAT_PROBABILITY_ENABLED ? this._probabilityModel(snapshot) : null;
    if (cfg.BEAT_PROBABILITY_ENABLED && !probabilityModel) {
      const effectiveHistory = this._effectiveSignalHistory(Number(snapshot?.snapshotAtMs ?? Date.now()));
      this._recordAudit('decision_skip', {
        reason: 'insufficient-btc-history',
        requiredHistoryMs: cfg.BEAT_PROBABILITY_HISTORY_MS,
        availableFromMs: Number(effectiveHistory[0]?.timestampMs ?? null),
        snapshotAtMs: Number(snapshot?.snapshotAtMs ?? Date.now()),
      });
      return;
    }
    // Determine per-moment thresholds (seconds after market open)
    const secondsAfterOpen = Math.floor(Date.now() / 1000) - this.market.windowTs;
    const moments = momentsForConfig(this.market, cfg);
    const moment = moments.find((m) => secondsAfterOpen >= Number(m.start ?? 0) && secondsAfterOpen < Number(m.end ?? cfg.MARKET_WINDOW_SECONDS)) || null;
    // Require an explicit moment with thresholds to allow buys. `buyMax` now
    // means the minimum distance from 0.5 for the side ask to qualify.
    if (!moment || !Number.isFinite(Number(moment.btcmoveMax)) || !Number.isFinite(Number(moment.buyMax))) {
      this._recordAudit('decision_skip', {
        reason: 'no-active-moment',
        secondsAfterOpen,
        delta,
        beatPrice: this.beatPrice,
        btcPrice: tick.price,
        availableMoments: moments,
      });
      return;
    }

    const thresholds = { upMax: Number(moment.btcmoveMax), downMax: Number(moment.btcmoveMax) };
    const minDistanceFromMid = Number(moment.buyMax);
    const bookState = {
      Up: {
        tokenId: this.market.upToken.tokenId,
        book: this.latestQuotes.up?.book ?? null,
        bid: this.latestQuotes.up?.bid ?? null,
        ask: this.latestQuotes.up?.ask ?? null,
        bookAgeMs: bookAgeMs(this.latestQuotes.up?.book),
        minDistanceFromMid,
      },
      Down: {
        tokenId: this.market.downToken.tokenId,
        book: this.latestQuotes.down?.book ?? null,
        bid: this.latestQuotes.down?.bid ?? null,
        ask: this.latestQuotes.down?.ask ?? null,
        bookAgeMs: bookAgeMs(this.latestQuotes.down?.book),
        minDistanceFromMid,
      },
    };

    const absoluteMove = Math.abs(delta);
    const effectiveHistory = probabilityModel ? this._effectiveSignalHistory(Number(snapshot?.snapshotAtMs ?? Date.now())) : null;
    if (!probabilityModel && absoluteMove > Math.max(thresholds.upMax, thresholds.downMax)) {
      this._recordAudit('decision_skip', {
        reason: 'delta-outside-thresholds',
        secondsAfterOpen,
        delta,
        absoluteMove,
        beatPrice: this.beatPrice,
        btcPrice: tick.price,
        thresholds,
        moment,
        snapshot,
        });
      return;
    }
    const candidateLegs = await Promise.all(Object.entries(bookState)
      .map(async ([side, leg]) => {
        const sideProbability = probabilityModel
          ? (side === 'Up' ? probabilityModel.pUp : probabilityModel.pDown)
          : null;
        const askPrice = Number(leg.ask?.price);
        const distanceFromMid = Number.isFinite(askPrice)
          ? Math.abs(0.5 - askPrice)
          : null;
        const directionalEdge = Number.isFinite(sideProbability) && Number.isFinite(askPrice)
          ? (
              askPrice < 0.5
                ? sideProbability - askPrice
                : askPrice > 0.5
                  ? askPrice - sideProbability
                  : Math.abs(sideProbability - askPrice)
            )
          : null;
        const pairCompletionModel = probabilityModel
          ? await this._pairCompletionModel({
            buySide: side,
            buyPrice: leg.ask?.price,
            snapshot,
            history: effectiveHistory,
          })
          : null;
        const pairCompletionProbability = Number(pairCompletionModel?.completionProbability);
        const effectiveDirectionalEdge = Number.isFinite(directionalEdge) && Number.isFinite(pairCompletionProbability)
          ? directionalEdge * pairCompletionProbability
          : directionalEdge;
        const edgeFactor = Number.isFinite(effectiveDirectionalEdge)
          ? clamp(effectiveDirectionalEdge / Math.max(0.0001, Number(cfg.BEAT_PROBABILITY_REQUIRED_EDGE)), 0, 1)
          : 0;
        const baseMoveMax = side === 'Up' ? thresholds.upMax : thresholds.downMax;
        const dynamicMoveMax = probabilityModel
          ? Math.min(
            baseMoveMax,
            Math.max(5, baseMoveMax * (0.35 + (0.65 * edgeFactor))),
          )
          : baseMoveMax;

        if (!leg.ask) {
          return { side, leg, affordable: false, maxPrice: null, reason: 'missing-best-ask', sideProbability, directionalEdge, effectiveDirectionalEdge, pairCompletionModel, distanceFromMid, dynamicMoveMax };
        }
        if (!Number.isFinite(leg.bookAgeMs) || leg.bookAgeMs > cfg.BEAT_BOOK_MAX_AGE_MS) {
          return { side, leg, affordable: false, maxPrice: null, reason: 'stale-book', sideProbability, directionalEdge, effectiveDirectionalEdge, pairCompletionModel, distanceFromMid, dynamicMoveMax };
        }
        if (!Number.isFinite(distanceFromMid) || distanceFromMid + 1e-9 < leg.minDistanceFromMid) {
          return { side, leg, affordable: false, maxPrice: null, reason: 'distance-from-mid-too-small', sideProbability, directionalEdge, effectiveDirectionalEdge, pairCompletionModel, distanceFromMid, dynamicMoveMax };
        }
        if (probabilityModel) {
          if (!Number.isFinite(probabilityModel.pairCost) || probabilityModel.pairCost > Number(cfg.BEAT_PROBABILITY_PAIR_COST_MAX)) {
            return { side, leg, affordable: false, maxPrice: null, reason: 'pair-cost-too-high', sideProbability, directionalEdge, effectiveDirectionalEdge, pairCompletionModel, distanceFromMid, dynamicMoveMax };
          }
          if (!Number.isFinite(pairCompletionProbability) || pairCompletionProbability < Number(cfg.BEAT_PAIR_COMPLETION_MIN_PROBABILITY)) {
            return { side, leg, affordable: false, maxPrice: null, reason: 'pair-completion-probability-too-small', sideProbability, directionalEdge, effectiveDirectionalEdge, pairCompletionModel, distanceFromMid, dynamicMoveMax };
          }
          if (!Number.isFinite(effectiveDirectionalEdge) || effectiveDirectionalEdge < Number(cfg.BEAT_PROBABILITY_REQUIRED_EDGE)) {
            return { side, leg, affordable: false, maxPrice: null, reason: 'probability-edge-too-small', sideProbability, directionalEdge, effectiveDirectionalEdge, pairCompletionModel, distanceFromMid, dynamicMoveMax };
          }
          if (absoluteMove > dynamicMoveMax) {
            return { side, leg, affordable: false, maxPrice: null, reason: 'move-above-dynamic-cap', sideProbability, directionalEdge, effectiveDirectionalEdge, pairCompletionModel, distanceFromMid, dynamicMoveMax };
          }
        }
        const maxPrice = clampMaxPrice(leg.ask.price, 1, cfg.BEAT_MAX_SLIPPAGE);
        if (maxPrice + 1e-9 < leg.ask.price) {
          return { side, leg, affordable: false, maxPrice, reason: 'clamped-price-below-ask', sideProbability, directionalEdge, effectiveDirectionalEdge, pairCompletionModel, distanceFromMid, dynamicMoveMax };
        }
        return { side, leg, affordable: true, maxPrice, reason: null, sideProbability, directionalEdge, effectiveDirectionalEdge, pairCompletionModel, distanceFromMid, dynamicMoveMax };
      }));

    const pairCandidates = (await Promise.all([
      this._buildArbPairCandidate('Up', {
        tokenId: this.market.upToken.tokenId,
        book: this.latestQuotes.up?.book ?? null,
        bid: this.latestQuotes.up?.bid ?? null,
        ask: this.latestQuotes.up?.ask ?? null,
        bookAgeMs: bookAgeMs(this.latestQuotes.up?.book),
      }, snapshot),
      this._buildArbPairCandidate('Down', {
        tokenId: this.market.downToken.tokenId,
        book: this.latestQuotes.down?.book ?? null,
        bid: this.latestQuotes.down?.bid ?? null,
        ask: this.latestQuotes.down?.ask ?? null,
        bookAgeMs: bookAgeMs(this.latestQuotes.down?.book),
      }, snapshot),
    ])).filter(Boolean);

    const affordableLegs = candidateLegs.filter((entry) => entry.affordable);
    if (!affordableLegs.length && !pairCandidates.length) {
      this._recordAudit('decision_skip', {
        reason: 'no-affordable-side-or-pair',
        delta,
        absoluteMove,
        moment,
        bookState,
        candidateLegs: candidateLegs.map((entry) => ({
          side: entry.side,
          reason: entry.reason,
          askPrice: entry.leg.ask?.price ?? null,
          bookAgeMs: entry.leg.bookAgeMs ?? null,
          minDistanceFromMid: entry.leg.minDistanceFromMid ?? null,
          distanceFromMid: entry.distanceFromMid ?? null,
          dynamicMoveMax: entry.dynamicMoveMax ?? null,
          maxPrice: entry.maxPrice,
          sideProbability: entry.sideProbability ?? null,
          directionalEdge: entry.directionalEdge ?? null,
          effectiveDirectionalEdge: entry.effectiveDirectionalEdge ?? null,
          pairCompletionModel: entry.pairCompletionModel ?? null,
        })),
        probabilityModel,
      });
      return;
    }

    const selectedLegs = affordableLegs
      .sort((a, b) => {
        const aEdge = Number.isFinite(a.effectiveDirectionalEdge) ? -a.effectiveDirectionalEdge : Infinity;
        const bEdge = Number.isFinite(b.effectiveDirectionalEdge) ? -b.effectiveDirectionalEdge : Infinity;
        if (aEdge !== bEdge) return aEdge - bEdge;
        const askDiff = Number(a.leg.ask?.price ?? Infinity) - Number(b.leg.ask?.price ?? Infinity);
        if (askDiff !== 0) return askDiff;
        return String(a.side).localeCompare(String(b.side));
      });

    const directionalCandidates = [];
    for (const selected of selectedLegs) {
      const leg = selected.leg;
      const chosenSide = selected.side;
      const ofiDecision = this.ofi.decisionFor(
        leg.tokenId,
        Number(leg.book?.tickSize ?? 0.01),
        Date.now(),
      );
      if (ofiDecision.suppress) {
        this._recordAudit('decision_skip', {
          reason: 'ofi-suppressed',
          secondsAfterOpen,
          chosenSide,
          delta,
          absoluteMove,
          beatPrice: this.beatPrice,
          btcPrice: tick.price,
          moment,
          ofiDecision,
          probabilityModel,
        });
        continue;
      }

      const softenedMaxPrice = Math.max(0, selected.maxPrice - ofiDecision.adjustPrice);
      if (softenedMaxPrice + 1e-9 < Number(leg.ask?.price ?? Infinity)) {
        this._recordAudit('decision_skip', {
          reason: 'ofi-softened-price-below-ask',
          secondsAfterOpen,
          chosenSide,
          delta,
          absoluteMove,
          beatPrice: this.beatPrice,
          btcPrice: tick.price,
          moment,
          ofiDecision,
          askPrice: leg.ask?.price ?? null,
          originalMaxPrice: selected.maxPrice,
          softenedMaxPrice,
          probabilityModel,
        });
        continue;
      }

      const plan = this._buildDirectionalPlan({
        side: chosenSide,
        tokenId: leg.tokenId,
        book: leg.book,
        bestBid: leg.bid,
        bestAsk: leg.ask,
        maxPrice: softenedMaxPrice,
        delta,
        btcPrice: tick.price,
      });
      if (!plan) {
        continue;
      }

      const futurePairViability = await this._directionalFuturePairTradeViability({
        side: chosenSide,
        plan,
      });
      if (!futurePairViability?.viable) {
        this._recordAudit('decision_skip', {
          reason: 'future-pair-trade-below-min-size',
          secondsAfterOpen,
          chosenSide,
          tokenId: leg.tokenId,
          delta,
          absoluteMove,
          beatPrice: this.beatPrice,
          btcPrice: tick.price,
          moment,
          plan,
          futurePairViability,
          probabilityModel,
        });
        continue;
      }

      directionalCandidates.push({
        intent: 'directional',
        side: chosenSide,
        tokenId: leg.tokenId,
        book: leg.book,
        bestBid: leg.bid,
        bestAsk: leg.ask,
        bookAgeMs: leg.bookAgeMs,
        maxPrice: softenedMaxPrice,
        plan,
        ofiDecision,
        sideProbability: selected.sideProbability ?? null,
        directionalEdge: selected.directionalEdge ?? null,
        effectiveDirectionalEdge: selected.effectiveDirectionalEdge ?? null,
        pairCompletionModel: selected.pairCompletionModel ?? null,
        futurePairViability,
        distanceFromMid: selected.distanceFromMid ?? null,
        dynamicMoveMax: selected.dynamicMoveMax ?? null,
      });
    }

    const batchCandidates = this._buildBuyBatch({
      directionalCandidates,
      pairCandidates,
      delta,
      btcPrice: tick.price,
      snapshot,
      probabilityModel,
      moment,
      candidateLegs,
      secondsAfterOpen,
      absoluteMove,
    });

    if (!batchCandidates.length) {
      return false;
    }

    if (cfg.BEAT_ORDER_MODE === 'USDC' && batchCandidates.length > 1) {
      return this._executeBuyBatch({
        candidates: batchCandidates,
        delta,
        btcPrice: tick.price,
        secondsAfterOpen,
        absoluteMove,
        moment,
        probabilityModel,
      });
    }

    let executedBuy = false;
    for (const selected of batchCandidates) {
      const spentBefore = this.totalSpent;
      const lastBuyAtBefore = this.lastBuyAt;
      if (selected.intent === 'arb-pair') {
        await this._executePairBuy(selected);
      } else {
        await this._executeBuy({
          side: selected.side,
          tokenId: selected.tokenId,
          book: selected.book,
          bestBid: selected.bestBid,
          bestAsk: selected.bestAsk,
          maxPrice: selected.maxPrice,
          delta,
          btcPrice: tick.price,
          precomputedPlan: selected.plan,
        });
      }
      if (this.totalSpent > spentBefore || this.lastBuyAt !== lastBuyAtBefore) {
        executedBuy = true;
      }
    }
    return executedBuy;
  }

  _buildDirectionalPlan({ side, tokenId, book, bestBid, bestAsk, maxPrice, delta, btcPrice }) {
    const cfg = this.config;
    const remainingBudget = cfg.MAX_SPEND_PER_MARKET - this.totalSpent;
    if (remainingBudget <= 1e-9) {
      this._recordAudit('decision_skip', {
        reason: 'max-spend-cap-reached',
        side,
        remainingBudget,
        totalSpent: this.totalSpent,
        maxSpendPerMarket: cfg.MAX_SPEND_PER_MARKET,
      });
      return null;
    }

    if (cfg.BEAT_ORDER_MODE === 'SHARES') {
      const minSharesRequired = this._minSharesRequired(book, maxPrice);
      const requestedShares = Math.min(
        cfg.BEAT_ORDER_SIZE_SHARES,
        remainingBudget / Math.max(bestAsk?.price ?? 0.0001, 0.0001),
      );
      if (requestedShares <= 0) {
        this._recordAudit('decision_skip', {
          reason: 'requested-shares-nonpositive',
          side,
          remainingBudget,
          bestAsk: bestAsk?.price ?? null,
          requestedShares,
        });
        return null;
      }
      if (requestedShares + 1e-9 < minSharesRequired) {
        this._recordAudit('decision_skip', {
          reason: 'requested-shares-below-minimum',
          side,
          requestedShares,
          minSharesRequired,
          bestAsk: bestAsk?.price ?? null,
          maxPrice,
        });
        return null;
      }

      const plan = estimateSharesFromBook(book, maxPrice, requestedShares);
      this._recordAudit('order_plan', {
        side,
        orderMode: cfg.BEAT_ORDER_MODE,
        tokenId,
        requestedShares,
        remainingBudget,
        maxPrice,
        bestBid: bestBid ?? null,
        bestAsk: bestAsk ?? null,
        delta,
        btcPrice,
        plan,
        book: summarizeBook(book),
      });
      if (!plan?.fullyFilled || plan.fillShares <= 0 || plan.spentUsdc <= 0) {
        this._recordAudit('decision_skip', {
          reason: 'share-plan-not-fillable',
          side,
          tokenId,
          requestedShares,
          plan,
          maxPrice,
        });
        return null;
      }
      if (plan.fillShares + 1e-9 < minSharesRequired) {
        this._recordAudit('decision_skip', {
          reason: 'share-plan-below-minimum',
          side,
          tokenId,
          minSharesRequired,
          plan,
          maxPrice,
        });
        return null;
      }
      return plan;
    }

    const minUsdcRequired = this._minUsdcRequired(book);
    const amountUsdc = Math.min(cfg.BEAT_ORDER_SIZE_USDC, remainingBudget);
    if (amountUsdc <= 0) {
      this._recordAudit('decision_skip', {
        reason: 'amount-usdc-nonpositive',
        side,
        remainingBudget,
        amountUsdc,
      });
      return null;
    }
    if (amountUsdc + 1e-9 < minUsdcRequired) {
      this._recordAudit('decision_skip', {
        reason: 'amount-usdc-below-minimum',
        side,
        amountUsdc,
        minUsdcRequired,
        remainingBudget,
      });
      return null;
    }

    const plan = ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, amountUsdc, 0);
    this._recordAudit('order_plan', {
      side,
      orderMode: cfg.BEAT_ORDER_MODE,
      tokenId,
      requestedUsdc: amountUsdc,
      remainingBudget,
      maxPrice,
      bestBid: bestBid ?? null,
      bestAsk: bestAsk ?? null,
      delta,
      btcPrice,
      plan,
      book: summarizeBook(book),
    });
    if (!plan || plan.fillShares <= 0 || plan.spentUsdc <= 0) {
      this._recordAudit('decision_skip', {
        reason: 'usdc-plan-not-fillable',
        side,
        tokenId,
        amountUsdc,
        plan,
        maxPrice,
      });
      return null;
    }
    if (plan.spentUsdc + 1e-9 < minUsdcRequired) {
      this._recordAudit('decision_skip', {
        reason: 'usdc-plan-below-minimum',
        side,
        tokenId,
        minUsdcRequired,
        amountUsdc,
        plan,
        maxPrice,
      });
      return null;
    }
    return plan;
  }

  async _directionalFuturePairTradeViability({ side, plan }) {
    const cfg = this.config;
    if (cfg.BEAT_ORDER_MODE !== 'USDC') {
      return { viable: true, reason: 'non-usdc-mode' };
    }

    const shares = Number(plan?.fillShares ?? 0);
    const avgPrice = Number(plan?.avgFillPrice ?? 0);
    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(avgPrice) || avgPrice <= 0) {
      return {
        viable: false,
        reason: 'missing-directional-fill-shares-or-price',
        shares,
        avgPrice,
      };
    }

    const oppositeSide = this._oppositeSide(side);
    const oppositeTokenId = oppositeSide === 'Up' ? this.market.upToken?.tokenId : this.market.downToken?.tokenId;
    const oppositeFeeRateBps = await this._getTokenTakerFeeBps(oppositeTokenId);
    const pairCostThreshold = this._pairCostThreshold();
    const targetOppositeAsk = this._maxFeeAdjustedPairBuyPrice(avgPrice, oppositeFeeRateBps, pairCostThreshold);
    if (!Number.isFinite(targetOppositeAsk) || targetOppositeAsk <= 0) {
      return {
        viable: false,
        reason: 'future-pair-target-unavailable',
        oppositeSide,
        shares,
        avgPrice,
        targetOppositeAsk,
        oppositeFeeRateBps,
        pairCostThreshold,
      };
    }

    const projectedPairSpentUsdc = shares * targetOppositeAsk;
    const requiredMinUsdc = Number(cfg.BEAT_ORDER_SIZE_USDC);
    return {
      viable: projectedPairSpentUsdc + 1e-9 >= requiredMinUsdc,
      reason: projectedPairSpentUsdc + 1e-9 >= requiredMinUsdc
        ? 'future-pair-trade-meets-min-size'
        : 'future-pair-trade-below-min-size',
      oppositeSide,
      shares,
      avgPrice,
      targetOppositeAsk,
      projectedPairSpentUsdc,
      requiredMinUsdc,
      oppositeFeeRateBps,
      pairCostThreshold,
    };
  }

  _projectedLotStateAfterBatch(buys = []) {
    const lotState = this._lotState();
    const totals = Array.isArray(buys)
      ? buys.reduce((acc, buy) => {
        const shares = Number(buy?.shares ?? 0);
        if (!Number.isFinite(shares) || shares <= 0) return acc;
        if (buy.side === 'Up') acc.up += shares;
        if (buy.side === 'Down') acc.down += shares;
        return acc;
      }, { up: 0, down: 0 })
      : { up: 0, down: 0 };

    const projectedUp = Math.max(0, Number(lotState.unpairedUpShares ?? 0) + totals.up);
    const projectedDown = Math.max(0, Number(lotState.unpairedDownShares ?? 0) + totals.down);
    const pairedNow = Math.min(projectedUp, projectedDown);
    return {
      unpairedUpShares: Math.max(0, projectedUp - projectedDown),
      unpairedDownShares: Math.max(0, projectedDown - projectedUp),
      imbalanceShares: Math.abs(projectedUp - projectedDown),
      pairedShares: Number(lotState.pairedShares ?? 0) + pairedNow,
      addedUpShares: totals.up,
      addedDownShares: totals.down,
    };
  }

  _batchWouldIncreaseImbalancePastCap(candidates = []) {
    const cap = Number(this.config.BEAT_MAX_INVENTORY_IMBALANCE_SHARES);
    if (!Number.isFinite(cap) || cap <= 0) return null;

    const currentLotState = this._lotState();
    const currentImbalanceShares = Math.abs(
      Number(currentLotState.unpairedUpShares ?? 0) - Number(currentLotState.unpairedDownShares ?? 0),
    );
    const projectedLotState = this._projectedLotStateAfterBatch(candidates.map((candidate) => ({
      side: candidate.side,
      shares: Number(candidate?.plan?.fillShares ?? 0),
    })));
    return {
      currentImbalanceShares,
      projectedImbalanceShares: projectedLotState.imbalanceShares,
      exceedsCap: projectedLotState.imbalanceShares - cap > 1e-9,
      increasesImbalance: projectedLotState.imbalanceShares - currentImbalanceShares > 1e-9,
      projectedLotState,
      maxInventoryImbalanceShares: cap,
    };
  }

  _buildBuyBatch({
    directionalCandidates = [],
    pairCandidates = [],
    delta,
    btcPrice,
    snapshot,
    probabilityModel,
    moment,
    candidateLegs,
    secondsAfterOpen,
    absoluteMove,
  }) {
    const cfg = this.config;
    const chosenBySide = new Map();

    for (const candidate of pairCandidates) {
      if (!candidate) continue;
      chosenBySide.set(candidate.side, candidate);
    }
    for (const candidate of directionalCandidates) {
      if (!candidate || chosenBySide.has(candidate.side)) continue;
      chosenBySide.set(candidate.side, candidate);
    }

    let batch = Array.from(chosenBySide.values());
    if (!batch.length) return [];

    const directionalCandidatesInBatch = batch
      .filter((candidate) => candidate.intent === 'directional')
      .sort((a, b) => Number(a.effectiveDirectionalEdge ?? 0) - Number(b.effectiveDirectionalEdge ?? 0));
    let remainingDirectionalBudget = cfg.MAX_SPEND_PER_MARKET - this.totalSpent;
    const keptDirectional = new Set();
    for (const candidate of directionalCandidatesInBatch.reverse()) {
      const spend = Number(candidate?.plan?.spentUsdc ?? 0);
      if (spend - remainingDirectionalBudget > 1e-9) {
        this._recordAudit('decision_skip', {
          reason: 'batch-max-spend-cap-would-be-exceeded',
          side: candidate.side,
          tokenId: candidate.tokenId,
          spend,
          remainingDirectionalBudget,
          effectiveDirectionalEdge: candidate.effectiveDirectionalEdge ?? null,
        });
        continue;
      }
      keptDirectional.add(candidate.side);
      remainingDirectionalBudget -= spend;
    }
    batch = batch.filter((candidate) => candidate.intent !== 'directional' || keptDirectional.has(candidate.side));
    if (!batch.length) return [];

    while (batch.length) {
      const imbalanceProjection = this._batchWouldIncreaseImbalancePastCap(batch);
      if (!imbalanceProjection?.exceedsCap || !imbalanceProjection?.increasesImbalance) {
        break;
      }

      const removable = [...batch].sort((a, b) => {
        const aPriority = a.intent === 'arb-pair' ? 1 : 0;
        const bPriority = b.intent === 'arb-pair' ? 1 : 0;
        if (aPriority !== bPriority) return aPriority - bPriority;
        const aScore = a.intent === 'arb-pair'
          ? Number(a.pairEdge ?? -Infinity)
          : Number(a.effectiveDirectionalEdge ?? -Infinity);
        const bScore = b.intent === 'arb-pair'
          ? Number(b.pairEdge ?? -Infinity)
          : Number(b.effectiveDirectionalEdge ?? -Infinity);
        return aScore - bScore;
      });
      const removed = removable[0];
      this._recordAudit('decision_skip', {
        reason: 'batch-inventory-imbalance-would-be-exceeded',
        side: removed.side,
        tokenId: removed.tokenId,
        intent: removed.intent,
        ...imbalanceProjection,
      });
      batch = batch.filter((candidate) => candidate !== removed);
    }

    if (!batch.length) {
      this._recordAudit('decision_skip', {
        reason: 'no-buyable-batch-after-batch-validation',
        delta,
        absoluteMove,
        moment,
        snapshot,
        probabilityModel,
      });
      return [];
    }

    this._recordAudit('decision_buy_signal', {
      secondsAfterOpen,
      delta,
      absoluteMove,
      beatPrice: this.beatPrice,
      btcPrice,
      moment,
      snapshot,
      probabilityModel,
      candidateLegs: candidateLegs.map((entry) => ({
        side: entry.side,
        affordable: entry.affordable,
        reason: entry.reason,
        askPrice: entry.leg.ask?.price ?? null,
        maxPrice: entry.maxPrice,
        sideProbability: entry.sideProbability ?? null,
        directionalEdge: entry.directionalEdge ?? null,
        effectiveDirectionalEdge: entry.effectiveDirectionalEdge ?? null,
      })),
      selectedBatch: batch.map((candidate) => ({
        intent: candidate.intent,
        side: candidate.side,
        tokenId: candidate.tokenId,
        maxPrice: candidate.maxPrice,
        fillShares: candidate.plan?.fillShares ?? null,
        spentUsdc: candidate.plan?.spentUsdc ?? null,
        effectiveDirectionalEdge: candidate.effectiveDirectionalEdge ?? null,
        pairEdge: candidate.pairEdge ?? null,
      })),
      batchImbalanceProjection: this._batchWouldIncreaseImbalancePastCap(batch),
    });

    return batch.sort((a, b) => {
      if (a.intent !== b.intent) return a.intent === 'arb-pair' ? -1 : 1;
      if (a.side !== b.side) return String(a.side).localeCompare(String(b.side));
      return Number(b.effectiveDirectionalEdge ?? b.pairEdge ?? 0) - Number(a.effectiveDirectionalEdge ?? a.pairEdge ?? 0);
    });
  }

  async _executeBuyBatch({ candidates, delta, btcPrice, secondsAfterOpen, absoluteMove, moment, probabilityModel }) {
    const cfg = this.config;
    const batch = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!batch.length) return false;

    this._recordAudit('order_batch_submit', {
      orderMode: cfg.BEAT_ORDER_MODE,
      candidateCount: batch.length,
      batch: batch.map((candidate) => ({
        intent: candidate.intent,
        side: candidate.side,
        tokenId: candidate.tokenId,
        maxPrice: candidate.maxPrice,
        fillShares: candidate.plan?.fillShares ?? null,
        spentUsdc: candidate.plan?.spentUsdc ?? null,
      })),
    });

    if (!cfg.BEAT_DRY_RUN) {
      try {
        const response = await ClobClient.postBatchIOCBuys(this.wallet, batch.map((candidate) => ({
          tokenId: candidate.tokenId,
          maxPrice: candidate.maxPrice,
          amountUsdc: candidate.plan.spentUsdc,
        })));
        this._recordAudit('order_batch_result', {
          orderMode: cfg.BEAT_ORDER_MODE,
          candidateCount: batch.length,
          response,
        });
      } catch (err) {
        this.log.warn('BeatTrader: directional batch buy failed', { err: err.message });
        this._recordAudit('order_batch_error', {
          err: err.message,
          stack: err.stack ?? null,
          orderMode: cfg.BEAT_ORDER_MODE,
          batch: batch.map((candidate) => ({
            intent: candidate.intent,
            side: candidate.side,
            tokenId: candidate.tokenId,
            maxPrice: candidate.maxPrice,
            spentUsdc: candidate.plan?.spentUsdc ?? null,
          })),
        });
        this._publishOrderIssue({
          tradeStatus: 'batch buy error',
          extra: {
            orderMode: cfg.BEAT_ORDER_MODE,
            err: err.message,
          },
        });
        return false;
      }
    }

    for (const candidate of batch) {
      if (candidate.intent === 'arb-pair') {
        const fills = Array.isArray(candidate.plan?.fills) && candidate.plan.fills.length
          ? candidate.plan.fills
          : [{
            price: candidate.plan.avgFillPrice,
            shares: candidate.plan.fillShares,
            spentUsdc: candidate.plan.spentUsdc,
            feeUsdc: 0,
          }];
        fills.forEach((fill, index) => {
          const spentUsdc = Number(fill?.spentUsdc ?? 0) + Math.max(0, Number(fill?.feeUsdc ?? 0));
          this._recordBuy(candidate.side, Number(fill?.price ?? 0), Number(fill?.shares ?? 0), spentUsdc, null, null, {
            intent: 'arb-pair',
            pairCostCap: cfg.BEAT_ARB_PAIR_COST_MAX,
            executionSource: cfg.BEAT_DRY_RUN ? 'dry-run-batch-estimate' : 'batch-estimated-plan',
            executionFillIndex: index + 1,
            executionFillCount: fills.length,
          });
        });
      } else {
        this._recordBuy(
          candidate.side,
          candidate.plan.avgFillPrice ?? candidate.bestAsk?.price ?? null,
          candidate.plan.fillShares,
          candidate.plan.spentUsdc,
          delta,
          btcPrice,
          {
            executionSource: cfg.BEAT_DRY_RUN ? 'dry-run-batch-estimate' : 'batch-estimated-plan',
            estimatedPlan: candidate.plan,
            batchIntent: 'directional',
          },
        );
      }
    }

    if (!cfg.BEAT_DRY_RUN) {
      await this._syncBalances(this.market.upToken.tokenId, this.market.downToken.tokenId);
    }

    this.lastBuyAt = Date.now();
    this._publishTrade({
      lifecycle: BEAT_LIFECYCLE.MONITORING,
      tradeStatus: cfg.BEAT_DRY_RUN ? 'dry-run batch buy placed' : 'batch buy placed',
      chosenSide: this.tradeSummary?.chosenSide ?? null,
      buyShares: this.tradeSummary?.buyShares ?? 0,
      buyUsdc: this.tradeSummary?.buyUsdc ?? 0,
      buyPrice: this.tradeSummary?.buyPrice ?? null,
    });
    this.log.info(`BeatTrader: ${cfg.BEAT_DRY_RUN ? 'dry-run batch buy' : 'batch buy executed'}`, {
      candidateCount: batch.length,
      orderMode: cfg.BEAT_ORDER_MODE,
      secondsAfterOpen,
      absoluteMove,
      delta,
      btcPrice,
      beatPrice: this.beatPrice,
      batch: batch.map((candidate) => ({
        intent: candidate.intent,
        side: candidate.side,
        spentUsdc: candidate.plan?.spentUsdc ?? null,
        fillShares: candidate.plan?.fillShares ?? null,
        maxPrice: candidate.maxPrice,
      })),
      probabilityModel: probabilityModel ? {
        pUp: probabilityModel.pUp,
        pDown: probabilityModel.pDown,
        pairCost: probabilityModel.pairCost,
      } : null,
      moment,
    });
    this._recordAudit('order_batch_filled', {
      orderMode: cfg.BEAT_ORDER_MODE,
      dryRun: cfg.BEAT_DRY_RUN,
      batch: batch.map((candidate) => ({
        intent: candidate.intent,
        side: candidate.side,
        tokenId: candidate.tokenId,
        maxPrice: candidate.maxPrice,
        plan: candidate.plan,
        pairEdge: candidate.pairEdge ?? null,
        effectiveDirectionalEdge: candidate.effectiveDirectionalEdge ?? null,
      })),
      balances: {
        up: this.balanceUp,
        down: this.balanceDown,
      },
      tradeSummary: this.tradeSummary,
    });
    return true;
  }



  async _executeBuy({ side, tokenId, book, bestBid, bestAsk, maxPrice, delta, btcPrice, precomputedPlan = null }) {
    const cfg = this.config;
    const remainingBudget = cfg.MAX_SPEND_PER_MARKET - this.totalSpent;
    if (remainingBudget <= 1e-9) {
      this._recordAudit('decision_skip', {
        reason: 'max-spend-cap-reached',
        side,
        remainingBudget,
        totalSpent: this.totalSpent,
        maxSpendPerMarket: cfg.MAX_SPEND_PER_MARKET,
      });
      return;
    }

    if (cfg.BEAT_ORDER_MODE === 'SHARES') {
      const minSharesRequired = this._minSharesRequired(book, maxPrice);
      const requestedShares = Math.min(
        cfg.BEAT_ORDER_SIZE_SHARES,
        remainingBudget / Math.max(bestAsk.price, 0.0001),
      );
      if (requestedShares <= 0) {
        this._recordAudit('decision_skip', {
          reason: 'requested-shares-nonpositive',
          side,
          remainingBudget,
          bestAsk: bestAsk?.price ?? null,
          requestedShares,
        });
        return;
      }
      if (requestedShares + 1e-9 < minSharesRequired) {
        this._recordAudit('decision_skip', {
          reason: 'requested-shares-below-minimum',
          side,
          requestedShares,
          minSharesRequired,
          bestAsk: bestAsk?.price ?? null,
          maxPrice,
        });
        return;
      }

      const plan = estimateSharesFromBook(book, maxPrice, requestedShares);
      this._recordAudit('order_plan', {
        side,
        orderMode: cfg.BEAT_ORDER_MODE,
        tokenId,
        requestedShares,
        remainingBudget,
        maxPrice,
        bestBid: bestBid ?? null,
        bestAsk: bestAsk ?? null,
        delta,
        btcPrice,
        plan,
        book: summarizeBook(book),
      });
      if (!plan.fullyFilled || plan.fillShares <= 0 || plan.spentUsdc <= 0) {
        this._recordAudit('decision_skip', {
          reason: 'share-plan-not-fillable',
          side,
          tokenId,
          requestedShares,
          plan,
          maxPrice,
        });
        return;
      }
      if (plan.fillShares + 1e-9 < minSharesRequired) {
        this._recordAudit('decision_skip', {
          reason: 'share-plan-below-minimum',
          side,
          tokenId,
          minSharesRequired,
          plan,
          maxPrice,
        });
        return;
      }
      if (plan.spentUsdc - remainingBudget > 1e-9) {
        this._recordAudit('decision_skip', {
          reason: 'max-spend-cap-would-be-exceeded',
          side,
          tokenId,
          remainingBudget,
          plan,
          maxSpendPerMarket: cfg.MAX_SPEND_PER_MARKET,
          totalSpent: this.totalSpent,
        });
        return;
      }
      const imbalanceProjection = this._wouldTradeIncreaseImbalancePastCap(side, plan.fillShares);
      if (imbalanceProjection?.exceedsCap && imbalanceProjection?.increasesImbalance) {
        this._recordAudit('decision_skip', {
          reason: 'inventory-imbalance-would-be-exceeded',
          side,
          tokenId,
          plan,
          ...imbalanceProjection,
        });
        return;
      }

      if (!cfg.BEAT_DRY_RUN) {
        try {
          this._recordAudit('order_submit', {
            side,
            orderMode: cfg.BEAT_ORDER_MODE,
            tokenId,
            maxPrice,
            shares: plan.fillShares,
          });
          const response = await ClobClient.postFOKLimitBuy(this.wallet, tokenId, maxPrice, plan.fillShares);
          this._recordAudit('order_result', {
            side,
            orderMode: cfg.BEAT_ORDER_MODE,
            tokenId,
            response,
          });
          if (response?.success === false) {
            this._recordAudit('decision_skip', {
              reason: 'share-order-rejected',
              side,
              tokenId,
              response,
            });
            this._publishOrderIssue({
              side,
              tradeStatus: 'buy rejected',
              extra: { tokenId, orderMode: cfg.BEAT_ORDER_MODE, response },
            });
            return;
          }
        } catch (err) {
          this.log.warn('BeatTrader: directional share buy failed', { side, err: err.message });
          this._recordAudit('order_error', {
            side,
            orderMode: cfg.BEAT_ORDER_MODE,
            tokenId,
            err: err.message,
            stack: err.stack ?? null,
          });
          this._publishOrderIssue({
            side,
            tradeStatus: 'buy error',
            extra: { tokenId, orderMode: cfg.BEAT_ORDER_MODE, err: err.message },
          });
          return;
        }
      }

      this._recordBuy(side, plan.spentUsdc / plan.fillShares, plan.fillShares, plan.spentUsdc, delta, btcPrice);
      this.lastBuyAt = Date.now();
      this._publishTrade({
        lifecycle: BEAT_LIFECYCLE.MONITORING,
        tradeStatus: cfg.BEAT_DRY_RUN ? 'dry-run buy placed' : 'buy placed',
        chosenSide: this.tradeSummary?.chosenSide ?? side,
        buyShares: this.tradeSummary?.buyShares ?? plan.fillShares,
        buyUsdc: this.tradeSummary?.buyUsdc ?? plan.spentUsdc,
        buyPrice: this.tradeSummary?.buyPrice ?? (plan.spentUsdc / plan.fillShares),
      });
      this.log.info(`BeatTrader: ${cfg.BEAT_DRY_RUN ? 'dry-run buy' : 'bought'} directional shares`, {
        side,
        shares: plan.fillShares,
        spentUsdc: plan.spentUsdc,
        avgPrice: plan.spentUsdc / plan.fillShares,
        bestBid: bestBid?.price ?? null,
        bestAsk: bestAsk.price,
        maxPrice,
        delta,
        btcPrice,
        beatPrice: this.beatPrice,
      });
      this._recordAudit('order_filled', {
        side,
        orderMode: cfg.BEAT_ORDER_MODE,
        tokenId,
        dryRun: cfg.BEAT_DRY_RUN,
        plan,
        maxPrice,
        delta,
        btcPrice,
        beatPrice: this.beatPrice,
        balances: {
          up: this.balanceUp,
          down: this.balanceDown,
        },
        tradeSummary: this.tradeSummary,
      });
      return;
    }

    const minUsdcRequired = this._minUsdcRequired(book);
    const amountUsdc = Math.min(cfg.BEAT_ORDER_SIZE_USDC, remainingBudget);
    if (amountUsdc <= 0) {
      this._recordAudit('decision_skip', {
        reason: 'amount-usdc-nonpositive',
        side,
        remainingBudget,
        amountUsdc,
      });
      return;
    }
    if (amountUsdc + 1e-9 < minUsdcRequired) {
      this._recordAudit('decision_skip', {
        reason: 'amount-usdc-below-minimum',
        side,
        amountUsdc,
        minUsdcRequired,
        remainingBudget,
      });
      return;
    }

    const plan = precomputedPlan ?? ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, amountUsdc, 0);
    this._recordAudit('order_plan', {
      side,
      orderMode: cfg.BEAT_ORDER_MODE,
      tokenId,
      requestedUsdc: amountUsdc,
      remainingBudget,
      maxPrice,
      bestBid: bestBid ?? null,
      bestAsk: bestAsk ?? null,
      delta,
      btcPrice,
      plan,
      book: summarizeBook(book),
    });
    if (!plan || plan.fillShares <= 0 || plan.spentUsdc <= 0) {
      this._recordAudit('decision_skip', {
        reason: 'usdc-plan-not-fillable',
        side,
        tokenId,
        amountUsdc,
        plan,
        maxPrice,
      });
      return;
    }
    if (plan.spentUsdc - remainingBudget > 1e-9) {
      this._recordAudit('decision_skip', {
        reason: 'max-spend-cap-would-be-exceeded',
        side,
        tokenId,
        remainingBudget,
        amountUsdc,
        plan,
        maxSpendPerMarket: cfg.MAX_SPEND_PER_MARKET,
        totalSpent: this.totalSpent,
      });
      return;
    }
    if (plan.spentUsdc + 1e-9 < minUsdcRequired) {
      this._recordAudit('decision_skip', {
        reason: 'usdc-plan-below-minimum',
        side,
        tokenId,
        minUsdcRequired,
        amountUsdc,
        plan,
        maxPrice,
      });
      return;
    }
    const imbalanceProjection = this._wouldTradeIncreaseImbalancePastCap(side, plan.fillShares);
    if (imbalanceProjection?.exceedsCap && imbalanceProjection?.increasesImbalance) {
      this._recordAudit('decision_skip', {
        reason: 'inventory-imbalance-would-be-exceeded',
        side,
        tokenId,
        amountUsdc,
        plan,
        ...imbalanceProjection,
      });
      return;
    }

    let actualExecution = null;
    if (!cfg.BEAT_DRY_RUN) {
      const preTokenBalance = side === 'Up' ? this.walletBalanceUp : this.walletBalanceDown;
      let preUsdcBalance = null;
      try {
        preUsdcBalance = await getUsdcBalance();
        this._recordAudit('order_submit', {
          side,
          orderMode: cfg.BEAT_ORDER_MODE,
          tokenId,
          maxPrice,
          requestedUsdc: amountUsdc,
        });
        const response = await ClobClient.postIOCBuy(this.wallet, tokenId, maxPrice, amountUsdc);
        this._recordAudit('order_result', {
          side,
          orderMode: cfg.BEAT_ORDER_MODE,
          tokenId,
          response,
        });
        if (response?.success === false) {
          this._recordAudit('decision_skip', {
            reason: 'usdc-order-rejected',
            side,
            tokenId,
            response,
          });
          this._publishOrderIssue({
            side,
            tradeStatus: 'buy rejected',
            extra: { tokenId, orderMode: cfg.BEAT_ORDER_MODE, response },
          });
          return;
        }
        actualExecution = await this._resolveActualUsdcBuyExecution({
          side,
          tokenId,
          requestedUsdc: amountUsdc,
          estimatedPlan: plan,
          preTokenBalance,
          preUsdcBalance,
          response,
        });
      } catch (err) {
        this.log.warn('BeatTrader: directional USDC buy failed', { side, err: err.message });
        this._recordAudit('order_error', {
          side,
          orderMode: cfg.BEAT_ORDER_MODE,
          tokenId,
          err: err.message,
          stack: err.stack ?? null,
        });
        this._publishOrderIssue({
          side,
          tradeStatus: 'buy error',
          extra: { tokenId, orderMode: cfg.BEAT_ORDER_MODE, err: err.message },
        });
        return;
      }
    }

    const execution = actualExecution ?? {
      fillShares: plan.fillShares,
      spentUsdc: plan.spentUsdc,
      avgFillPrice: plan.avgFillPrice ?? bestAsk.price,
      source: cfg.BEAT_DRY_RUN ? 'dry-run-estimate' : 'estimated-plan',
    };
    if (!Number.isFinite(execution.fillShares) || execution.fillShares <= 0 || !Number.isFinite(execution.spentUsdc) || execution.spentUsdc <= 0) {
      this._recordAudit('decision_skip', {
        reason: 'execution-empty-after-submit',
        side,
        tokenId,
        execution,
        estimatedPlan: plan,
      });
      this._publishOrderIssue({
        side,
        tradeStatus: 'buy empty fill',
        extra: { tokenId, orderMode: cfg.BEAT_ORDER_MODE, execution, estimatedPlan: plan },
      });
      return;
    }

    this._recordBuy(side, execution.avgFillPrice ?? bestAsk.price, execution.fillShares, execution.spentUsdc, delta, btcPrice, {
      executionSource: execution.source ?? null,
      estimatedPlan: plan,
    });
    this.lastBuyAt = Date.now();
    this._publishTrade({
      lifecycle: BEAT_LIFECYCLE.MONITORING,
      tradeStatus: cfg.BEAT_DRY_RUN ? 'dry-run buy placed' : 'buy placed',
      chosenSide: this.tradeSummary?.chosenSide ?? side,
      buyShares: this.tradeSummary?.buyShares ?? execution.fillShares,
      buyUsdc: this.tradeSummary?.buyUsdc ?? execution.spentUsdc,
      buyPrice: this.tradeSummary?.buyPrice ?? (execution.avgFillPrice ?? bestAsk.price),
    });
    this.log.info(`BeatTrader: ${cfg.BEAT_DRY_RUN ? 'dry-run buy' : 'bought'} directional USDC`, {
      side,
      requestedUsdc: amountUsdc,
      estimatedFillShares: plan.fillShares,
      estimatedSpentUsdc: plan.spentUsdc,
      actualFillShares: execution.fillShares,
      actualSpentUsdc: execution.spentUsdc,
      avgPrice: execution.avgFillPrice ?? plan.avgFillPrice,
      executionSource: execution.source ?? null,
      bestBid: bestBid?.price ?? null,
      bestAsk: bestAsk.price,
      maxPrice,
      delta,
      btcPrice,
      beatPrice: this.beatPrice,
    });
    this._recordAudit('order_filled', {
      side,
      orderMode: cfg.BEAT_ORDER_MODE,
      tokenId,
      dryRun: cfg.BEAT_DRY_RUN,
      plan,
      execution,
      maxPrice,
      delta,
      btcPrice,
      beatPrice: this.beatPrice,
      balances: {
        up: this.balanceUp,
        down: this.balanceDown,
      },
      tradeSummary: this.tradeSummary,
    });
  }

  _oppositeSide(side) {
    if (side === 'Up') return 'Down';
    if (side === 'Down') return 'Up';
    return null;
  }

  _lotState() {
    const sumShares = (side) => this.openLots[side].reduce((sum, lot) => sum + Number(lot?.remainingShares ?? 0), 0);
    const sumCost = (side) => this.openLots[side].reduce((sum, lot) => sum + (Number(lot?.remainingShares ?? 0) * Number(lot?.avgPrice ?? 0)), 0);
    const pairedShares = this.pairedLots.reduce((sum, lot) => sum + Number(lot?.shares ?? 0), 0);
    const pairedCost = this.pairedLots.reduce((sum, lot) => sum + Number(lot?.totalCost ?? 0), 0);
    const unpairedUpShares = sumShares('Up');
    const unpairedDownShares = sumShares('Down');
    return {
      pairedCount: this.pairedLots.length,
      pairedShares,
      pairedCost,
      averagePairedCost: pairedShares > 0 ? pairedCost / pairedShares : null,
      unpairedUpShares,
      unpairedDownShares,
      unpairedUpCost: sumCost('Up'),
      unpairedDownCost: sumCost('Down'),
    };
  }

  _eligiblePairLots(targetSide, buyPriceCap) {
    const oppositeSide = this._oppositeSide(targetSide);
    if (!oppositeSide) return [];
    const normalizedBuyPriceCap = Number(buyPriceCap);
    const pairCostCap = this._pairCostThreshold();
    const eligibleLots = this.openLots[oppositeSide]
      .filter((lot) => {
        const remainingShares = Number(lot?.remainingShares ?? 0);
        const lotPrice = Number(lot?.avgPrice ?? 0);
        return remainingShares > 0 &&
          Number.isFinite(lotPrice) &&
          (!Number.isFinite(normalizedBuyPriceCap) || (lotPrice + normalizedBuyPriceCap) <= pairCostCap);
      })
      .map((lot) => ({ ...lot }))
      .sort((a, b) => {
        const priceDiff = Number(b?.avgPrice ?? 0) - Number(a?.avgPrice ?? 0);
        if (Math.abs(priceDiff) > 1e-9) return priceDiff;
        return Number(a?.recordedAt ?? 0) - Number(b?.recordedAt ?? 0);
      });

    const groupedLots = [];
    for (const lot of eligibleLots) {
      const lotPrice = Number(lot?.avgPrice ?? 0);
      const lotShares = Number(lot?.remainingShares ?? 0);
      if (!Number.isFinite(lotPrice) || lotShares <= 1e-9) continue;
      const lastGroup = groupedLots[groupedLots.length - 1];
      if (lastGroup && Math.abs(Number(lastGroup.avgPrice ?? 0) - lotPrice) <= 1e-9) {
        lastGroup.remainingShares += lotShares;
        lastGroup.memberLots.push({
          id: lot.id,
          remainingShares: lotShares,
          avgPrice: lotPrice,
          recordedAt: Number(lot?.recordedAt ?? 0),
        });
        continue;
      }
      groupedLots.push({
        id: `price-group-${oppositeSide}-${lotPrice.toFixed(8)}`,
        oppositeSide,
        avgPrice: lotPrice,
        remainingShares: lotShares,
        memberLots: [{
          id: lot.id,
          remainingShares: lotShares,
          avgPrice: lotPrice,
          recordedAt: Number(lot?.recordedAt ?? 0),
        }],
      });
    }
    return groupedLots;
  }

  _pairCostThreshold() {
    const pairCostCap = Number(this.config.BEAT_ARB_PAIR_COST_MAX);
    if (Number.isFinite(pairCostCap)) return pairCostCap;
    return Infinity;
  }

  async _buildPerTradePairPlan(side, tokenId, book) {
    const asks = Array.isArray(book?.asks)
      ? [...book.asks]
        .filter((row) =>
          Number.isFinite(Number(row?.price)) &&
          Number.isFinite(Number(row?.size)) &&
          Number(row.price) > 0 &&
          Number(row.size) > 0)
        .sort((a, b) => Number(a.price) - Number(b.price))
      : [];
    if (!asks.length) return null;

    const pairCostCap = this._pairCostThreshold();
    const feeRateBps = await this._getTokenTakerFeeBps(tokenId);
    const eligibleLots = this._eligiblePairLots(side, Infinity)
      .map((group) => ({
        ...group,
        remainingShares: Number(group?.remainingShares ?? 0),
        avgPrice: Number(group?.avgPrice ?? 0),
        memberLots: Array.isArray(group?.memberLots)
          ? group.memberLots.map((lot) => ({
            ...lot,
            remainingShares: Number(lot?.remainingShares ?? 0),
            avgPrice: Number(lot?.avgPrice ?? 0),
          }))
          : [],
      }))
      .filter((group) => group.remainingShares > 1e-9 && Number.isFinite(group.avgPrice));
    if (!eligibleLots.length) return null;

    let fillShares = 0;
    let spentUsdc = 0;
    let totalPairCostUsdc = 0;
    let maxPrice = 0;
    const fills = [];
    const matches = [];

    for (const ask of asks) {
      let remainingAskShares = Number(ask.size);
      if (!Number.isFinite(remainingAskShares) || remainingAskShares <= 1e-9) continue;

      for (const group of eligibleLots) {
        if (remainingAskShares <= 1e-9) break;
        if (group.remainingShares <= 1e-9) continue;

        const askPrice = Number(ask.price);
        const pairCost = this._pairTotalUnitCost(group.avgPrice, askPrice, feeRateBps);
        if (!Number.isFinite(pairCost) || pairCost > pairCostCap) continue;

        const matchedShares = Math.min(group.remainingShares, remainingAskShares);
        if (matchedShares <= 1e-9) continue;

        const spentAtAsk = matchedShares * askPrice;
        const feeAtAsk = this._pairFeeUsdc(matchedShares, askPrice, feeRateBps);
        const pairCostUsdc = (matchedShares * Number(group.avgPrice)) + spentAtAsk + feeAtAsk;

        fillShares += matchedShares;
        spentUsdc += spentAtAsk;
        totalPairCostUsdc += pairCostUsdc;
        maxPrice = Math.max(maxPrice, askPrice);
        remainingAskShares -= matchedShares;
        group.remainingShares = roundShareAmount(group.remainingShares - matchedShares);

        fills.push({
          price: askPrice,
          shares: matchedShares,
          spentUsdc: spentAtAsk,
          feeUsdc: feeAtAsk,
        });
        matches.push({
          oppositeLotId: group.id,
          oppositeLotIds: group.memberLots.map((lot) => lot.id),
          oppositeSide: this._oppositeSide(side),
          oppositePrice: group.avgPrice,
          shares: matchedShares,
          pairCost,
          pairEdge: 1 - pairCost,
          feeUsdc: feeAtAsk,
        });
      }
    }

    if (fillShares <= 1e-9 || spentUsdc <= 0 || maxPrice <= 0) return null;

    const averagePairCost = totalPairCostUsdc / fillShares;
    return {
      fillShares,
      spentUsdc,
      avgFillPrice: spentUsdc / fillShares,
      fullyFilled: true,
      fills,
      maxPrice,
      feeRateBps,
      preview: {
        pairedShares: fillShares,
        totalCost: totalPairCostUsdc,
        averagePairCost,
        pairEdge: 1 - averagePairCost,
        expectedProfitUsdc: fillShares - totalPairCostUsdc,
        matches,
        feeRateBps,
      },
    };
  }

  async _pairingPreview(side, pairBuyPrice, targetShares = Infinity) {
    const remainingTarget = { value: Number.isFinite(Number(targetShares)) ? Math.max(0, Number(targetShares)) : Infinity };
    const oppositeSide = this._oppositeSide(side);
    const pairCostCap = this._pairCostThreshold();
    const tokenId = side === 'Up' ? this.market.upToken?.tokenId : this.market.downToken?.tokenId;
    const feeRateBps = await this._getTokenTakerFeeBps(tokenId);
    const matches = [];
    let pairedShares = 0;
    let totalCost = 0;

    for (const lot of this.openLots[oppositeSide]) {
      if (remainingTarget.value <= 1e-9) break;
      const lotShares = Number(lot?.remainingShares ?? 0);
      const lotPrice = Number(lot?.avgPrice ?? 0);
      const pairCost = this._pairTotalUnitCost(lotPrice, pairBuyPrice, feeRateBps);
      if (lotShares <= 1e-9 || !Number.isFinite(lotPrice) || !Number.isFinite(pairCost) || pairCost > pairCostCap) {
        continue;
      }
      const matchedShares = Math.min(lotShares, remainingTarget.value);
      if (matchedShares <= 1e-9) continue;
      pairedShares += matchedShares;
      totalCost += (matchedShares * lotPrice) + (matchedShares * pairBuyPrice) + this._pairFeeUsdc(matchedShares, pairBuyPrice, feeRateBps);
      remainingTarget.value = remainingTarget.value === Infinity ? Infinity : (remainingTarget.value - matchedShares);
      matches.push({
        oppositeLotId: lot.id,
        oppositeSide,
        oppositePrice: lotPrice,
        shares: matchedShares,
        pairCost,
      });
    }

    return {
      pairedShares,
      totalCost,
      averagePairCost: pairedShares > 0 ? totalCost / pairedShares : null,
      pairEdge: pairedShares > 0 ? (1 - (totalCost / pairedShares)) : null,
      matches,
      feeRateBps,
    };
  }

  async _buildArbPairCandidate(side, leg, snapshot = {}) {
    const cfg = this.config;
    if (!cfg.BEAT_ARB_PAIR_ENABLED) return null;
    if (!leg?.ask || !Number.isFinite(Number(leg.ask.price))) return null;
    if (!Number.isFinite(leg.bookAgeMs) || leg.bookAgeMs > cfg.BEAT_BOOK_MAX_AGE_MS) return null;

    const plan = await this._buildPerTradePairPlan(side, leg.tokenId, leg.book);
    if (!plan || plan.fillShares <= 1e-9 || plan.spentUsdc <= 0) return null;

    const preview = plan.preview;
    if (preview.pairedShares <= 1e-9) return null;

    return {
      intent: 'arb-pair',
      side,
      tokenId: leg.tokenId,
      book: leg.book,
      bestBid: leg.bid,
      bestAsk: leg.ask,
      bookAgeMs: leg.bookAgeMs,
      maxPrice: plan.maxPrice,
      targetShares: plan.fillShares,
      plan,
      preview,
      pairEdge: preview.pairEdge,
      snapshotAtMs: Number(snapshot.snapshotAtMs ?? Date.now()),
    };
  }

  async _maybeExecuteArbPair(snapshot = {}) {
    const cfg = this.config;
    if (!cfg.BEAT_ARB_PAIR_ENABLED) return false;

    const candidates = (await Promise.all([
      this._buildArbPairCandidate('Up', {
        tokenId: this.market.upToken.tokenId,
        book: this.latestQuotes.up?.book ?? null,
        bid: this.latestQuotes.up?.bid ?? null,
        ask: this.latestQuotes.up?.ask ?? null,
        bookAgeMs: bookAgeMs(this.latestQuotes.up?.book),
      }, snapshot),
      this._buildArbPairCandidate('Down', {
        tokenId: this.market.downToken.tokenId,
        book: this.latestQuotes.down?.book ?? null,
        bid: this.latestQuotes.down?.bid ?? null,
        ask: this.latestQuotes.down?.ask ?? null,
        bookAgeMs: bookAgeMs(this.latestQuotes.down?.book),
      }, snapshot),
    ])).filter(Boolean);

    if (!candidates.length) return false;

    const selected = candidates.sort((a, b) => {
      const profitDiff = Number(b.preview.expectedProfitUsdc ?? -Infinity) - Number(a.preview.expectedProfitUsdc ?? -Infinity);
      if (profitDiff !== 0) return profitDiff;
      const edgeDiff = Number(b.pairEdge ?? -Infinity) - Number(a.pairEdge ?? -Infinity);
      if (edgeDiff !== 0) return edgeDiff;
      const pairCostDiff = Number(a.preview.averagePairCost ?? Infinity) - Number(b.preview.averagePairCost ?? Infinity);
      if (pairCostDiff !== 0) return pairCostDiff;
      const shareDiff = Number(b.preview.pairedShares ?? 0) - Number(a.preview.pairedShares ?? 0);
      if (shareDiff !== 0) return shareDiff;
      return Number(a.bestAsk?.price ?? Infinity) - Number(b.bestAsk?.price ?? Infinity);
    })[0];

    this._recordAudit('arb_pair_candidate', {
      side: selected.side,
      pairCostCap: cfg.BEAT_ARB_PAIR_COST_MAX,
      targetShares: selected.targetShares,
      bestAsk: selected.bestAsk?.price ?? null,
      maxPrice: selected.maxPrice,
      pairEdge: selected.pairEdge,
      preview: selected.preview,
      bookAgeMs: selected.bookAgeMs,
      lotState: this._lotState(),
    });

    return this._executePairBuy(selected);
  }

  async _executePairBuy(candidate) {
    const cfg = this.config;
    const plan = candidate?.plan;
    if (!plan || Number(plan.fillShares ?? 0) <= 1e-9) {
      return false;
    }

    this._recordAudit('order_plan', {
      side: candidate.side,
      orderMode: 'ARB_PAIR_USDC',
      tokenId: candidate.tokenId,
      requestedShares: plan.fillShares,
      requestedUsdc: plan.spentUsdc,
      maxPrice: candidate.maxPrice,
      bestBid: candidate.bestBid ?? null,
      bestAsk: candidate.bestAsk ?? null,
      pairPreview: candidate.preview,
      pairEdge: candidate.pairEdge,
      plan,
      lotState: this._lotState(),
      book: summarizeBook(candidate.book),
    });
    if (!plan || plan.fillShares <= 1e-9 || plan.spentUsdc <= 0) {
      this._recordAudit('decision_skip', {
        reason: 'arb-pair-plan-not-fillable',
        side: candidate.side,
        tokenId: candidate.tokenId,
        targetShares: candidate.targetShares,
        maxPrice: candidate.maxPrice,
        plan,
      });
      return false;
    }

    let actualExecution = null;
    if (!cfg.BEAT_DRY_RUN) {
      const preTokenBalance = candidate.side === 'Up' ? this.walletBalanceUp : this.walletBalanceDown;
      let preUsdcBalance = null;
      try {
        preUsdcBalance = await getUsdcBalance();
        this._recordAudit('order_submit', {
          side: candidate.side,
          orderMode: 'ARB_PAIR_USDC',
          tokenId: candidate.tokenId,
          maxPrice: candidate.maxPrice,
          requestedUsdc: plan.spentUsdc,
        });
        const response = await ClobClient.postIOCBuy(this.wallet, candidate.tokenId, candidate.maxPrice, plan.spentUsdc);
        this._recordAudit('order_result', {
          side: candidate.side,
          orderMode: 'ARB_PAIR_USDC',
          tokenId: candidate.tokenId,
          response,
        });
        if (response?.success === false) {
          this._recordAudit('decision_skip', {
            reason: 'arb-pair-order-rejected',
            side: candidate.side,
            tokenId: candidate.tokenId,
            response,
          });
          this._publishOrderIssue({
            side: candidate.side,
            tradeStatus: 'arb pair rejected',
            extra: { tokenId: candidate.tokenId, orderMode: 'ARB_PAIR_USDC', response },
          });
          return false;
        }
        actualExecution = await this._resolveActualUsdcBuyExecution({
          side: candidate.side,
          tokenId: candidate.tokenId,
          requestedUsdc: plan.spentUsdc,
          estimatedPlan: plan,
          preTokenBalance,
          preUsdcBalance,
          response,
        });
      } catch (err) {
        this.log.warn('BeatTrader: arb pair buy failed', { side: candidate.side, err: err.message });
        this._recordAudit('order_error', {
          side: candidate.side,
          orderMode: 'ARB_PAIR_USDC',
          tokenId: candidate.tokenId,
          err: err.message,
          stack: err.stack ?? null,
        });
        this._publishOrderIssue({
          side: candidate.side,
          tradeStatus: 'arb pair error',
          extra: { tokenId: candidate.tokenId, orderMode: 'ARB_PAIR_USDC', err: err.message },
        });
        return false;
      }
    }

    const execution = actualExecution ?? {
      fillShares: plan.fillShares,
      spentUsdc: plan.spentUsdc,
      avgFillPrice: plan.avgFillPrice,
      fills: plan.fills,
      source: cfg.BEAT_DRY_RUN ? 'dry-run-estimate' : 'estimated-plan',
    };
    if (!Number.isFinite(execution.fillShares) || execution.fillShares <= 0 || !Number.isFinite(execution.spentUsdc) || execution.spentUsdc <= 0) {
      this._recordAudit('decision_skip', {
        reason: 'arb-pair-empty-after-submit',
        side: candidate.side,
        tokenId: candidate.tokenId,
        execution,
        estimatedPlan: plan,
      });
      this._publishOrderIssue({
        side: candidate.side,
        tradeStatus: 'arb pair empty fill',
        extra: { tokenId: candidate.tokenId, orderMode: 'ARB_PAIR_USDC', execution, estimatedPlan: plan },
      });
      return false;
    }

    const executionFills = Array.isArray(execution.fills) && execution.fills.length
      ? execution.fills
      : [{
        price: execution.avgFillPrice ?? (execution.spentUsdc / execution.fillShares),
        shares: execution.fillShares,
        spentUsdc: execution.spentUsdc,
      }];
    executionFills.forEach((fill, index) => {
      const fillPrice = Number(fill?.price);
      const fillShares = Number(fill?.shares);
      const fillSpentUsdc = Number(fill?.spentUsdc);
      const fillFeeUsdc = Number(fill?.feeUsdc ?? 0);
      if (!Number.isFinite(fillPrice) || !Number.isFinite(fillShares) || !Number.isFinite(fillSpentUsdc) || fillPrice <= 0 || fillShares <= 0 || fillSpentUsdc <= 0) {
        return;
      }
      this._recordBuy(candidate.side, fillPrice, fillShares, fillSpentUsdc + (Number.isFinite(fillFeeUsdc) && fillFeeUsdc > 0 ? fillFeeUsdc : 0), null, null, {
        intent: 'arb-pair',
        pairCostCap: cfg.BEAT_ARB_PAIR_COST_MAX,
        executionSource: execution.source ?? null,
        executionFillIndex: index + 1,
        executionFillCount: executionFills.length,
      });
    });
    this.lastBuyAt = Date.now();
    this._publishTrade({
      lifecycle: BEAT_LIFECYCLE.MONITORING,
      tradeStatus: cfg.BEAT_DRY_RUN ? 'dry-run buy placed' : 'buy placed',
      chosenSide: this.tradeSummary?.chosenSide ?? candidate.side,
      buyShares: this.tradeSummary?.buyShares ?? execution.fillShares,
      buyUsdc: this.tradeSummary?.buyUsdc ?? execution.spentUsdc,
      buyPrice: this.tradeSummary?.buyPrice ?? (execution.avgFillPrice ?? (execution.spentUsdc / execution.fillShares)),
    });
    this.log.info(`BeatTrader: ${cfg.BEAT_DRY_RUN ? 'dry-run arb pair buy' : 'arb pair buy executed'}`, {
      side: candidate.side,
      shares: execution.fillShares,
      spentUsdc: execution.spentUsdc,
      avgPrice: execution.avgFillPrice ?? (execution.spentUsdc / execution.fillShares),
      pairCostCap: cfg.BEAT_ARB_PAIR_COST_MAX,
      projectedAveragePairCost: candidate.preview.averagePairCost,
      pairEdge: candidate.pairEdge,
    });
    this._recordAudit('order_filled', {
      side: candidate.side,
      orderMode: 'ARB_PAIR_USDC',
      tokenId: candidate.tokenId,
      dryRun: cfg.BEAT_DRY_RUN,
      maxPrice: candidate.maxPrice,
      plan,
      execution,
      pairPreview: candidate.preview,
      pairEdge: candidate.pairEdge,
      lotState: this._lotState(),
      tradeSummary: this.tradeSummary,
    });
    return true;
  }

  _pairNewLot(newLot) {
    const oppositeSide = this._oppositeSide(newLot.side);
    const pairCostCap = this._pairCostThreshold();
    if (!oppositeSide || !Number.isFinite(pairCostCap)) {
      this.openLots[newLot.side].push(newLot);
      return [];
    }

    const pairEvents = [];
    for (const lot of this.openLots[oppositeSide]) {
      if (newLot.remainingShares <= 1e-9) break;
      const lotPrice = Number(lot?.avgPrice ?? 0);
      if (Number(lot?.remainingShares ?? 0) <= 1e-9 || !Number.isFinite(lotPrice)) continue;
      if ((lotPrice + newLot.avgPrice) > pairCostCap) continue;

      const matchedShares = Math.min(Number(lot.remainingShares ?? 0), newLot.remainingShares);
      if (matchedShares <= 1e-9) continue;

      lot.remainingShares = roundShareAmount(Number(lot.remainingShares ?? 0) - matchedShares);
      newLot.remainingShares = roundShareAmount(newLot.remainingShares - matchedShares);

      const upLot = newLot.side === 'Up' ? newLot : lot;
      const downLot = newLot.side === 'Down' ? newLot : lot;
      const totalCost = matchedShares * (Number(upLot.avgPrice ?? 0) + Number(downLot.avgPrice ?? 0));
      pairEvents.push({
        id: `pair-${this.nextPairId}`,
        shares: matchedShares,
        totalCost,
        averagePairCost: totalCost / matchedShares,
        upLotId: upLot.id,
        upPrice: upLot.avgPrice,
        downLotId: downLot.id,
        downPrice: downLot.avgPrice,
        pairedAt: Date.now(),
      });
      this.nextPairId += 1;
    }

    this.openLots[oppositeSide] = this.openLots[oppositeSide].filter((lot) => Number(lot?.remainingShares ?? 0) > 1e-9);
    if (newLot.remainingShares > 1e-9) {
      this.openLots[newLot.side].push(newLot);
    }
    this.pairedLots.push(...pairEvents);
    return pairEvents;
  }

  _recordBuy(side, avgPrice, shares, spentOverride = null, moveAtBuyUsd = null, btcPriceAtBuy = null, meta = {}) {
    const spentUsdc = spentOverride ?? (avgPrice * shares);
    this.totalSpent += spentUsdc;
    if (side === 'Up') this.balanceUp += shares;
    else this.balanceDown += shares;
    this.pnl.recordBuy(this.market.slug, side, avgPrice, shares);
    const newLot = {
      id: `buy-${this.nextBuyLotId}`,
      side,
      avgPrice,
      originalShares: shares,
      remainingShares: shares,
      spentUsdc,
      recordedAt: Date.now(),
    };
    this.nextBuyLotId += 1;
    const pairEvents = this._pairNewLot(newLot);
    const lotState = this._lotState();

    if (!this.tradeSummary) {
      this.tradeSummary = {
        chosenSide: side,
        buyShares: 0,
        buyUsdc: 0,
        buyPrice: 0,
        buyCount: 0,
        buyEvents: [],
        moveAtBuyUsd: null,
        moveAtBuyPct: null,
        btcPriceAtBuy: null,
        pairedShares: 0,
        pairedCostUsdc: 0,
        averagePairedCost: null,
        unpairedUpShares: 0,
        unpairedDownShares: 0,
        pairEvents: [],
      };
    }
    if (this.tradeSummary.chosenSide !== side) {
      this.tradeSummary.chosenSide = 'Mixed';
    }
    this.tradeSummary.buyShares += shares;
    this.tradeSummary.buyUsdc += spentUsdc;
    this.tradeSummary.buyCount += 1;
    this.tradeSummary.buyPrice = this.tradeSummary.buyUsdc / this.tradeSummary.buyShares;
    this.tradeSummary.tradeOccurred = true;
    this.tradeSummary.buyEvents.push({
      id: newLot.id,
      intent: meta?.intent === 'arb-pair' ? 'pair-buy' : 'directional-buy',
      side,
      shares,
      usdc: spentUsdc,
      price: avgPrice,
      moveAtBuyUsd,
      moveAtBuyPct: moveAtBuyUsd != null && this.beatPrice
        ? (moveAtBuyUsd / this.beatPrice) * 100
        : null,
      btcPriceAtBuy,
      recordedAt: Date.now(),
    });
    this.tradeSummary.moveAtBuyUsd = moveAtBuyUsd ?? this.tradeSummary.moveAtBuyUsd;
    this.tradeSummary.moveAtBuyPct = moveAtBuyUsd != null && this.beatPrice
      ? (moveAtBuyUsd / this.beatPrice) * 100
      : this.tradeSummary.moveAtBuyPct;
    this.tradeSummary.btcPriceAtBuy = btcPriceAtBuy ?? this.tradeSummary.btcPriceAtBuy;
    this.tradeSummary.pairedShares = lotState.pairedShares;
    this.tradeSummary.pairedCostUsdc = lotState.pairedCost;
    this.tradeSummary.averagePairedCost = lotState.averagePairedCost;
    this.tradeSummary.unpairedUpShares = lotState.unpairedUpShares;
    this.tradeSummary.unpairedDownShares = lotState.unpairedDownShares;
    if (pairEvents.length) {
      this.tradeSummary.pairEvents.push(...pairEvents);
    }
    this._recordAudit('buy_recorded', {
      side,
      avgPrice,
      shares,
      spentUsdc,
      moveAtBuyUsd,
      btcPriceAtBuy,
      balanceUp: this.balanceUp,
      balanceDown: this.balanceDown,
      totalSpent: this.totalSpent,
      meta,
      pairEvents,
      lotState,
      tradeSummary: this.tradeSummary,
    });
  }

  _checkCircuitBreakers() {
    if (this.halted) return true;

    return false;
  }

  _buyReducesImbalance(side) {
    const lotState = this._lotState();
    const imbalance = lotState.unpairedUpShares - lotState.unpairedDownShares;
    if (side === 'Up') return imbalance < -1e-9;
    if (side === 'Down') return imbalance > 1e-9;
    return false;
  }

  _projectedLotStateAfterBuy(side, shares) {
    const lotState = this._lotState();
    const buyShares = Number(shares);
    if (!Number.isFinite(buyShares) || buyShares <= 0) {
      return null;
    }

    let pairedShares = Number(lotState.pairedShares ?? 0);
    let unpairedUpShares = Number(lotState.unpairedUpShares ?? 0);
    let unpairedDownShares = Number(lotState.unpairedDownShares ?? 0);

    if (side === 'Up') {
      const pairedNow = Math.min(unpairedDownShares, buyShares);
      pairedShares += pairedNow;
      unpairedDownShares -= pairedNow;
      unpairedUpShares += Math.max(0, buyShares - pairedNow);
    } else if (side === 'Down') {
      const pairedNow = Math.min(unpairedUpShares, buyShares);
      pairedShares += pairedNow;
      unpairedUpShares -= pairedNow;
      unpairedDownShares += Math.max(0, buyShares - pairedNow);
    } else {
      return null;
    }

    const imbalanceShares = Math.abs(unpairedUpShares - unpairedDownShares);
    return {
      pairedShares,
      unpairedUpShares,
      unpairedDownShares,
      imbalanceShares,
    };
  }

  _wouldTradeIncreaseImbalancePastCap(side, shares) {
    const cap = Number(this.config.BEAT_MAX_INVENTORY_IMBALANCE_SHARES);
    if (!Number.isFinite(cap) || cap <= 0) return null;

    const currentLotState = this._lotState();
    const currentImbalanceShares = Math.abs(
      Number(currentLotState.unpairedUpShares ?? 0) - Number(currentLotState.unpairedDownShares ?? 0),
    );
    const projectedLotState = this._projectedLotStateAfterBuy(side, shares);
    if (!projectedLotState) return null;

    return {
      currentImbalanceShares,
      projectedImbalanceShares: projectedLotState.imbalanceShares,
      exceedsCap: projectedLotState.imbalanceShares - cap > 1e-9,
      increasesImbalance: projectedLotState.imbalanceShares - currentImbalanceShares > 1e-9,
      projectedLotState,
      maxInventoryImbalanceShares: cap,
    };
  }

  _minUsdcRequired(book = null) {
    const cfgMin = Number(this.config.BEAT_MIN_BUY_USDC);
    const values = [cfgMin].filter((value) => Number.isFinite(value) && value > 0);
    return values.length ? Math.max(...values) : 0;
  }

  _minSharesRequired(book = null, price = null) {
    const cfgMin = Number(this.config.BEAT_MIN_BUY_SHARES);
    const values = [cfgMin].filter((value) => Number.isFinite(value) && value > 0);
    return values.length ? Math.max(...values) : 0;
  }

  _simulatePnlAfterBuy(side, shares, spentUsdc) {
    const lotState = this._lotState();
    const buyShares = Number(shares);
    const buySpentUsdc = Number(spentUsdc);
    if (!Number.isFinite(buyShares) || !Number.isFinite(buySpentUsdc) || buyShares <= 0 || buySpentUsdc <= 0) {
      return null;
    }

    let pairedShares = Number(lotState.pairedShares ?? 0);
    let unpairedUpShares = Number(lotState.unpairedUpShares ?? 0);
    let unpairedDownShares = Number(lotState.unpairedDownShares ?? 0);

    if (side === 'Up') {
      const pairedNow = Math.min(unpairedDownShares, buyShares);
      pairedShares += pairedNow;
      unpairedDownShares -= pairedNow;
      unpairedUpShares += Math.max(0, buyShares - pairedNow);
    } else if (side === 'Down') {
      const pairedNow = Math.min(unpairedUpShares, buyShares);
      pairedShares += pairedNow;
      unpairedUpShares -= pairedNow;
      unpairedDownShares += Math.max(0, buyShares - pairedNow);
    } else {
      return null;
    }

    const totalSpent = this.totalSpent + buySpentUsdc;
    const pnlIfUp = pairedShares + unpairedUpShares - totalSpent;
    const pnlIfDown = pairedShares + unpairedDownShares - totalSpent;
    const positiveBoth = pnlIfUp > 0 && pnlIfDown > 0;

    return {
      pairedShares,
      unpairedUpShares,
      unpairedDownShares,
      totalSpent,
      pnlIfUp,
      pnlIfDown,
      positiveBoth,
    };
  }

  _findPositivePnlOverridePlan({ side, book, maxPrice }) {
    const cfg = this.config;
    const fractions = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05];

    if (cfg.BEAT_ORDER_MODE === 'SHARES') {
      const baseShares = Number(cfg.BEAT_ORDER_SIZE_SHARES);
      const minSharesRequired = this._minSharesRequired(book, maxPrice);
      if (!Number.isFinite(baseShares) || baseShares <= 0) {
        return null;
      }
      for (const fraction of fractions) {
        const requestedShares = Math.max(0, baseShares * fraction);
        if (requestedShares + 1e-9 < minSharesRequired) {
          continue;
        }
        const plan = estimateSharesFromBook(book, maxPrice, requestedShares);
        if (!plan?.fullyFilled || plan.fillShares <= 0 || plan.spentUsdc <= 0 || plan.fillShares + 1e-9 < minSharesRequired) {
          continue;
        }
        const simulation = this._simulatePnlAfterBuy(side, plan.fillShares, plan.spentUsdc);
        if (simulation?.positiveBoth) {
          return {
            mode: 'SHARES',
            requestedShares,
            plan,
            simulation,
          };
        }
      }
      return null;
    }

    const baseUsdc = Number(cfg.BEAT_ORDER_SIZE_USDC);
    const minUsdcRequired = this._minUsdcRequired(book);
    if (!Number.isFinite(baseUsdc) || baseUsdc <= 0) {
      return null;
    }
    for (const fraction of fractions) {
      const requestedUsdc = Math.max(0.01, Math.round(baseUsdc * fraction * 100) / 100);
      if (requestedUsdc + 1e-9 < minUsdcRequired) {
        continue;
      }
      const plan = ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, requestedUsdc, 0);
      if (!plan || plan.fillShares <= 0 || plan.spentUsdc <= 0 || plan.spentUsdc + 1e-9 < minUsdcRequired) {
        continue;
      }
      const simulation = this._simulatePnlAfterBuy(side, plan.fillShares, plan.spentUsdc);
      if (simulation?.positiveBoth) {
        return {
          mode: 'USDC',
          requestedUsdc,
          plan,
          simulation,
        };
      }
    }
    return null;
  }

  _publishOrderIssue({ side = null, tradeStatus, extra = {} } = {}) {
    this._publishTrade({
      lifecycle: this.lifecycle ?? BEAT_LIFECYCLE.MONITORING,
      tradeStatus,
      chosenSide: side ?? this.tradeSummary?.chosenSide ?? null,
      buyShares: this.tradeSummary?.buyShares ?? 0,
      buyUsdc: this.tradeSummary?.buyUsdc ?? 0,
      buyPrice: this.tradeSummary?.buyPrice ?? null,
      ...extra,
    });
  }

  async _resolveActualUsdcBuyExecution({
    side,
    tokenId,
    requestedUsdc,
    estimatedPlan,
    preTokenBalance,
    preUsdcBalance,
    response = null,
  }) {
    const fallback = {
      fillShares: Number(estimatedPlan?.fillShares ?? 0),
      spentUsdc: Number(estimatedPlan?.spentUsdc ?? 0),
      avgFillPrice: Number(estimatedPlan?.avgFillPrice ?? 0) || null,
      source: 'estimated-plan',
      response,
    };

    const attempts = [0, 150, 350, 700];
    for (const delayMs of attempts) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      try {
        const [balances, usdcBalanceAfter] = await Promise.all([
          getTokenBalances([tokenId]),
          getUsdcBalance(),
        ]);
        const tokenBalanceAfter = Number(balances?.[tokenId]);
        const actualShares = Number.isFinite(tokenBalanceAfter)
          ? Math.max(0, tokenBalanceAfter - Number(preTokenBalance ?? 0))
          : 0;
        const actualSpentUsdc = Number.isFinite(usdcBalanceAfter)
          ? Math.max(0, Number(preUsdcBalance ?? 0) - usdcBalanceAfter)
          : 0;
        if (actualShares > 1e-9) {
          const spentUsdc = actualSpentUsdc > 1e-9
            ? actualSpentUsdc
            : Math.min(
                Number(requestedUsdc ?? 0),
                Number(estimatedPlan?.avgFillPrice ?? 0) > 0
                  ? actualShares * Number(estimatedPlan.avgFillPrice)
                  : Number(estimatedPlan?.spentUsdc ?? 0),
              );
          const avgFillPrice = spentUsdc > 1e-9 ? (spentUsdc / actualShares) : null;
          const fills = reconstructActualFillsFromEstimate(estimatedPlan, actualShares, spentUsdc);
          if (side === 'Up') {
            this.walletBalanceUp = tokenBalanceAfter;
            if (!this.config.BEAT_DRY_RUN) this.balanceUp = tokenBalanceAfter;
          } else if (side === 'Down') {
            this.walletBalanceDown = tokenBalanceAfter;
            if (!this.config.BEAT_DRY_RUN) this.balanceDown = tokenBalanceAfter;
          }
          this._recordAudit('live_fill_reconciled', {
            side,
            tokenId,
            delayMs,
            requestedUsdc,
            preTokenBalance,
            tokenBalanceAfter,
            preUsdcBalance,
            usdcBalanceAfter,
            actualShares,
            actualSpentUsdc,
            spentUsdc,
            avgFillPrice,
            fills,
            response,
          });
          return {
            fillShares: actualShares,
            spentUsdc,
            avgFillPrice,
            fills,
            source: 'wallet-balance-delta',
            response,
          };
        }
      } catch (err) {
        this._recordAudit('live_fill_reconcile_error', {
          side,
          tokenId,
          requestedUsdc,
          delayMs,
          err: err.message,
          response,
        });
      }
    }

    this._recordAudit('live_fill_reconciled_fallback', {
      side,
      tokenId,
      requestedUsdc,
      preTokenBalance,
      preUsdcBalance,
      estimatedPlan,
      response,
    });
    return fallback;
  }

  async _syncBalances(upTokenId, downTokenId) {
    try {
      const balances = await getTokenBalances([upTokenId, downTokenId]);
      this.walletBalanceUp = balances[upTokenId] ?? this.walletBalanceUp;
      this.walletBalanceDown = balances[downTokenId] ?? this.walletBalanceDown;
      if (!this.config.BEAT_DRY_RUN) {
        this.balanceUp = this.walletBalanceUp;
        this.balanceDown = this.walletBalanceDown;
      }
      this.log.debug('BeatTrader: balances synced', {
        up: this.balanceUp,
        down: this.balanceDown,
        walletUp: this.walletBalanceUp,
        walletDown: this.walletBalanceDown,
        dryRun: this.config.BEAT_DRY_RUN,
      });
      this._recordAudit('balances_synced', {
        upTokenId,
        downTokenId,
        up: this.balanceUp,
        down: this.balanceDown,
        walletUp: this.walletBalanceUp,
        walletDown: this.walletBalanceDown,
        dryRun: this.config.BEAT_DRY_RUN,
      });
    } catch (err) {
      this.log.warn('BeatTrader: balance sync failed', { err: err.message });
      this._recordAudit('balance_sync_error', {
        upTokenId,
        downTokenId,
        err: err.message,
      });
    }
  }

  async _redeemPhase(conditionId, windowClose) {
    const cfg = this.config;
    const redeemNotBeforeMs = (windowClose + cfg.REDEEM_DELAY_AFTER_CLOSE) * 1000;
    const waitMs = redeemNotBeforeMs - Date.now();
    if (waitMs > 0) {
      this.log.debug('BeatTrader: waiting for resolution window', { waitMs });
      this._recordAudit('wait_for_resolution', { waitMs, windowClose });
      await sleep(waitMs);
    }

    let resolvedMarket = null;
    let resolutionAttempt = 0;
    while (!resolvedMarket) {
      resolutionAttempt += 1;
      try {
        resolvedMarket = await waitForResolution(this.market, 400_000, 10_000);
      } catch (err) {
        this.log.warn('BeatTrader: resolution poll timed out, retrying', {
          attempt: resolutionAttempt,
          err: err.message,
        });
        this._recordAudit('resolution_timeout', {
          attempt: resolutionAttempt,
          err: err.message,
        });
        this._publishMarket({
          lifecycle: BEAT_LIFECYCLE.RESOLVING,
          settled: false,
          outcome: null,
          pnl: null,
          tradeStatus: `resolution pending (retry ${resolutionAttempt})`,
          chosenSide: this.tradeSummary?.chosenSide ?? null,
          buyShares: this.tradeSummary?.buyShares ?? 0,
          buyUsdc: this.tradeSummary?.buyUsdc ?? 0,
          buyPrice: this.tradeSummary?.buyPrice ?? null,
          tradeOccurred: Boolean(this.tradeSummary?.buyShares > 0),
        });
      }
    }

    const outcome = this._resolveOutcome(resolvedMarket);
    this.lastOutcome = outcome;
    const estimatedPayout = this._estimateSettlementPayout(resolvedMarket);
    if (!outcome || !Number.isFinite(estimatedPayout)) {
      this._recordAudit('settlement_pending', {
        reason: !outcome ? 'unknown-outcome' : 'unknown-payout',
        resolvedPayouts: resolvedMarket?.resolvedPayouts ?? null,
        outcome,
        estimatedPayout,
        balances: {
          up: this.balanceUp,
          down: this.balanceDown,
        },
        tradeSummary: this.tradeSummary,
      });
      this._publishMarket({
        lifecycle: BEAT_LIFECYCLE.RESOLVING,
        settled: false,
        outcome: null,
        pnl: null,
        tradeStatus: 'resolution pending',
        chosenSide: this.tradeSummary?.chosenSide ?? null,
        buyShares: this.tradeSummary?.buyShares ?? 0,
        buyUsdc: this.tradeSummary?.buyUsdc ?? 0,
        buyPrice: this.tradeSummary?.buyPrice ?? null,
        tradeOccurred: Boolean(this.tradeSummary?.buyShares > 0),
      });
      return false;
    }

    this.lastSettledAt = Date.now();
    const marketPnl = estimatedPayout - this.totalSpent;
    this._publishMarket({
      lifecycle: BEAT_LIFECYCLE.SETTLED,
      settled: true,
      settledAt: this.lastSettledAt,
      outcome,
      pnl: marketPnl,
      tradeStatus: this.tradeSummary?.buyShares > 0 ? 'settled' : 'settled without trade',
      chosenSide: this.tradeSummary?.chosenSide ?? null,
      buyShares: this.tradeSummary?.buyShares ?? 0,
      buyUsdc: this.tradeSummary?.buyUsdc ?? 0,
      buyPrice: this.tradeSummary?.buyPrice ?? null,
      tradeOccurred: Boolean(this.tradeSummary?.buyShares > 0),
    });
    this.onSettled?.({
      slug: this.market.slug,
      settledAt: this.lastSettledAt,
      outcome,
      pnl: marketPnl,
      tradeOccurred: Boolean(this.tradeSummary?.buyShares > 0),
    });
    this._recordAudit('settlement_evaluated', {
      outcome,
      estimatedPayout,
      marketPnl,
      resolvedPayouts: resolvedMarket?.resolvedPayouts ?? null,
      balances: {
        up: this.balanceUp,
        down: this.balanceDown,
      },
      tradeSummary: this.tradeSummary,
      lotState: this._lotState(),
    });

    const totalHeld = this.balanceUp + this.balanceDown;
    if (totalHeld < 0.001) {
      this.log.info('BeatTrader: no settled tokens held');
      this.pnl.recordRedeem(this.market.slug, estimatedPayout, 'none');
      this._recordAudit('settlement_payout_recorded', {
        reason: 'no-tokens-held',
        totalHeld,
        outcome,
        estimatedPayout,
      });
      this._publishMarket({
        lifecycle: BEAT_LIFECYCLE.SETTLED,
        settled: true,
        settledAt: this.lastSettledAt,
        outcome,
        pnl: marketPnl,
        tradeStatus: this.tradeSummary?.buyShares > 0 ? 'settled' : 'settled without trade',
      });
      return true;
    }

    this.settledPayoutUsdc += estimatedPayout;
    this.pnl.recordRedeem(this.market.slug, estimatedPayout, 'external-auto-redeem');
    this.log.info('BeatTrader: external settlement payout assumed', {
      outcome,
      estimatedPayout,
      marketPnl,
      upHeld: this.balanceUp,
      downHeld: this.balanceDown,
    });
    this._recordAudit('settlement_payout_recorded', {
      reason: 'external-auto-redeem',
      conditionId,
      totalHeld,
      outcome,
      estimatedPayout,
      marketPnl,
    });
    this._publishMarket({
      lifecycle: BEAT_LIFECYCLE.SETTLED,
      settled: true,
      settledAt: this.lastSettledAt,
      outcome,
      pnl: marketPnl,
      tradeStatus: this.tradeSummary?.buyShares > 0 ? 'settled' : 'settled without trade',
      settledPayoutUsdc: this.settledPayoutUsdc,
    });
    return true;
  }

  _recordAudit(eventType, payload = {}) {
    this.auditLog.write(eventType, {
      slug: this.market.slug,
      marketSymbol: traderSymbol(this.market, this.config),
      lifecycle: this.lifecycle,
      totalSpent: this.totalSpent,
      settledPayoutUsdc: this.settledPayoutUsdc,
      balanceUp: this.balanceUp,
      balanceDown: this.balanceDown,
      walletBalanceUp: this.walletBalanceUp,
      walletBalanceDown: this.walletBalanceDown,
      lotState: this._lotState(),
      ...payload,
    });
  }

  _resolveOutcome(resolvedMarket) {
    const payouts = resolvedMarket?.resolvedPayouts;
    if (Array.isArray(payouts) && payouts.length >= 2) {
      const up = Number(payouts[0] ?? 0);
      const down = Number(payouts[1] ?? 0);
      if (up > down) return 'Up';
      if (down > up) return 'Down';
    }
    return null;
  }

  _buyShareCounts() {
    const events = Array.isArray(this.tradeSummary?.buyEvents) ? this.tradeSummary.buyEvents : [];
    return events.reduce(
      (counts, buy) => {
        if (!buy || typeof buy.side !== 'string') return counts;
        if (buy.side === 'Up') counts.up += Number(buy.shares ?? 0);
        if (buy.side === 'Down') counts.down += Number(buy.shares ?? 0);
        return counts;
      },
      { up: 0, down: 0 },
    );
  }

  _estimateSettlementPayout(resolvedMarket) {
    const payouts = resolvedMarket?.resolvedPayouts;
    if (Array.isArray(payouts) && payouts.length >= 2) {
      const { up, down } = this._buyShareCounts();
      const upShares = Number.isFinite(up) && up >= 0 ? up : this.balanceUp;
      const downShares = Number.isFinite(down) && down >= 0 ? down : this.balanceDown;
      if (up > 0 || down > 0) {
        return (upShares * Number(payouts[0] ?? 0)) + (downShares * Number(payouts[1] ?? 0));
      }
      return (this.balanceUp * Number(payouts[0] ?? 0)) + (this.balanceDown * Number(payouts[1] ?? 0));
    }
    return null;
  }

  _publishTrade(patch = {}) {
    this._publishMarket(patch);
  }

  _publishMarket(patch = {}) {
    if (!this.dashboard) return;
    const cfg = this.config;
    const lifecycle = patch.lifecycle ?? this.lifecycle;
    const settled = patch.settled ?? lifecycle === BEAT_LIFECYCLE.SETTLED;
    this.dashboard.recordMarket({
      slug: this.market.slug,
      marketSymbol: traderSymbol(this.market, cfg),
      windowTs: this.market.windowTs,
      windowOpenAt: this.market.windowTs * 1000,
      windowCloseAt: (this.market.windowTs + cfg.MARKET_WINDOW_SECONDS) * 1000,
      conditionId: this.market.conditionId,
      lifecycle,
      settled: Boolean(settled),
      beatPrice: patch.beatPrice ?? this.beatPrice,
      btcPrice: patch.btcPrice ?? this.latestBtcTick?.price ?? null,
      btcBestBid: patch.btcBestBid ?? this.latestBtcTick?.bestBid ?? null,
      btcBestAsk: patch.btcBestAsk ?? this.latestBtcTick?.bestAsk ?? null,
      upBestBid: patch.upBestBid ?? this.latestQuotes.up?.bid?.price ?? null,
      upBestAsk: patch.upBestAsk ?? this.latestQuotes.up?.ask?.price ?? null,
      downBestBid: patch.downBestBid ?? this.latestQuotes.down?.bid?.price ?? null,
      downBestAsk: patch.downBestAsk ?? this.latestQuotes.down?.ask?.price ?? null,
      chartPoint: patch.chartPoint ?? null,
      tradeStatus: patch.tradeStatus ?? this._defaultTradeStatus(),
      chosenSide: patch.chosenSide ?? this.tradeSummary?.chosenSide ?? null,
      buyShares: patch.buyShares ?? this.tradeSummary?.buyShares ?? 0,
      buyUsdc: patch.buyUsdc ?? this.tradeSummary?.buyUsdc ?? 0,
      buyPrice: patch.buyPrice ?? this.tradeSummary?.buyPrice ?? null,
      buyCount: patch.buyCount ?? this.tradeSummary?.buyCount ?? 0,
      buyEvents: patch.buyEvents ?? this.tradeSummary?.buyEvents ?? [],
      pairEvents: patch.pairEvents ?? this.tradeSummary?.pairEvents ?? [],
      pairedShares: patch.pairedShares ?? this.tradeSummary?.pairedShares ?? 0,
      pairedCostUsdc: patch.pairedCostUsdc ?? this.tradeSummary?.pairedCostUsdc ?? 0,
      averagePairedCost: patch.averagePairedCost ?? this.tradeSummary?.averagePairedCost ?? null,
      unpairedUpShares: patch.unpairedUpShares ?? this.tradeSummary?.unpairedUpShares ?? 0,
      unpairedDownShares: patch.unpairedDownShares ?? this.tradeSummary?.unpairedDownShares ?? 0,
      moveAtBuyUsd: patch.moveAtBuyUsd ?? this.tradeSummary?.moveAtBuyUsd ?? null,
      moveAtBuyPct: patch.moveAtBuyPct ?? this.tradeSummary?.moveAtBuyPct ?? null,
      btcPriceAtBuy: patch.btcPriceAtBuy ?? this.tradeSummary?.btcPriceAtBuy ?? null,
      tradeOccurred: patch.tradeOccurred ?? Boolean(this.tradeSummary?.buyShares > 0),
      outcome: patch.outcome ?? this.lastOutcome ?? null,
      pnl: patch.pnl ?? (this.settledPayoutUsdc - this.totalSpent),
      settledPayoutUsdc: patch.settledPayoutUsdc ?? this.settledPayoutUsdc,
      settledAt: patch.settledAt ?? null,
      updatedAt: Date.now(),
    });
  }

  _defaultTradeStatus() {
    return tradeStatusFromLifecycle(this.lifecycle, this.tradeSummary?.buyShares > 0);
  }
}
