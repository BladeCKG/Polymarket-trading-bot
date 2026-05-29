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
  constructor(market, wallet, pnl, { dashboard = null, btcFeed = null, bookFeed = null, config = null, onSettled = null } = {}) {
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
    this._btcFeed = btcFeed;
    this._ownsBtcFeed = !btcFeed;
    this._btcFeedAttached = false;
    this._bookFeed = bookFeed;
    this._ownsBookFeed = !bookFeed;
    this._bookFeedAttached = false;
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
    await this._redeemPhase(conditionId, windowClose);

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
    // Determine per-moment thresholds (seconds after market open)
    const secondsAfterOpen = Math.floor(Date.now() / 1000) - this.market.windowTs;
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
    if (absoluteMove > Math.max(thresholds.upMax, thresholds.downMax)) {
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
        if (!leg.ask) {
          return { side, leg, affordable: false, maxPrice: null, reason: 'missing-best-ask' };
        }
        if (!Number.isFinite(leg.bookAgeMs) || leg.bookAgeMs > cfg.BEAT_BOOK_MAX_AGE_MS) {
          return { side, leg, affordable: false, maxPrice: null, reason: 'stale-book' };
        }
        if (leg.ask.price > leg.maxBuyPrice) {
          return { side, leg, affordable: false, maxPrice: null, reason: 'ask-above-buy-max' };
        }
        const maxPrice = clampMaxPrice(leg.ask.price, leg.maxBuyPrice, cfg.BEAT_MAX_SLIPPAGE);
        if (maxPrice + 1e-9 < leg.ask.price) {
          return { side, leg, affordable: false, maxPrice, reason: 'clamped-price-below-ask' };
        }
        return { side, leg, affordable: true, maxPrice, reason: null };
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
          maxBuyPrice: entry.leg.maxBuyPrice,
          maxPrice: entry.maxPrice,
        })),
      });
      return;
    }

    const selected = affordableLegs
      .sort((a, b) => {
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
        maxBuyPrice: entry.leg.maxBuyPrice,
        maxPrice: entry.maxPrice,
      })),
      selectedLeg: {
        tokenId: leg.tokenId,
        bestBid: leg.bid,
        bestAsk: leg.ask,
        bookAgeMs: leg.bookAgeMs ?? null,
        maxBuyPrice: leg.maxBuyPrice,
        maxPrice,
      },
      ofiDecision,
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

  _recordBuy(side, avgPrice, shares, spentOverride = null, moveAtBuyUsd = null, btcPriceAtBuy = null) {
    const spentUsdc = spentOverride ?? (avgPrice * shares);
    this.totalSpent += spentUsdc;
    if (side === 'Up') this.balanceUp += shares;
    else this.balanceDown += shares;
    this.pnl.recordBuy(this.market.slug, side, avgPrice, shares);

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
      tradeSummary: this.tradeSummary,
    });
  }

  _checkCircuitBreakers() {
    const cfg = this.config;
    if (this.halted) return true;

    const imbalanceShares = Math.abs(this.balanceUp - this.balanceDown);
    if (imbalanceShares > cfg.BEAT_MAX_INVENTORY_IMBALANCE_SHARES) {
      this.log.warn('BeatTrader: inventory imbalance limit reached', {
        imbalanceShares,
        balanceUp: this.balanceUp,
        balanceDown: this.balanceDown,
        maxInventoryImbalanceShares: cfg.BEAT_MAX_INVENTORY_IMBALANCE_SHARES,
      });
      this._recordAudit('circuit_breaker', {
        reason: 'inventory-imbalance',
        imbalanceShares,
        balanceUp: this.balanceUp,
        balanceDown: this.balanceDown,
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
    const imbalance = this.balanceUp - this.balanceDown;
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
    try {
      resolvedMarket = await waitForResolution(this.market, 400_000, 10_000);
    } catch (err) {
      this.log.warn('BeatTrader: resolution poll timed out, redeeming anyway', { err: err.message });
      this._recordAudit('resolution_timeout', { err: err.message });
    }

    const outcome = this._resolveOutcome(resolvedMarket);
    this.lastOutcome = outcome;
    this.lastSettledAt = Date.now();
    const estimatedPayout = this._estimateRedeemPayout(resolvedMarket);
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
    });

    if (cfg.BEAT_DRY_RUN) {
      this.pnl.recordRedeem(this.market.slug, marketPnl, 'dry-run');
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
      return;
    }

    const totalHeld = this.balanceUp + this.balanceDown;
    if (totalHeld < 0.001) {
      this.log.info('BeatTrader: no tokens to redeem');
      this.pnl.recordRedeem(this.market.slug, marketPnl, 'none');
      this._recordAudit('redeem_skipped', {
        reason: 'no-tokens-held',
        totalHeld,
        outcome,
        estimatedPayout,
      });
      return;
    }

    try {
      this._recordAudit('redeem_submit', { conditionId, totalHeld, outcome });
      const txHash = await redeemPositions(conditionId);
      this.pnl.recordRedeem(this.market.slug, marketPnl, txHash);
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
    } catch (err) {
      this.log.error('BeatTrader: redeem failed', { err: err.message });
      this._recordAudit('redeem_error', {
        conditionId,
        err: err.message,
        stack: err.stack ?? null,
      });
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
    return Math.max(this.balanceUp, this.balanceDown);
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
