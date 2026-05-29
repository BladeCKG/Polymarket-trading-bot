import { BtcPriceFeed } from './btc-price-feed.js';
import { BeatOfiTracker } from './ofi.js';
import { BEAT_LIFECYCLE } from './lifecycle.js';
import { createBeatRuntimeConfig } from './runtime-config.js';
import { BookFeed, ClobClient } from '../clob.js';
import { getTokenBalances, redeemPositions, sleep } from '../onchain.js';
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

function trendMomentsForConfig(market, config) {
  const symbol = traderSymbol(market, config);
  const key = `BEAT_TREND_MOMENTS_${symbol}`;
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

function roundShareAmount(value, precision = 1e-9) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.abs(num) <= precision ? 0 : num;
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
    this.redeemedUsdc = 0;
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
        arbPairRequiredEdge: cfg.BEAT_ARB_PAIR_REQUIRED_EDGE,
        trendMinProbability: cfg.BEAT_TREND_MIN_PROBABILITY,
        trendMinSignalScore: cfg.BEAT_TREND_MIN_SIGNAL_SCORE,
        trendMoments: trendMomentsForConfig(this.market, cfg),
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
      await this._cancelAllOrders(conditionId);
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
        redeemedUsdc: this.redeemedUsdc.toFixed(4),
      });
      this._recordAudit('market_resolution_pending', {
        beatPrice: this.beatPrice,
        totalSpent: this.totalSpent,
        redeemedUsdc: this.redeemedUsdc,
        tradeSummary: this.tradeSummary,
        outcome: this.lastOutcome,
      });
      return;
    }

    this.lifecycle = BEAT_LIFECYCLE.SETTLED;
    this.log.info('BeatTrader: market complete', {
      beatPrice: this.beatPrice,
      totalSpent: this.totalSpent.toFixed(4),
      redeemedUsdc: this.redeemedUsdc.toFixed(4),
      netPnl: (this.redeemedUsdc - this.totalSpent).toFixed(4),
    });
    this._recordAudit('market_complete', {
      beatPrice: this.beatPrice,
      totalSpent: this.totalSpent,
      redeemedUsdc: this.redeemedUsdc,
      netPnl: this.redeemedUsdc - this.totalSpent,
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
      move,
      upAsk: positiveFiniteOrNull(snapshot.upBestAsk),
      downAsk: positiveFiniteOrNull(snapshot.downBestAsk),
    });

    const historyWindowMs = Math.max(1_000, Number(this.config.BEAT_PROBABILITY_HISTORY_MS) || 15_000);
    const keepAfterMs = timestampMs - historyWindowMs;
    this.signalHistory = this.signalHistory.filter((entry) => Number(entry?.timestampMs ?? 0) >= keepAfterMs);
  }

  _seedSignalHistoryFromBtcHistory(nowMs = Date.now()) {
    if (!Number.isFinite(Number(this.beatPrice))) return;
    const historyWindowMs = Math.max(15_000, Number(this.config.BEAT_PROBABILITY_HISTORY_MS) || 15_000);
    const rawHistory = Array.isArray(this._btcHistoryProvider?.()) ? this._btcHistoryProvider() : [];
    if (!rawHistory.length) return;

    const keepAfterMs = nowMs - historyWindowMs;
    const seeded = rawHistory
      .map((entry) => ({
        timestampMs: Number(entry?.timeMs),
        price: Number(entry?.price),
      }))
      .filter((entry) => Number.isFinite(entry.timestampMs) && Number.isFinite(entry.price) && entry.timestampMs >= keepAfterMs && entry.timestampMs <= nowMs)
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map((entry) => ({
        timestampMs: entry.timestampMs,
        move: entry.price - Number(this.beatPrice),
        upAsk: null,
        downAsk: null,
      }));

    if (!seeded.length) return;

    const merged = [...this.signalHistory, ...seeded]
      .sort((a, b) => Number(a?.timestampMs ?? 0) - Number(b?.timestampMs ?? 0));
    const deduped = [];
    for (const entry of merged) {
      const ts = Number(entry?.timestampMs ?? 0);
      if (!Number.isFinite(ts)) continue;
      const prev = deduped[deduped.length - 1];
      if (prev && Math.abs(Number(prev.timestampMs) - ts) <= 1) {
        deduped[deduped.length - 1] = {
          timestampMs: ts,
          move: Number.isFinite(Number(entry.move)) ? Number(entry.move) : prev.move,
          upAsk: entry.upAsk ?? prev.upAsk ?? null,
          downAsk: entry.downAsk ?? prev.downAsk ?? null,
        };
        continue;
      }
      deduped.push({
        timestampMs: ts,
        move: Number.isFinite(Number(entry.move)) ? Number(entry.move) : null,
        upAsk: entry.upAsk ?? null,
        downAsk: entry.downAsk ?? null,
      });
    }
    this.signalHistory = deduped.filter((entry) => Number(entry?.timestampMs ?? 0) >= keepAfterMs);
  }

  _hasGuaranteedProbabilityHistory(nowMs = Date.now()) {
    const historyWindowMs = Math.max(15_000, Number(this.config.BEAT_PROBABILITY_HISTORY_MS) || 15_000);
    if (!this.signalHistory.length) return false;
    const earliestTs = Number(this.signalHistory[0]?.timestampMs ?? 0);
    const latestTs = Number(this.signalHistory[this.signalHistory.length - 1]?.timestampMs ?? 0);
    if (!Number.isFinite(earliestTs) || !Number.isFinite(latestTs)) return false;
    return earliestTs <= (nowMs - historyWindowMs) && latestTs <= nowMs;
  }

  _sampleAgo(msAgo, nowMs = Date.now()) {
    const cutoffMs = nowMs - msAgo;
    for (let i = this.signalHistory.length - 1; i >= 0; i -= 1) {
      const sample = this.signalHistory[i];
      if (Number(sample?.timestampMs ?? 0) <= cutoffMs) {
        return sample;
      }
    }
    return this.signalHistory[0] ?? null;
  }

  _probabilityModel(snapshot = {}) {
    const nowMs = Number(snapshot.snapshotAtMs ?? Date.now());
    const historyWindowMs = Math.max(15_000, Number(this.config.BEAT_PROBABILITY_HISTORY_MS) || 15_000);
    if (!this._hasGuaranteedProbabilityHistory(nowMs)) {
      return null;
    }
    const checkpointsMs = [
      3_000,
      6_000,
      10_000,
      Math.min(historyWindowMs, 15_000),
    ];
    const btcPrice = Number(snapshot.btcPrice);
    const beatPrice = Number(snapshot.beatPrice);
    const move = Number.isFinite(btcPrice) && Number.isFinite(beatPrice)
      ? btcPrice - beatPrice
      : 0;
    const upAsk = positiveFiniteOrNull(snapshot.upBestAsk);
    const downAsk = positiveFiniteOrNull(snapshot.downBestAsk);
    const pairCost = Number.isFinite(upAsk) && Number.isFinite(downAsk) ? upAsk + downAsk : null;

    const checkpointMoves = Object.fromEntries(checkpointsMs.map((ms) => {
      const sample = this._sampleAgo(ms, nowMs);
      const sampleMove = Number.isFinite(Number(sample?.move)) ? Number(sample.move) : move;
      return [ms, sampleMove];
    }));
    const velocity0To3 = (move - checkpointMoves[3_000]) / 3;
    const velocity3To6 = (checkpointMoves[3_000] - checkpointMoves[6_000]) / 3;
    const velocity6To10 = (checkpointMoves[6_000] - checkpointMoves[10_000]) / 4;
    const velocity10To15 = (checkpointMoves[10_000] - checkpointMoves[15_000]) / 5;
    const velocityComposite = (
      (0.38 * velocity0To3) +
      (0.27 * velocity3To6) +
      (0.20 * velocity6To10) +
      (0.15 * velocity10To15)
    );
    const accelerationFast = velocity0To3 - velocity3To6;
    const accelerationMid = velocity3To6 - velocity6To10;
    const accelerationSlow = velocity6To10 - velocity10To15;
    const accelerationComposite = (
      (0.5 * accelerationFast) +
      (0.3 * accelerationMid) +
      (0.2 * accelerationSlow)
    );
    const momentumComposite = velocityComposite + (0.5 * accelerationComposite);

    const upOfi = this.ofi.snapshotFor(this.market.upToken.tokenId, nowMs);
    const downOfi = this.ofi.snapshotFor(this.market.downToken.tokenId, nowMs);
    const ofiDiff = Number(upOfi?.ofiScore ?? 0) - Number(downOfi?.ofiScore ?? 0);

    const moveFeature = clamp(move / 20, -1, 1);
    const velocity0To3Feature = clamp(velocity0To3 / 2, -1, 1);
    const velocity3To6Feature = clamp(velocity3To6 / 2, -1, 1);
    const velocity6To10Feature = clamp(velocity6To10 / 2, -1, 1);
    const velocity10To15Feature = clamp(velocity10To15 / 2, -1, 1);
    const velocityCompositeFeature = clamp(velocityComposite / 2, -1, 1);
    const accelerationFeature = clamp(accelerationComposite / 2, -1, 1);
    const momentumFeature = clamp(momentumComposite / 2, -1, 1);
    const ofiFeature = clamp(ofiDiff / 200, -1, 1);
    const upCheapness = Number.isFinite(upAsk) ? clamp((0.5 - upAsk) / 0.25, -1, 1) : -1;
    const downCheapness = Number.isFinite(downAsk) ? clamp((0.5 - downAsk) / 0.25, -1, 1) : -1;
    const pairFeature = Number.isFinite(pairCost) ? clamp((1 - pairCost) / 0.08, -1, 1) : -1;
    const flipPotential = clamp(1 - (Math.abs(move) / 40), 0, 1);

    const upScore =
      (0.9 * moveFeature) +
      (0.18 * velocity0To3Feature) +
      (0.14 * velocity3To6Feature) +
      (0.10 * velocity6To10Feature) +
      (0.08 * velocity10To15Feature) +
      (0.18 * velocityCompositeFeature) +
      (0.25 * accelerationFeature) +
      (0.12 * momentumFeature) +
      (0.45 * ofiFeature) +
      (0.55 * upCheapness) +
      (0.45 * pairFeature) +
      (0.25 * flipPotential);
    const downScore =
      (-0.9 * moveFeature) +
      (-0.18 * velocity0To3Feature) +
      (-0.14 * velocity3To6Feature) +
      (-0.10 * velocity6To10Feature) +
      (-0.08 * velocity10To15Feature) +
      (-0.18 * velocityCompositeFeature) +
      (-0.25 * accelerationFeature) +
      (-0.12 * momentumFeature) +
      (-0.45 * ofiFeature) +
      (0.55 * downCheapness) +
      (0.45 * pairFeature) +
      (0.25 * flipPotential);

    const upExp = Math.exp(clamp(upScore, -8, 8));
    const downExp = Math.exp(clamp(downScore, -8, 8));
    const totalExp = upExp + downExp || 1;

    return {
      pairCost,
      pUp: upExp / totalExp,
      pDown: downExp / totalExp,
      features: {
        move,
        checkpointsMs,
        velocity0To3,
        velocity3To6,
        velocity6To10,
        velocity10To15,
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

    if (await this._maybeExecuteArbPair(snapshot)) {
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
      this._recordAudit('decision_skip', {
        reason: 'insufficient-btc-history',
        requiredHistoryMs: cfg.BEAT_PROBABILITY_HISTORY_MS,
        availableFromMs: Number(this.signalHistory[0]?.timestampMs ?? null),
        snapshotAtMs: Number(snapshot?.snapshotAtMs ?? Date.now()),
      });
      return;
    }
    // Determine per-moment thresholds (seconds after market open)
    const secondsAfterOpen = Math.floor(Date.now() / 1000) - this.market.windowTs;
    const trendMoments = trendMomentsForConfig(this.market, cfg);
    const trendMoment = trendMoments.find((m) => secondsAfterOpen >= Number(m.start ?? 0) && secondsAfterOpen < Number(m.end ?? cfg.MARKET_WINDOW_SECONDS)) || null;

    if (trendMoment) {
      const trendBuyExecuted = await this._maybeTrendBuy({
        snapshot,
        tick,
        delta,
        secondsAfterOpen,
        trendMoment,
        probabilityModel,
      });
      if (trendBuyExecuted) {
        return;
      }
    }

    const moments = momentsForConfig(this.market, cfg);
    const moment = moments.find((m) => secondsAfterOpen >= Number(m.start ?? 0) && secondsAfterOpen < Number(m.end ?? cfg.MARKET_WINDOW_SECONDS)) || null;
    // Require an explicit moment with thresholds to allow buys. If no moment or missing values, do not buy.
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
    const resolvedBuyMax = Number(moment.buyMax);
    const bookState = {
      Up: {
        tokenId: this.market.upToken.tokenId,
        book: this.latestQuotes.up?.book ?? null,
        bid: this.latestQuotes.up?.bid ?? null,
        ask: this.latestQuotes.up?.ask ?? null,
        bookAgeMs: bookAgeMs(this.latestQuotes.up?.book),
        maxBuyPrice: resolvedBuyMax,
      },
      Down: {
        tokenId: this.market.downToken.tokenId,
        book: this.latestQuotes.down?.book ?? null,
        bid: this.latestQuotes.down?.bid ?? null,
        ask: this.latestQuotes.down?.ask ?? null,
        bookAgeMs: bookAgeMs(this.latestQuotes.down?.book),
        maxBuyPrice: resolvedBuyMax,
      },
    };

    const absoluteMove = Math.abs(delta);
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
    const preferredSide = delta > 0 ? 'Up' : (delta < 0 ? 'Down' : null);
    const candidateLegs = Object.entries(bookState)
      .map(([side, leg]) => {
        const sideProbability = probabilityModel
          ? (side === 'Up' ? probabilityModel.pUp : probabilityModel.pDown)
          : null;
        const modelEdge = Number.isFinite(sideProbability) && Number.isFinite(leg.ask?.price)
          ? sideProbability - leg.ask.price
          : null;
        const dynamicBuyMax = probabilityModel && Number.isFinite(sideProbability)
          ? Math.min(
            leg.maxBuyPrice,
            Math.max(0, sideProbability - Number(cfg.BEAT_PROBABILITY_REQUIRED_EDGE)),
          )
          : leg.maxBuyPrice;
        const edgeFactor = Number.isFinite(modelEdge)
          ? clamp(modelEdge / Math.max(0.0001, Number(cfg.BEAT_PROBABILITY_REQUIRED_EDGE)), 0, 1)
          : 0;
        const baseMoveMax = side === 'Up' ? thresholds.upMax : thresholds.downMax;
        const dynamicMoveMax = probabilityModel
          ? Math.min(
            baseMoveMax,
            Math.max(5, baseMoveMax * (0.35 + (0.65 * edgeFactor))),
          )
          : baseMoveMax;

        if (!leg.ask) {
          return { side, leg, affordable: false, maxPrice: null, reason: 'missing-best-ask', sideProbability, modelEdge, dynamicBuyMax, dynamicMoveMax };
        }
        if (!Number.isFinite(leg.bookAgeMs) || leg.bookAgeMs > cfg.BEAT_BOOK_MAX_AGE_MS) {
          return { side, leg, affordable: false, maxPrice: null, reason: 'stale-book', sideProbability, modelEdge, dynamicBuyMax, dynamicMoveMax };
        }
        if (probabilityModel) {
          if (!Number.isFinite(probabilityModel.pairCost) || probabilityModel.pairCost > Number(cfg.BEAT_PROBABILITY_PAIR_COST_MAX)) {
            return { side, leg, affordable: false, maxPrice: null, reason: 'pair-cost-too-high', sideProbability, modelEdge, dynamicBuyMax, dynamicMoveMax };
          }
          if (!Number.isFinite(modelEdge) || modelEdge < Number(cfg.BEAT_PROBABILITY_REQUIRED_EDGE)) {
            return { side, leg, affordable: false, maxPrice: null, reason: 'probability-edge-too-small', sideProbability, modelEdge, dynamicBuyMax, dynamicMoveMax };
          }
          if (absoluteMove > dynamicMoveMax) {
            return { side, leg, affordable: false, maxPrice: null, reason: 'move-above-dynamic-cap', sideProbability, modelEdge, dynamicBuyMax, dynamicMoveMax };
          }
        }
        if (leg.ask.price > dynamicBuyMax) {
          return { side, leg, affordable: false, maxPrice: null, reason: 'ask-above-buy-max', sideProbability, modelEdge, dynamicBuyMax, dynamicMoveMax };
        }
        const maxPrice = clampMaxPrice(leg.ask.price, dynamicBuyMax, cfg.BEAT_MAX_SLIPPAGE);
        if (maxPrice + 1e-9 < leg.ask.price) {
          return { side, leg, affordable: false, maxPrice, reason: 'clamped-price-below-ask', sideProbability, modelEdge, dynamicBuyMax, dynamicMoveMax };
        }
        return { side, leg, affordable: true, maxPrice, reason: null, sideProbability, modelEdge, dynamicBuyMax, dynamicMoveMax };
      });

    const affordableLegs = candidateLegs.filter((entry) => entry.affordable);
    if (!affordableLegs.length) {
      this._recordAudit('decision_skip', {
        reason: 'no-affordable-side',
        preferredSide,
        delta,
        absoluteMove,
        moment,
        bookState,
        candidateLegs: candidateLegs.map((entry) => ({
          side: entry.side,
          reason: entry.reason,
          askPrice: entry.leg.ask?.price ?? null,
          bookAgeMs: entry.leg.bookAgeMs ?? null,
          maxBuyPrice: entry.dynamicBuyMax ?? entry.leg.maxBuyPrice,
          dynamicMoveMax: entry.dynamicMoveMax ?? null,
          maxPrice: entry.maxPrice,
          sideProbability: entry.sideProbability ?? null,
          modelEdge: entry.modelEdge ?? null,
        })),
        probabilityModel,
      });
      return;
    }

    const selected = affordableLegs
      .sort((a, b) => {
        const aEdge = Number.isFinite(a.modelEdge) ? -a.modelEdge : Infinity;
        const bEdge = Number.isFinite(b.modelEdge) ? -b.modelEdge : Infinity;
        if (aEdge !== bEdge) return aEdge - bEdge;
        const aPreferred = a.side === preferredSide ? 0 : 1;
        const bPreferred = b.side === preferredSide ? 0 : 1;
        if (aPreferred !== bPreferred) return aPreferred - bPreferred;
        const askDiff = Number(a.leg.ask?.price ?? Infinity) - Number(b.leg.ask?.price ?? Infinity);
        if (askDiff !== 0) return askDiff;
        return String(a.side).localeCompare(String(b.side));
      })[0];
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
        preferredSide,
        delta,
        absoluteMove,
        beatPrice: this.beatPrice,
        btcPrice: tick.price,
        moment,
        ofiDecision,
        probabilityModel,
      });
      return;
    }

    const maxPrice = Math.max(0, selected.maxPrice - ofiDecision.adjustPrice);
    if (maxPrice + 1e-9 < Number(leg.ask?.price ?? Infinity)) {
      this._recordAudit('decision_skip', {
        reason: 'ofi-softened-price-below-ask',
        secondsAfterOpen,
        chosenSide,
        preferredSide,
        delta,
        absoluteMove,
        beatPrice: this.beatPrice,
        btcPrice: tick.price,
        moment,
        ofiDecision,
        askPrice: leg.ask?.price ?? null,
        originalMaxPrice: selected.maxPrice,
        softenedMaxPrice: maxPrice,
        probabilityModel,
      });
      return;
    }

    this._recordAudit('decision_buy_signal', {
      secondsAfterOpen,
      chosenSide,
      preferredSide,
      delta,
      absoluteMove,
      beatPrice: this.beatPrice,
      btcPrice: tick.price,
      thresholds,
      moment,
      snapshot,
      candidateLegs: candidateLegs.map((entry) => ({
        side: entry.side,
        affordable: entry.affordable,
        reason: entry.reason,
        askPrice: entry.leg.ask?.price ?? null,
        bookAgeMs: entry.leg.bookAgeMs ?? null,
        maxBuyPrice: entry.dynamicBuyMax ?? entry.leg.maxBuyPrice,
        dynamicMoveMax: entry.dynamicMoveMax ?? null,
        maxPrice: entry.maxPrice,
        sideProbability: entry.sideProbability ?? null,
        modelEdge: entry.modelEdge ?? null,
      })),
      selectedLeg: {
        tokenId: leg.tokenId,
        bestBid: leg.bid,
        bestAsk: leg.ask,
        bookAgeMs: leg.bookAgeMs ?? null,
        maxBuyPrice: selected.dynamicBuyMax ?? leg.maxBuyPrice,
        dynamicMoveMax: selected.dynamicMoveMax ?? null,
        maxPrice,
        sideProbability: selected.sideProbability ?? null,
        modelEdge: selected.modelEdge ?? null,
      },
      ofiDecision,
      probabilityModel,
    });

    await this._executeBuy({
      side: chosenSide,
      tokenId: leg.tokenId,
      book: leg.book,
      bestBid: leg.bid,
      bestAsk: leg.ask,
      maxPrice,
      delta,
      btcPrice: tick.price,
    });
  }



  async _executeBuy({ side, tokenId, book, bestBid, bestAsk, maxPrice, delta, btcPrice }) {
    const cfg = this.config;
    const remainingBudget = cfg.MAX_SPEND_PER_MARKET - this.totalSpent;
    const reducesImbalance = this._buyReducesImbalance(side);
    if (remainingBudget < 1 && !reducesImbalance) {
      this._recordAudit('decision_skip', {
        reason: 'remaining-budget-too-low',
        side,
        reducesImbalance,
        remainingBudget,
        totalSpent: this.totalSpent,
      });
      return;
    }

    if (cfg.BEAT_ORDER_MODE === 'SHARES') {
      const requestedShares = reducesImbalance
        ? cfg.BEAT_ORDER_SIZE_SHARES
        : Math.min(
          cfg.BEAT_ORDER_SIZE_SHARES,
          remainingBudget / Math.max(bestAsk.price, 0.0001),
        );
      if (requestedShares <= 0) {
        this._recordAudit('decision_skip', {
          reason: 'requested-shares-nonpositive',
          side,
          reducesImbalance,
          remainingBudget,
          bestAsk: bestAsk?.price ?? null,
          requestedShares,
        });
        return;
      }

      const plan = estimateSharesFromBook(book, maxPrice, requestedShares);
      this._recordAudit('order_plan', {
        side,
        orderMode: cfg.BEAT_ORDER_MODE,
        tokenId,
        reducesImbalance,
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

    const amountUsdc = reducesImbalance
      ? cfg.BEAT_ORDER_SIZE_USDC
      : Math.min(cfg.BEAT_ORDER_SIZE_USDC, remainingBudget);
    if (amountUsdc <= 0) {
      this._recordAudit('decision_skip', {
        reason: 'amount-usdc-nonpositive',
        side,
        reducesImbalance,
        remainingBudget,
        amountUsdc,
      });
      return;
    }

    const plan = ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, amountUsdc, 0);
    this._recordAudit('order_plan', {
      side,
      orderMode: cfg.BEAT_ORDER_MODE,
      tokenId,
      reducesImbalance,
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

    if (!cfg.BEAT_DRY_RUN) {
      try {
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
          return;
        }
      } catch (err) {
        this.log.warn('BeatTrader: directional USDC buy failed', { side, err: err.message });
        this._recordAudit('order_error', {
          side,
          orderMode: cfg.BEAT_ORDER_MODE,
          tokenId,
          err: err.message,
          stack: err.stack ?? null,
        });
        return;
      }
    }

    this._recordBuy(side, plan.avgFillPrice ?? bestAsk.price, plan.fillShares, plan.spentUsdc, delta, btcPrice);
    this.lastBuyAt = Date.now();
    this._publishTrade({
      lifecycle: BEAT_LIFECYCLE.MONITORING,
      tradeStatus: cfg.BEAT_DRY_RUN ? 'dry-run buy placed' : 'buy placed',
      chosenSide: this.tradeSummary?.chosenSide ?? side,
      buyShares: this.tradeSummary?.buyShares ?? plan.fillShares,
      buyUsdc: this.tradeSummary?.buyUsdc ?? plan.spentUsdc,
      buyPrice: this.tradeSummary?.buyPrice ?? (plan.avgFillPrice ?? bestAsk.price),
    });
    this.log.info(`BeatTrader: ${cfg.BEAT_DRY_RUN ? 'dry-run buy' : 'bought'} directional USDC`, {
      side,
      requestedUsdc: amountUsdc,
      estimatedFillShares: plan.fillShares,
      estimatedSpentUsdc: plan.spentUsdc,
      avgPrice: plan.avgFillPrice,
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
  }

  async _maybeTrendBuy({ snapshot = {}, tick, delta, secondsAfterOpen, trendMoment, probabilityModel = null }) {
    const cfg = this.config;
    const absoluteMove = Math.abs(delta);
    const chosenSide = delta > 0 ? 'Up' : (delta < 0 ? 'Down' : null);
    if (!chosenSide) {
      this._recordAudit('trend_moment_skip', {
        reason: 'zero-delta',
        secondsAfterOpen,
        trendMoment,
        delta,
      });
      return false;
    }
    if (absoluteMove < Number(trendMoment.btcmoveMin ?? Infinity)) {
      this._recordAudit('trend_moment_skip', {
        reason: 'move-below-min',
        secondsAfterOpen,
        trendMoment,
        delta,
        absoluteMove,
      });
      return false;
    }

    const directionSign = chosenSide === 'Up' ? 1 : -1;
    const chosenProbability = probabilityModel
      ? Number(chosenSide === 'Up' ? probabilityModel.pUp : probabilityModel.pDown)
      : null;
    const oppositeProbability = probabilityModel
      ? Number(chosenSide === 'Up' ? probabilityModel.pDown : probabilityModel.pUp)
      : null;
    const probabilityEdge = Number.isFinite(chosenProbability) && Number.isFinite(oppositeProbability)
      ? chosenProbability - oppositeProbability
      : null;
    const velocityDirectional = probabilityModel
      ? directionSign * Number(probabilityModel.features?.velocityComposite ?? 0)
      : null;
    const accelerationDirectional = probabilityModel
      ? directionSign * Number(probabilityModel.features?.accelerationComposite ?? 0)
      : null;
    const momentumDirectional = probabilityModel
      ? directionSign * Number(probabilityModel.features?.momentumComposite ?? 0)
      : null;
    const ofiDirectional = probabilityModel
      ? directionSign * Number(probabilityModel.features?.ofiDiff ?? 0)
      : null;
    const trendSignalScore = probabilityModel
      ? (
          (0.45 * clamp(((chosenProbability ?? 0) - 0.5) / 0.25, -1, 1)) +
          (0.30 * clamp((momentumDirectional ?? 0) / 2, -1, 1)) +
          (0.15 * clamp((velocityDirectional ?? 0) / 2, -1, 1)) +
          (0.10 * clamp((accelerationDirectional ?? 0) / 2, -1, 1)) +
          (0.15 * clamp((ofiDirectional ?? 0) / 200, -1, 1))
        )
      : null;
    if (probabilityModel) {
      if (!Number.isFinite(chosenProbability) || chosenProbability < Number(cfg.BEAT_TREND_MIN_PROBABILITY)) {
        this._recordAudit('trend_moment_skip', {
          reason: 'probability-below-min',
          chosenSide,
          secondsAfterOpen,
          trendMoment,
          chosenProbability,
          minProbability: cfg.BEAT_TREND_MIN_PROBABILITY,
          probabilityModel,
        });
        return false;
      }
      if (!Number.isFinite(trendSignalScore) || trendSignalScore < Number(cfg.BEAT_TREND_MIN_SIGNAL_SCORE)) {
        this._recordAudit('trend_moment_skip', {
          reason: 'trend-signal-too-weak',
          chosenSide,
          secondsAfterOpen,
          trendMoment,
          chosenProbability,
          probabilityEdge,
          momentumDirectional,
          velocityDirectional,
          accelerationDirectional,
          ofiDirectional,
          trendSignalScore,
          minTrendSignalScore: cfg.BEAT_TREND_MIN_SIGNAL_SCORE,
          probabilityModel,
        });
        return false;
      }
    }

    const leg = chosenSide === 'Up'
      ? {
          tokenId: this.market.upToken.tokenId,
          book: this.latestQuotes.up?.book ?? null,
          bid: this.latestQuotes.up?.bid ?? null,
          ask: this.latestQuotes.up?.ask ?? null,
          bookAgeMs: bookAgeMs(this.latestQuotes.up?.book),
        }
      : {
          tokenId: this.market.downToken.tokenId,
          book: this.latestQuotes.down?.book ?? null,
          bid: this.latestQuotes.down?.bid ?? null,
          ask: this.latestQuotes.down?.ask ?? null,
          bookAgeMs: bookAgeMs(this.latestQuotes.down?.book),
        };

    if (!leg.ask) {
      this._recordAudit('trend_moment_skip', {
        reason: 'missing-best-ask',
        chosenSide,
        secondsAfterOpen,
        trendMoment,
      });
      return false;
    }
    if (!Number.isFinite(leg.bookAgeMs) || leg.bookAgeMs > cfg.BEAT_BOOK_MAX_AGE_MS) {
      this._recordAudit('trend_moment_skip', {
        reason: 'stale-book',
        chosenSide,
        secondsAfterOpen,
        trendMoment,
        bookAgeMs: leg.bookAgeMs,
      });
      return false;
    }

    const askPrice = Number(leg.ask.price);
    const askMin = Number(trendMoment.askMin);
    const askMax = Number(trendMoment.askMax);
    if (!Number.isFinite(askPrice) || askPrice < askMin || askPrice > askMax) {
      this._recordAudit('trend_moment_skip', {
        reason: 'ask-outside-range',
        chosenSide,
        secondsAfterOpen,
        trendMoment,
        askPrice,
      });
      return false;
    }

    const ofiDecision = this.ofi.decisionFor(
      leg.tokenId,
      Number(leg.book?.tickSize ?? 0.01),
      Date.now(),
    );
    if (ofiDecision.suppress) {
      this._recordAudit('trend_moment_skip', {
        reason: 'ofi-suppressed',
        chosenSide,
        secondsAfterOpen,
        trendMoment,
        askPrice,
        ofiDecision,
      });
      return false;
    }

    const unclampedMaxPrice = clampMaxPrice(askPrice, askMax, cfg.BEAT_MAX_SLIPPAGE);
    const maxPrice = Math.max(0, unclampedMaxPrice - ofiDecision.adjustPrice);
    if (maxPrice + 1e-9 < askPrice) {
      this._recordAudit('trend_moment_skip', {
        reason: 'ofi-softened-price-below-ask',
        chosenSide,
        secondsAfterOpen,
        trendMoment,
        askPrice,
        unclampedMaxPrice,
        maxPrice,
        ofiDecision,
        chosenProbability,
        probabilityEdge,
        momentumDirectional,
        velocityDirectional,
        accelerationDirectional,
        ofiDirectional,
        trendSignalScore,
      });
      return false;
    }

    this._recordAudit('trend_moment_buy_signal', {
      chosenSide,
      secondsAfterOpen,
      trendMoment,
      delta,
      absoluteMove,
      beatPrice: this.beatPrice,
      btcPrice: tick.price,
      askPrice,
      maxPrice,
      chosenProbability,
      probabilityEdge,
      momentumDirectional,
      velocityDirectional,
      accelerationDirectional,
      ofiDirectional,
      trendSignalScore,
      snapshot,
      ofiDecision,
      probabilityModel,
    });

    await this._executeBuy({
      side: chosenSide,
      tokenId: leg.tokenId,
      book: leg.book,
      bestBid: leg.bid,
      bestAsk: leg.ask,
      maxPrice,
      delta,
      btcPrice: tick.price,
    });
    return true;
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
    if (!oppositeSide || !Number.isFinite(Number(buyPriceCap))) return [];
    const pairCostCap = Number(this.config.BEAT_ARB_PAIR_COST_MAX);
    return this.openLots[oppositeSide]
      .filter((lot) => {
        const remainingShares = Number(lot?.remainingShares ?? 0);
        const lotPrice = Number(lot?.avgPrice ?? 0);
        return remainingShares > 0 && Number.isFinite(lotPrice) && (lotPrice + buyPriceCap) <= pairCostCap;
      })
      .map((lot) => ({ ...lot }));
  }

  _pairingPreview(side, pairBuyPrice, targetShares = Infinity) {
    const remainingTarget = { value: Number.isFinite(Number(targetShares)) ? Math.max(0, Number(targetShares)) : Infinity };
    const oppositeSide = this._oppositeSide(side);
    const pairCostCap = Number(this.config.BEAT_ARB_PAIR_COST_MAX);
    const matches = [];
    let pairedShares = 0;
    let totalCost = 0;

    for (const lot of this.openLots[oppositeSide]) {
      if (remainingTarget.value <= 1e-9) break;
      const lotShares = Number(lot?.remainingShares ?? 0);
      const lotPrice = Number(lot?.avgPrice ?? 0);
      if (lotShares <= 1e-9 || !Number.isFinite(lotPrice) || (lotPrice + pairBuyPrice) > pairCostCap) {
        continue;
      }
      const matchedShares = Math.min(lotShares, remainingTarget.value);
      if (matchedShares <= 1e-9) continue;
      pairedShares += matchedShares;
      totalCost += matchedShares * (lotPrice + pairBuyPrice);
      remainingTarget.value = remainingTarget.value === Infinity ? Infinity : (remainingTarget.value - matchedShares);
      matches.push({
        oppositeLotId: lot.id,
        oppositeSide,
        oppositePrice: lotPrice,
        shares: matchedShares,
        pairCost: lotPrice + pairBuyPrice,
      });
    }

    return {
      pairedShares,
      totalCost,
      averagePairCost: pairedShares > 0 ? totalCost / pairedShares : null,
      pairEdge: pairedShares > 0 ? (1 - (totalCost / pairedShares)) : null,
      matches,
    };
  }

  _buildArbPairCandidate(side, leg, snapshot = {}) {
    const cfg = this.config;
    if (!cfg.BEAT_ARB_PAIR_ENABLED) return null;
    if (!leg?.ask || !Number.isFinite(Number(leg.ask.price))) return null;
    if (!Number.isFinite(leg.bookAgeMs) || leg.bookAgeMs > cfg.BEAT_BOOK_MAX_AGE_MS) return null;

    const eligibleLots = this._eligiblePairLots(side, Number(leg.ask.price));
    if (!eligibleLots.length) return null;

    const maxPrice = eligibleLots.reduce((minCap, lot) => {
      const allowedPrice = Number(cfg.BEAT_ARB_PAIR_COST_MAX) - Number(lot.avgPrice ?? 0);
      return Math.min(minCap, allowedPrice);
    }, Infinity);
    if (!Number.isFinite(maxPrice) || maxPrice <= 0) return null;

    const targetShares = eligibleLots.reduce((sum, lot) => sum + Number(lot.remainingShares ?? 0), 0);
    if (targetShares <= 1e-9) return null;

    const plan = estimateSharesFromBook(leg.book, maxPrice, targetShares);
    if (!plan || plan.fillShares <= 1e-9 || plan.spentUsdc <= 0) return null;

    const projectedAvgPrice = plan.spentUsdc / plan.fillShares;
    const preview = this._pairingPreview(side, projectedAvgPrice, plan.fillShares);
    if (preview.pairedShares <= 1e-9) return null;
    if (!Number.isFinite(preview.pairEdge) || preview.pairEdge < Number(cfg.BEAT_ARB_PAIR_REQUIRED_EDGE)) {
      return null;
    }

    return {
      intent: 'arb-pair',
      side,
      tokenId: leg.tokenId,
      book: leg.book,
      bestBid: leg.bid,
      bestAsk: leg.ask,
      bookAgeMs: leg.bookAgeMs,
      maxPrice,
      targetShares,
      plan,
      preview,
      pairEdge: preview.pairEdge,
      snapshotAtMs: Number(snapshot.snapshotAtMs ?? Date.now()),
    };
  }

  async _maybeExecuteArbPair(snapshot = {}) {
    const cfg = this.config;
    if (!cfg.BEAT_ARB_PAIR_ENABLED) return false;

    const candidates = [
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
    ].filter(Boolean);

    if (!candidates.length) return false;

    const selected = candidates.sort((a, b) => {
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
      pairRequiredEdge: cfg.BEAT_ARB_PAIR_REQUIRED_EDGE,
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
    const remainingBudget = cfg.MAX_SPEND_PER_MARKET - this.totalSpent;
    const targetShares = Number(candidate?.targetShares ?? 0);
    if (targetShares <= 1e-9) {
      return false;
    }

    const plan = estimateSharesFromBook(candidate.book, candidate.maxPrice, targetShares);
    this._recordAudit('order_plan', {
      side: candidate.side,
      orderMode: 'ARB_PAIR_SHARES',
      tokenId: candidate.tokenId,
      requestedShares: targetShares,
      remainingBudget,
      maxPrice: candidate.maxPrice,
      bestBid: candidate.bestBid ?? null,
      bestAsk: candidate.bestAsk ?? null,
      pairPreview: candidate.preview,
      pairEdge: candidate.pairEdge,
      plan,
      lotState: this._lotState(),
      book: summarizeBook(candidate.book),
    });
    if (!plan || !plan.fullyFilled || plan.fillShares <= 1e-9 || plan.spentUsdc <= 0) {
      this._recordAudit('decision_skip', {
        reason: 'arb-pair-plan-not-fillable',
        side: candidate.side,
        tokenId: candidate.tokenId,
        targetShares,
        maxPrice: candidate.maxPrice,
        plan,
      });
      return false;
    }

    if (!cfg.BEAT_DRY_RUN) {
      try {
        this._recordAudit('order_submit', {
          side: candidate.side,
          orderMode: 'ARB_PAIR_SHARES',
          tokenId: candidate.tokenId,
          maxPrice: candidate.maxPrice,
          shares: plan.fillShares,
        });
        const response = await ClobClient.postFOKLimitBuy(this.wallet, candidate.tokenId, candidate.maxPrice, plan.fillShares);
        this._recordAudit('order_result', {
          side: candidate.side,
          orderMode: 'ARB_PAIR_SHARES',
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
          return false;
        }
      } catch (err) {
        this.log.warn('BeatTrader: arb pair buy failed', { side: candidate.side, err: err.message });
        this._recordAudit('order_error', {
          side: candidate.side,
          orderMode: 'ARB_PAIR_SHARES',
          tokenId: candidate.tokenId,
          err: err.message,
          stack: err.stack ?? null,
        });
        return false;
      }
    }

    const avgPrice = plan.spentUsdc / plan.fillShares;
    this._recordBuy(candidate.side, avgPrice, plan.fillShares, plan.spentUsdc, null, null, {
      intent: 'arb-pair',
      pairCostCap: cfg.BEAT_ARB_PAIR_COST_MAX,
    });
    this.lastBuyAt = Date.now();
    this._publishTrade({
      lifecycle: BEAT_LIFECYCLE.MONITORING,
      tradeStatus: cfg.BEAT_DRY_RUN ? 'dry-run buy placed' : 'buy placed',
      chosenSide: this.tradeSummary?.chosenSide ?? candidate.side,
      buyShares: this.tradeSummary?.buyShares ?? plan.fillShares,
      buyUsdc: this.tradeSummary?.buyUsdc ?? plan.spentUsdc,
      buyPrice: this.tradeSummary?.buyPrice ?? avgPrice,
    });
    this.log.info(`BeatTrader: ${cfg.BEAT_DRY_RUN ? 'dry-run arb pair buy' : 'arb pair buy executed'}`, {
      side: candidate.side,
      shares: plan.fillShares,
      spentUsdc: plan.spentUsdc,
      avgPrice,
      pairCostCap: cfg.BEAT_ARB_PAIR_COST_MAX,
      pairRequiredEdge: cfg.BEAT_ARB_PAIR_REQUIRED_EDGE,
      projectedAveragePairCost: candidate.preview.averagePairCost,
      pairEdge: candidate.pairEdge,
    });
    this._recordAudit('order_filled', {
      side: candidate.side,
      orderMode: 'ARB_PAIR_SHARES',
      tokenId: candidate.tokenId,
      dryRun: cfg.BEAT_DRY_RUN,
      maxPrice: candidate.maxPrice,
      plan,
      pairPreview: candidate.preview,
      pairEdge: candidate.pairEdge,
      lotState: this._lotState(),
      tradeSummary: this.tradeSummary,
    });
    return true;
  }

  _pairNewLot(newLot) {
    const oppositeSide = this._oppositeSide(newLot.side);
    const pairCostCap = Number(this.config.BEAT_ARB_PAIR_COST_MAX);
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
    const cfg = this.config;
    if (this.halted) return true;

    const lotState = this._lotState();
    const imbalanceShares = Math.abs(lotState.unpairedUpShares - lotState.unpairedDownShares);
    if (imbalanceShares > cfg.BEAT_MAX_INVENTORY_IMBALANCE_SHARES) {
      this.log.warn('BeatTrader: inventory imbalance limit reached', {
        imbalanceShares,
        balanceUp: this.balanceUp,
        balanceDown: this.balanceDown,
        unpairedUpShares: lotState.unpairedUpShares,
        unpairedDownShares: lotState.unpairedDownShares,
        maxInventoryImbalanceShares: cfg.BEAT_MAX_INVENTORY_IMBALANCE_SHARES,
      });
      this._recordAudit('circuit_breaker', {
        reason: 'inventory-imbalance',
        imbalanceShares,
        balanceUp: this.balanceUp,
        balanceDown: this.balanceDown,
        unpairedUpShares: lotState.unpairedUpShares,
        unpairedDownShares: lotState.unpairedDownShares,
        maxInventoryImbalanceShares: cfg.BEAT_MAX_INVENTORY_IMBALANCE_SHARES,
      });
      this.halted = true;
      this.lifecycle = BEAT_LIFECYCLE.HALTED;
      return true;
    }

    if (this.totalSpent >= cfg.MAX_SPEND_PER_MARKET) {
      if (!this.stopBuying) {
        this.log.info('BeatTrader: spend cap reached', { totalSpent: this.totalSpent.toFixed(2) });
        this._recordAudit('circuit_breaker', {
          reason: 'spend-cap',
          totalSpent: this.totalSpent,
          maxSpendPerMarket: cfg.MAX_SPEND_PER_MARKET,
        });
      }
      this.stopBuying = true;
      return false;
    }

    return false;
  }

  _buyReducesImbalance(side) {
    const lotState = this._lotState();
    const imbalance = lotState.unpairedUpShares - lotState.unpairedDownShares;
    if (side === 'Up') return imbalance < -1e-9;
    if (side === 'Down') return imbalance > 1e-9;
    return false;
  }

  async _cancelAllOrders(conditionId) {
    if (this.config.BEAT_DRY_RUN) {
      this.log.info('BeatTrader: dry-run cancel skipped', { conditionId });
      this._recordAudit('cancel_skipped', { reason: 'dry-run', conditionId });
      return;
    }
    try {
      this._recordAudit('cancel_submit', { strategy: 'cancelMarket', conditionId });
      await ClobClient.cancelMarket(conditionId);
      this._recordAudit('cancel_result', { strategy: 'cancelMarket', conditionId, success: true });
    } catch (err) {
      this.log.warn('BeatTrader: cancelMarket failed, trying cancelAll', { err: err.message });
      this._recordAudit('cancel_error', {
        strategy: 'cancelMarket',
        conditionId,
        err: err.message,
      });
      try {
        this._recordAudit('cancel_submit', { strategy: 'cancelAll', conditionId });
        await ClobClient.cancelAll();
        this._recordAudit('cancel_result', { strategy: 'cancelAll', conditionId, success: true });
      } catch (fallbackErr) {
        this.log.warn('BeatTrader: cancelAll failed', { err: fallbackErr.message });
        this._recordAudit('cancel_error', {
          strategy: 'cancelAll',
          conditionId,
          err: fallbackErr.message,
        });
      }
    }
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
    const estimatedPayout = this._estimateRedeemPayout(resolvedMarket);
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
    this.redeemedUsdc += estimatedPayout;

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

    if (cfg.BEAT_DRY_RUN) {
      this.pnl.recordRedeem(this.market.slug, estimatedPayout, 'dry-run');
      this.log.info('BeatTrader: dry-run settlement simulated', {
        outcome,
        estimatedPayout,
        marketPnl,
        upHeld: this.balanceUp,
        downHeld: this.balanceDown,
      });
      this._recordAudit('redeem_skipped', {
        reason: 'dry-run',
        outcome,
        estimatedPayout,
        marketPnl,
      });
      return true;
    }

    const totalHeld = this.balanceUp + this.balanceDown;
    if (totalHeld < 0.001) {
      this.log.info('BeatTrader: no tokens to redeem');
      this.pnl.recordRedeem(this.market.slug, estimatedPayout, 'none');
      this._recordAudit('redeem_skipped', {
        reason: 'no-tokens-held',
        totalHeld,
        outcome,
        estimatedPayout,
      });
      return true;
    }

    try {
      this._recordAudit('redeem_submit', { conditionId, totalHeld, outcome });
      const txHash = await redeemPositions(conditionId);
      this.pnl.recordRedeem(this.market.slug, estimatedPayout, txHash);
      this.log.info('BeatTrader: redeemed winning position', {
        txHash,
        estimatedPayout,
        outcome,
        marketPnl,
        upHeld: this.balanceUp,
        downHeld: this.balanceDown,
      });
      this._recordAudit('redeem_result', {
        conditionId,
        txHash,
        outcome,
        estimatedPayout,
        marketPnl,
        upHeld: this.balanceUp,
        downHeld: this.balanceDown,
      });
      return true;
    } catch (err) {
      this.log.error('BeatTrader: redeem failed', { err: err.message });
      this._recordAudit('redeem_error', {
        conditionId,
        err: err.message,
        stack: err.stack ?? null,
      });
      return false;
    }
  }

  _recordAudit(eventType, payload = {}) {
    this.auditLog.write(eventType, {
      slug: this.market.slug,
      marketSymbol: traderSymbol(this.market, this.config),
      lifecycle: this.lifecycle,
      totalSpent: this.totalSpent,
      redeemedUsdc: this.redeemedUsdc,
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

  _estimateRedeemPayout(resolvedMarket) {
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
      pnl: patch.pnl ?? (this.redeemedUsdc - this.totalSpent),
      settledAt: patch.settledAt ?? null,
      updatedAt: Date.now(),
    });
  }

  _defaultTradeStatus() {
    return tradeStatusFromLifecycle(this.lifecycle, this.tradeSummary?.buyShares > 0);
  }
}
