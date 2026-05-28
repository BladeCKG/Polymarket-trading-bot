import { BtcPriceFeed } from './btc-price-feed.js';
import { BEAT_LIFECYCLE } from './lifecycle.js';
import { createBeatRuntimeConfig } from './runtime-config.js';
import { ClobClient } from '../clob.js';
import { getTokenBalances, redeemPositions, sleep } from '../onchain.js';
import { msUntil, waitForResolution } from '../market.js';
import { marketLogger } from '../logger.js';

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

function moveThresholdsForConfig(cfg) {
  const symbol = String(cfg.BEAT_MARKET_SYMBOL ?? 'BTC').toUpperCase();
  if (symbol === 'ETH') {
    return {
      upMin: cfg.BEAT_UP_MOVE_MIN_USD,
      upMax: cfg.BEAT_ETH_UP_MOVE_MAX_USD ?? cfg.BEAT_UP_MOVE_MAX_USD,
      downMin: cfg.BEAT_DOWN_MOVE_MIN_USD,
      downMax: cfg.BEAT_ETH_DOWN_MOVE_MAX_USD ?? cfg.BEAT_DOWN_MOVE_MAX_USD,
    };
  }
  return {
    upMin: cfg.BEAT_UP_MOVE_MIN_USD,
    upMax: cfg.BEAT_UP_MOVE_MAX_USD,
    downMin: cfg.BEAT_DOWN_MOVE_MIN_USD,
    downMax: cfg.BEAT_DOWN_MOVE_MAX_USD,
  };
}

export class BeatTrader {
  constructor(market, wallet, pnl, { dashboard = null, btcFeed = null, config = null } = {}) {
    this.market = market;
    this.wallet = wallet;
    this.pnl = pnl;
    this.dashboard = dashboard;
    this.log = marketLogger(market.slug);
    this.config = config ?? createBeatRuntimeConfig();

    this.lifecycle = BEAT_LIFECYCLE.UPCOMING;
    this.halted = false;
    this.balanceUp = 0;
    this.balanceDown = 0;
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
  }

  async run() {
    const cfg = this.config;
    const { windowTs, conditionId, upToken, downToken } = this.market;
    const windowClose = windowTs + cfg.MARKET_WINDOW_SECONDS;
    const skipEndMs = (windowTs * 1000) + (cfg.BEAT_ENTRY_DELAY_SECONDS * 1000);

    this.log.info('BeatTrader: starting', {
      conditionId,
      dryRun: cfg.BEAT_DRY_RUN,
      upTokenId: upToken.tokenId,
      downTokenId: downToken.tokenId,
      windowOpen: new Date(windowTs * 1000).toISOString(),
      windowClose: new Date(windowClose * 1000).toISOString(),
      skipSeconds: cfg.BEAT_ENTRY_DELAY_SECONDS,
      orderMode: cfg.BEAT_ORDER_MODE,
    });

    this._startBtcFeed();

    try {
      const waitMs = msUntil(windowTs);
      if (waitMs > 0) {
        this.log.debug('BeatTrader: waiting for market open', { waitMs: Math.round(waitMs) });
        await sleep(waitMs);
      }

      this.beatPrice = await this._captureBeatPrice(windowTs);

      const remainingSkipMs = skipEndMs - Date.now();
      if (remainingSkipMs > 0) {
        this.lifecycle = BEAT_LIFECYCLE.WAITING_SKIP;
        this._publishMarket({
          lifecycle: BEAT_LIFECYCLE.WAITING_SKIP,
          tradeStatus: BEAT_LIFECYCLE.WAITING_SKIP,
        });
        this.log.info('BeatTrader: skipping early market seconds', {
          skipSeconds: cfg.BEAT_ENTRY_DELAY_SECONDS,
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

  async _captureBeatPrice(windowTs) {
    let tick = null;
    try {
      tick = await this._btcFeed.fetchRestTick();
    } catch (err) {
      this.log.warn('BeatTrader: REST beat capture failed, falling back to live BTC tick', { err: err.message });
      tick = this._btcFeed.getLatest();
      if (!tick) {
        tick = await this._btcFeed.waitForTickAfter(windowTs * 1000, 20_000);
      }
    }
    this.latestBtcTick = tick;
    this._publishMarket({
      lifecycle: BEAT_LIFECYCLE.WAITING_SKIP,
      beatPrice: tick.price,
      btcPrice: tick.price,
      btcBestBid: tick.bestBid ?? null,
      btcBestAsk: tick.bestAsk ?? null,
    });
    this.log.info('BeatTrader: captured BTC beat price', {
      beatPrice: tick.price,
      btcTime: tick.isoTime,
      bestBid: tick.bestBid,
      bestAsk: tick.bestAsk,
    });
    return tick.price;
  }

  async _monitorLoop(windowClose) {
    const cfg = this.config;
    while (true) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= windowClose - cfg.STOP_BUYING_BEFORE_CLOSE) {
        this.log.info('BeatTrader: buy window closed', { stopBeforeClose: cfg.STOP_BUYING_BEFORE_CLOSE });
        break;
      }

      if (this._checkCircuitBreakers()) break;

      try {
        const snapshot = await this._snapshotMarketState();
        this._publishMarket({
          ...snapshot,
          lifecycle: BEAT_LIFECYCLE.MONITORING,
          tradeStatus: tradeStatusFromLifecycle(this.lifecycle, this.tradeSummary?.buyShares > 0),
        });
        await this._maybeBuy(snapshot);
      } catch (err) {
        this.log.warn('BeatTrader: monitor iteration failed', { err: err.message });
      }

      if (nowSec % 30 === 0) {
        await this._syncBalances(this.market.upToken.tokenId, this.market.downToken.tokenId);
      }

      await sleep(cfg.BEAT_BOOK_POLL_MS);
    }
  }

  async _snapshotMarketState() {
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

    return {
      upBestBid: upBid?.price ?? null,
      upBestAsk: upAsk?.price ?? null,
      downBestBid: downBid?.price ?? null,
      downBestAsk: downAsk?.price ?? null,
      beatPrice: this.beatPrice,
      btcPrice: this.latestBtcTick?.price ?? null,
    };
  }

  async _maybeBuy(snapshot = {}) {
    const cfg = this.config;
    if (!this.beatPrice) return;
    if (Date.now() - this.lastBuyAt < cfg.BEAT_BUY_COOLDOWN_MS) return;

    const tick = this.latestBtcTick;
    if (!tick) return;

    const ageMs = Date.now() - tick.timeMs;
    if (ageMs > cfg.BTC_PRICE_MAX_AGE_MS) {
      this.log.debug('BeatTrader: skipping stale BTC tick', { ageMs, maxAgeMs: cfg.BTC_PRICE_MAX_AGE_MS });
      return;
    }

    const delta = tick.price - this.beatPrice;
    const signal = this._signalFromDelta(delta);
    if (!signal) return;

    const bookState = {
      Up: {
        tokenId: this.market.upToken.tokenId,
        book: this.latestQuotes.up?.book ?? null,
        bid: this.latestQuotes.up?.bid ?? null,
        ask: this.latestQuotes.up?.ask ?? null,
        maxBuyPrice: cfg.BEAT_UP_MAX_BUY_PRICE,
      },
      Down: {
        tokenId: this.market.downToken.tokenId,
        book: this.latestQuotes.down?.book ?? null,
        bid: this.latestQuotes.down?.bid ?? null,
        ask: this.latestQuotes.down?.ask ?? null,
        maxBuyPrice: cfg.BEAT_DOWN_MAX_BUY_PRICE,
      },
    };

    const leg = bookState[signal.side];
    if (!leg.ask || leg.ask.price > leg.maxBuyPrice) return;

    const maxPrice = clampMaxPrice(leg.ask.price, leg.maxBuyPrice, cfg.BEAT_MAX_SLIPPAGE);
    if (maxPrice + 1e-9 < leg.ask.price) return;

    await this._executeBuy({
      side: signal.side,
      tokenId: leg.tokenId,
      book: leg.book,
      bestBid: leg.bid,
      bestAsk: leg.ask,
      maxPrice,
      delta,
      btcPrice: tick.price,
    });
  }

  _signalFromDelta(delta) {
    const cfg = this.config;
    const thresholds = moveThresholdsForConfig(cfg);
    if (delta > 0 && delta <= thresholds.upMax) {
      return { side: 'Up' };
    }
    const downMove = Math.abs(delta);
    if (delta <= 0 && downMove <= thresholds.downMax) {
      return { side: 'Down' };
    }
    return null;
  }

  async _executeBuy({ side, tokenId, book, bestBid, bestAsk, maxPrice, delta, btcPrice }) {
    const cfg = this.config;
    const remainingBudget = cfg.MAX_SPEND_PER_MARKET - this.totalSpent;
    if (remainingBudget < 1) {
      this.halted = true;
      return;
    }

    if (cfg.BEAT_ORDER_MODE === 'SHARES') {
      const requestedShares = Math.min(
        cfg.BEAT_ORDER_SIZE_SHARES,
        remainingBudget / Math.max(bestAsk.price, 0.0001),
      );
      if (requestedShares <= 0) return;

      const plan = estimateSharesFromBook(book, maxPrice, requestedShares);
      if (!plan.fullyFilled || plan.fillShares <= 0 || plan.spentUsdc <= 0) return;

      if (!cfg.BEAT_DRY_RUN) {
        try {
          const response = await ClobClient.postFOKLimitBuy(this.wallet, tokenId, maxPrice, plan.fillShares);
          if (response?.success === false) return;
        } catch (err) {
          this.log.warn('BeatTrader: directional share buy failed', { side, err: err.message });
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
      return;
    }

    const amountUsdc = Math.min(cfg.BEAT_ORDER_SIZE_USDC, remainingBudget);
    if (amountUsdc <= 0) return;

    const plan = ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, amountUsdc, 0);
    if (!plan || plan.fillShares <= 0 || plan.spentUsdc <= 0) return;

    if (!cfg.BEAT_DRY_RUN) {
      try {
        const response = await ClobClient.postIOCBuy(this.wallet, tokenId, maxPrice, amountUsdc);
        if (response?.success === false) return;
      } catch (err) {
        this.log.warn('BeatTrader: directional USDC buy failed', { side, err: err.message });
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
  }

  _checkCircuitBreakers() {
    const cfg = this.config;
    if (this.halted) return true;

    const imbalanceShares = Math.abs(this.balanceUp - this.balanceDown);
    if (imbalanceShares > cfg.MAX_INVENTORY_IMBALANCE) {
      this.log.warn('BeatTrader: inventory imbalance limit reached', {
        imbalanceShares,
        balanceUp: this.balanceUp,
        balanceDown: this.balanceDown,
      });
      this.halted = true;
      this.lifecycle = BEAT_LIFECYCLE.HALTED;
      return true;
    }

    if (this.totalSpent >= cfg.MAX_SPEND_PER_MARKET) {
      this.log.info('BeatTrader: spend cap reached', { totalSpent: this.totalSpent.toFixed(2) });
      this.halted = true;
      this.lifecycle = BEAT_LIFECYCLE.HALTED;
      return true;
    }

    return false;
  }

  async _cancelAllOrders(conditionId) {
    if (this.config.BEAT_DRY_RUN) {
      this.log.info('BeatTrader: dry-run cancel skipped', { conditionId });
      return;
    }
    try {
      await ClobClient.cancelMarket(conditionId);
    } catch (err) {
      this.log.warn('BeatTrader: cancelMarket failed, trying cancelAll', { err: err.message });
      try {
        await ClobClient.cancelAll();
      } catch (fallbackErr) {
        this.log.warn('BeatTrader: cancelAll failed', { err: fallbackErr.message });
      }
    }
  }

  async _syncBalances(upTokenId, downTokenId) {
    try {
      const balances = await getTokenBalances([upTokenId, downTokenId]);
      this.balanceUp = balances[upTokenId] ?? this.balanceUp;
      this.balanceDown = balances[downTokenId] ?? this.balanceDown;
      this.log.debug('BeatTrader: balances synced', {
        up: this.balanceUp,
        down: this.balanceDown,
      });
    } catch (err) {
      this.log.warn('BeatTrader: balance sync failed', { err: err.message });
    }
  }

  async _redeemPhase(conditionId, windowClose) {
    const cfg = this.config;
    const redeemNotBeforeMs = (windowClose + cfg.REDEEM_DELAY_AFTER_CLOSE) * 1000;
    const waitMs = redeemNotBeforeMs - Date.now();
    if (waitMs > 0) {
      this.log.debug('BeatTrader: waiting for resolution window', { waitMs });
      await sleep(waitMs);
    }

    let resolvedMarket = null;
    try {
      resolvedMarket = await waitForResolution(this.market, 400_000, 10_000);
    } catch (err) {
      this.log.warn('BeatTrader: resolution poll timed out, redeeming anyway', { err: err.message });
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

    if (cfg.BEAT_DRY_RUN) {
      this.pnl.recordRedeem(this.market.slug, marketPnl, 'dry-run');
      this.log.info('BeatTrader: dry-run settlement simulated', {
        outcome,
        estimatedPayout,
        marketPnl,
        upHeld: this.balanceUp,
        downHeld: this.balanceDown,
      });
      return;
    }

    const totalHeld = this.balanceUp + this.balanceDown;
    if (totalHeld < 0.001) {
      this.log.info('BeatTrader: no tokens to redeem');
      this.pnl.recordRedeem(this.market.slug, marketPnl, 'none');
      return;
    }

    try {
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
    } catch (err) {
      this.log.error('BeatTrader: redeem failed', { err: err.message });
    }
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
