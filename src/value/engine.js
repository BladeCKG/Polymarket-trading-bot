import { EventEmitter } from 'events';
import logger from '../logger.js';
import { ClobClient } from '../clob.js';
import { waitForResolution } from '../market.js';
import {
  VALUE_DRY_RUN,
  VALUE_ENTRY_MIN_PRICE,
  VALUE_ENTRY_MAX_PRICE,
  VALUE_FIRST_LEG_CUTOFF_SECONDS,
  VALUE_LEG_USDC,
  VALUE_MAX_OPEN_MARKETS,
  VALUE_MAX_SLIPPAGE,
  VALUE_MAX_STRANDED_LEGS,
  VALUE_ORDER_MODE,
  VALUE_SECOND_LEG_CUTOFF_SECONDS,
  VALUE_TARGET_SHARES,
} from './config.js';
import {
  bestAskFromBook,
  bestBidFromBook,
  estimateBuyCostForSharesFromBook,
  estimateSellProceedsForSharesFromBook,
} from './bookMath.js';

function oppositeSide(side) {
  return side === 'Up' ? 'Down' : 'Up';
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function bookSnapshot(book) {
  return {
    bids: Array.isArray(book?.bids) ? book.bids.map((bid) => ({ price: bid.price, size: bid.size })) : [],
    asks: Array.isArray(book?.asks) ? book.asks.map((ask) => ({ price: ask.price, size: ask.size })) : [],
    tickSize: book?.tickSize ?? null,
    minOrderSize: book?.minOrderSize ?? null,
  };
}

export class ValueStrategyEngine extends EventEmitter {
  constructor(wallet) {
    super();
    this.wallet = wallet;
    this.markets = new Map();
    this.actions = 0;
    this.failures = 0;
    this.settlementTasks = new Map();
  }

  syncMarkets(activeMarkets) {
    const activeKeys = new Set(activeMarkets.map((market) => market.slug));

    for (const market of activeMarkets) {
      const existing = this.markets.get(market.slug);
      if (existing) {
        Object.assign(existing, market);
        continue;
      }
      this.markets.set(market.slug, this._createMarketState(market));
    }

    for (const [slug, market] of this.markets) {
      if (market.settled) continue;
      if (activeKeys.has(slug)) continue;
      if (this._hasOpenExposure(market)) {
        market.active = false;
        this._ensureSettlementWatch(market);
      }
    }

    this.emit('markets-updated', this.snapshotMarkets());
  }

  async pollOnce() {
    const openMarkets = [...this.markets.values()].filter((market) => !market.settled);
    for (const market of openMarkets) {
      await this._pollMarket(market);
    }
    this.emit('markets-updated', this.snapshotMarkets());
  }

  stats() {
    const markets = [...this.markets.values()];
    const openMarkets = markets.filter((market) => this._hasOpenExposure(market));
    const pairedOpen = openMarkets.filter((market) => market.state === 'PAIRED').length;
    const strandedOpen = openMarkets.filter((market) =>
      market.state === 'WAIT_UP' || market.state === 'WAIT_DOWN'
    ).length;
    const closedMarkets = markets.filter((market) => market.settled || market.state === 'FLAT').length;
    const openCost = openMarkets.reduce((sum, market) => sum + market.totalCost - market.cashProceeds, 0);
    const settledPnl = markets
      .filter((market) => market.settled || market.state === 'FLAT')
      .reduce((sum, market) => sum + Number(market.pnl ?? 0), 0);

    return {
      trackedMarkets: markets.length,
      openMarkets: openMarkets.length,
      pairedOpenMarkets: pairedOpen,
      strandedOpenMarkets: strandedOpen,
      settledMarkets: closedMarkets,
      openCost: openCost.toFixed(2),
      settledPnl: settledPnl.toFixed(2),
      actions: this.actions,
      failures: this.failures,
    };
  }

  snapshotMarkets() {
    return [...this.markets.values()]
      .sort((a, b) => a.closeTs - b.closeTs)
      .map((market) => ({
        slug: market.slug,
        question: market.question,
        conditionId: market.conditionId,
        closeTs: market.closeTs,
        timeLeftSec: Math.max(0, market.closeTs - nowSec()),
        marketState: market.settled ? 'SETTLED' : 'OPEN',
        state: market.state,
        entryBand: `${VALUE_ENTRY_MIN_PRICE.toFixed(2)}-${VALUE_ENTRY_MAX_PRICE.toFixed(2)}`,
        firstSide: market.firstSide,
        positionType: this._positionType(market),
        enteredLegs: this._enteredLegs(market),
        winningOutcome: this._winningOutcome(market),
        upAsk: market.quote.Up?.bestAsk ?? null,
        upBid: market.quote.Up?.bestBid ?? null,
        downAsk: market.quote.Down?.bestAsk ?? null,
        downBid: market.quote.Down?.bestBid ?? null,
        upStatus: this._legStatus(market.legs.Up),
        upSpent: market.legs.Up.spent,
        upShares: market.legs.Up.shares,
        upPrice: market.legs.Up.avgPrice,
        upSoldShares: market.legs.Up.soldShares,
        upSoldUsdc: market.legs.Up.soldUsdc,
        upSellPrice: market.legs.Up.sellAvgPrice,
        downStatus: this._legStatus(market.legs.Down),
        downSpent: market.legs.Down.spent,
        downShares: market.legs.Down.shares,
        downPrice: market.legs.Down.avgPrice,
        downSoldShares: market.legs.Down.soldShares,
        downSoldUsdc: market.legs.Down.soldUsdc,
        downSellPrice: market.legs.Down.sellAvgPrice,
        totalCost: market.totalCost,
        cashProceeds: market.cashProceeds,
        redeemed: market.redeemed,
        pnl: market.pnl,
        lastAction: market.lastAction,
      }));
  }

  _createMarketState(market) {
    return {
      ...market,
      state: 'NONE',
      active: true,
      firstSide: null,
      lastAction: null,
      quote: { Up: null, Down: null },
      legs: {
        Up: this._emptyLeg(market.upToken.tokenId),
        Down: this._emptyLeg(market.downToken.tokenId),
      },
      totalCost: 0,
      cashProceeds: 0,
      redeemed: 0,
      pnl: null,
      settled: false,
      settledAt: null,
      hasAnyLeg: false,
      hadAnyTrade: false,
      outcomes: [],
      payouts: [],
    };
  }

  _positionType(market) {
    const up = this._openShares(market.legs.Up) > 1e-9;
    const down = this._openShares(market.legs.Down) > 1e-9;
    if (up && down) return 'Paired';
    if (up) return 'Up only';
    if (down) return 'Down only';
    return market.hadAnyTrade ? 'Flat' : 'None';
  }

  _enteredLegs(market) {
    return ['Up', 'Down'].filter((side) => market.legs[side].entered);
  }

  _winningOutcome(market) {
    if (!market.settled) return null;
    const pairs = (market.outcomes ?? []).map((outcome, index) => ({
      outcome,
      payout: Number(market.payouts?.[index] ?? 0),
    }));
    const winner = pairs.find((pair) => pair.payout > 0);
    return winner?.outcome ?? null;
  }

  _emptyLeg(tokenId) {
    return {
      tokenId,
      entered: false,
      spent: 0,
      shares: 0,
      avgPrice: null,
      soldShares: 0,
      soldUsdc: 0,
      sellAvgPrice: null,
      enteredAt: null,
      soldAt: null,
      response: null,
    };
  }

  _legStatus(leg) {
    if (!leg.entered) return 'waiting';
    if (this._openShares(leg) <= 1e-9) return 'exited';
    return 'entered';
  }

  _openShares(leg) {
    return Math.max(0, Number(leg.shares ?? 0) - Number(leg.soldShares ?? 0));
  }

  _hasOpenExposure(market) {
    return !market.settled && ['WAIT_UP', 'WAIT_DOWN', 'PAIRED'].includes(market.state);
  }

  async _pollMarket(market) {
    const [upBook, downBook] = await Promise.all([
      this._getBookIfLive(market, 'Up', market.upToken.tokenId),
      this._getBookIfLive(market, 'Down', market.downToken.tokenId),
    ]);

    if (!upBook || !downBook) {
      market.quote.Up = { bestAsk: upBook ? (bestAskFromBook(upBook)?.price ?? null) : null };
      market.quote.Down = { bestAsk: downBook ? (bestAskFromBook(downBook)?.price ?? null) : null };
      return;
    }

    market.quote.Up = { bestAsk: bestAskFromBook(upBook)?.price ?? null };
    market.quote.Down = { bestAsk: bestAskFromBook(downBook)?.price ?? null };
    market.quote.Up.bestBid = bestBidFromBook(upBook)?.price ?? null;
    market.quote.Down.bestBid = bestBidFromBook(downBook)?.price ?? null;

    const timeLeftSec = market.closeTs - nowSec();
    if (timeLeftSec <= 0) {
      if (this._hasOpenExposure(market)) this._ensureSettlementWatch(market);
      return;
    }

    if (market.state === 'NONE') {
      if (this._countOpenMarkets() >= VALUE_MAX_OPEN_MARKETS) return;
      if (this._countStrandedLegs() >= VALUE_MAX_STRANDED_LEGS) return;
      if (timeLeftSec <= VALUE_FIRST_LEG_CUTOFF_SECONDS) return;

      const upInBand = this._isInBand(market.quote.Up?.bestAsk);
      const downInBand = this._isInBand(market.quote.Down?.bestAsk);
      if (upInBand) await this._enterLeg(market, 'Up', upBook);
      if (downInBand && market.state === 'NONE') await this._enterLeg(market, 'Down', downBook);
      return;
    }

    if (market.state === 'WAIT_DOWN') {
      if (timeLeftSec <= VALUE_SECOND_LEG_CUTOFF_SECONDS) {
        await this._handleEndgame(market, 'Up', upBook, 'Down', downBook);
        return;
      }
      if (this._isSecondLegEligible(market.quote.Down?.bestAsk)) {
        await this._enterLeg(market, 'Down', downBook);
      }
      return;
    }

    if (market.state === 'WAIT_UP') {
      if (timeLeftSec <= VALUE_SECOND_LEG_CUTOFF_SECONDS) {
        await this._handleEndgame(market, 'Down', downBook, 'Up', upBook);
        return;
      }
      if (this._isSecondLegEligible(market.quote.Up?.bestAsk)) {
        await this._enterLeg(market, 'Up', upBook);
      }
    }
  }

  async _getBookIfLive(market, side, tokenId) {
    try {
      return await ClobClient.getBook(tokenId, { quietNotFound: true });
    } catch (err) {
      if (err.response?.status === 404) {
        logger.debug('value.engine: orderbook not live yet', {
          slug: market.slug,
          side,
          tokenId,
        });
        return null;
      }
      throw err;
    }
  }

  _isInBand(price) {
    return Number.isFinite(price) && price >= VALUE_ENTRY_MIN_PRICE && price <= VALUE_ENTRY_MAX_PRICE;
  }

  _isSecondLegEligible(price) {
    return Number.isFinite(price) && price <= VALUE_ENTRY_MAX_PRICE;
  }

  _countOpenMarkets() {
    return [...this.markets.values()].filter((market) => this._hasOpenExposure(market)).length;
  }

  _countStrandedLegs() {
    return [...this.markets.values()].filter((market) =>
      !market.settled && (market.state === 'WAIT_UP' || market.state === 'WAIT_DOWN')
    ).length;
  }

  async _enterLeg(market, side, book, { force = false } = {}) {
    const leg = market.legs[side];
    if (leg.entered) return;

    const quote = bestAskFromBook(book);
    const eligible = force
      ? Number.isFinite(quote?.price) && quote.price > 0
      : market.state === 'NONE'
      ? this._isInBand(quote?.price)
      : this._isSecondLegEligible(quote?.price);
    if (!quote || !eligible) return;

    const maxPrice = this._entryMaxPrice(market, quote.price, force);

    const plan = VALUE_ORDER_MODE === 'SHARES'
      ? estimateBuyCostForSharesFromBook(book, VALUE_TARGET_SHARES, maxPrice)
      : ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, VALUE_LEG_USDC, 0);
    if (!plan || plan.fillShares <= 0 || plan.spentUsdc <= 0) return;

    const tokenId = side === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const snapshot = bookSnapshot(book);
    try {
      let response = null;
      if (!VALUE_DRY_RUN) {
        response = await ClobClient.postIOCBuy(this.wallet, tokenId, maxPrice, plan.spentUsdc);
      }

      leg.entered = true;
      leg.spent = plan.spentUsdc;
      leg.shares = plan.fillShares;
      leg.avgPrice = plan.avgFillPrice ?? quote.price;
      leg.enteredAt = Date.now();
      leg.response = response;
      market.totalCost += leg.spent;
      market.hasAnyLeg = true;
      market.hadAnyTrade = true;
      if (!market.firstSide) market.firstSide = side;
      market.lastAction = `${VALUE_DRY_RUN ? 'dry-run' : 'buy'} ${side.toLowerCase()} @ ${leg.avgPrice.toFixed(4)}`;
      market.state = this._computeState(market);
      this.actions += 1;
      if (market.state === 'PAIRED') this._ensureSettlementWatch(market);

      const action = {
        type: VALUE_DRY_RUN ? 'dry-run-buy' : 'buy',
        slug: market.slug,
        side,
        state: market.state,
        spent: leg.spent,
        shares: leg.shares,
        price: leg.avgPrice,
        forced: force,
        tokenId,
        bestAsk: quote.price,
        maxPrice,
        orderMode: VALUE_ORDER_MODE,
        executionPlan: plan,
        book: snapshot,
        timestamp: Date.now(),
        response,
      };
      this.emit('action', action);
      logger.info('value.engine: leg entered', {
        slug: market.slug,
        side,
        state: market.state,
        spent: leg.spent,
        shares: leg.shares,
        avgPrice: leg.avgPrice,
        forced: force,
        tokenId,
        bestAsk: quote.price,
        maxPrice,
        executionPlan: plan,
        dryRun: VALUE_DRY_RUN,
      });
      this.emit('markets-updated', this.snapshotMarkets());
      if (market.state === 'PAIRED') {
        this.emit('action', {
          type: 'paired',
          slug: market.slug,
          side,
          state: market.state,
          spent: market.totalCost,
          shares: market.legs.Up.shares + market.legs.Down.shares,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.failures += 1;
      logger.warn('value.engine: leg entry failed', {
        slug: market.slug,
        side,
        err: err.message,
      });
      this.emit('action', {
        type: 'failed',
        slug: market.slug,
        side,
        state: market.state,
        spent: plan.spentUsdc,
        shares: plan.fillShares,
        tokenId,
        bestAsk: quote?.price ?? null,
        maxPrice,
        executionPlan: plan,
        book: snapshot,
        timestamp: Date.now(),
      });
    }
  }

  _computeState(market) {
    const up = this._openShares(market.legs.Up) > 1e-9;
    const down = this._openShares(market.legs.Down) > 1e-9;
    if (up && down) return 'PAIRED';
    if (up) return 'WAIT_DOWN';
    if (down) return 'WAIT_UP';
    return market.hadAnyTrade ? 'FLAT' : 'NONE';
  }

  _entryMaxPrice(market, bestAsk, force = false) {
    if (force) {
      return Math.min(0.99, Number((bestAsk + VALUE_MAX_SLIPPAGE).toFixed(4)));
    }
    if (market.state === 'NONE') {
      return Math.min(
        VALUE_ENTRY_MAX_PRICE,
        Number((bestAsk + VALUE_MAX_SLIPPAGE).toFixed(4)),
      );
    }
    return Math.min(0.99, Number((bestAsk + VALUE_MAX_SLIPPAGE).toFixed(4)));
  }

  async _handleEndgame(market, openSide, openBook, oppositeSide, oppositeBook) {
    const flattened = await this._flattenOpenLeg(market, openSide, openBook);
    if (flattened) return;
    await this._enterLeg(market, oppositeSide, oppositeBook, { force: true });
  }

  async _flattenOpenLeg(market, side, book) {
    const leg = market.legs[side];
    const openShares = this._openShares(leg);
    if (openShares <= 1e-9) return true;

    const bestBid = bestBidFromBook(book);
    if (!bestBid || !Number.isFinite(bestBid.price) || bestBid.price <= 0) {
      return false;
    }

    const minPrice = Math.max(0.01, Number((bestBid.price - VALUE_MAX_SLIPPAGE).toFixed(4)));
    const plan = estimateSellProceedsForSharesFromBook(book, openShares, minPrice);
    if (!plan || !plan.fullyFilled || plan.soldShares <= 0 || plan.proceedsUsdc <= 0) {
      return false;
    }

    const tokenId = side === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const snapshot = bookSnapshot(book);
    try {
      let response = null;
      if (!VALUE_DRY_RUN) {
        response = await ClobClient.postFOKSell(this.wallet, tokenId, minPrice, openShares);
        if (response?.success === false) return false;
      }

      leg.soldShares += plan.soldShares;
      leg.soldUsdc += plan.proceedsUsdc;
      leg.sellAvgPrice = plan.avgFillPrice ?? bestBid.price;
      leg.soldAt = Date.now();
      leg.response = response;
      market.cashProceeds += plan.proceedsUsdc;
      market.lastAction = `${VALUE_DRY_RUN ? 'dry-run' : 'sell'} ${side.toLowerCase()} @ ${leg.sellAvgPrice.toFixed(4)}`;
      market.state = this._computeState(market);
      market.pnl = market.cashProceeds + market.redeemed - market.totalCost;
      this.actions += 1;

      this.emit('action', {
        type: VALUE_DRY_RUN ? 'dry-run-sell' : 'sell',
        slug: market.slug,
        side,
        state: market.state,
        spent: plan.proceedsUsdc,
        shares: plan.soldShares,
        price: leg.sellAvgPrice,
        tokenId,
        bestBid: bestBid.price,
        minPrice,
        executionPlan: plan,
        book: snapshot,
        timestamp: Date.now(),
        response,
      });
      logger.info('value.engine: leg flattened', {
        slug: market.slug,
        side,
        state: market.state,
        soldShares: plan.soldShares,
        proceedsUsdc: plan.proceedsUsdc,
        avgPrice: leg.sellAvgPrice,
        tokenId,
        bestBid: bestBid.price,
        minPrice,
        executionPlan: plan,
        dryRun: VALUE_DRY_RUN,
      });
      this.emit('markets-updated', this.snapshotMarkets());
      return true;
    } catch (err) {
      this.failures += 1;
      logger.warn('value.engine: flatten failed', {
        slug: market.slug,
        side,
        err: err.message,
      });
      this.emit('action', {
        type: 'flatten-failed',
        slug: market.slug,
        side,
        state: market.state,
        spent: plan.proceedsUsdc,
        shares: plan.soldShares,
        tokenId,
        bestBid: bestBid.price,
        minPrice,
        executionPlan: plan,
        book: snapshot,
        timestamp: Date.now(),
      });
      return false;
    }
  }

  _ensureSettlementWatch(market) {
    if (this.settlementTasks.has(market.slug)) return;

    const task = (async () => {
      try {
        const resolved = await waitForResolution({
          slug: market.slug,
          conditionId: market.conditionId,
        }, 12 * 60 * 60 * 1000, 10_000);
        this._settleMarket(market, resolved);
      } catch (err) {
        logger.warn('value.engine: failed to settle market', {
          slug: market.slug,
          err: err.message,
        });
      } finally {
        this.settlementTasks.delete(market.slug);
      }
    })();

    this.settlementTasks.set(market.slug, task);
  }

  _settleMarket(market, resolved) {
    if (market.settled) return;

    const outcomes = resolved.outcomes ?? [];
    const payouts = resolved.resolvedPayouts ?? [];
    const payoutByOutcome = new Map(
      outcomes.map((outcome, index) => [outcome, Number(payouts[index] ?? 0)])
    );

    const upRedeemed = this._openShares(market.legs.Up) * (payoutByOutcome.get('Up') ?? 0);
    const downRedeemed = this._openShares(market.legs.Down) * (payoutByOutcome.get('Down') ?? 0);
    market.redeemed = upRedeemed + downRedeemed;
    market.pnl = market.cashProceeds + market.redeemed - market.totalCost;
    market.settled = true;
    market.settledAt = Date.now();
    market.state = 'SETTLED';
    market.outcomes = outcomes;
    market.payouts = payouts;
    market.lastAction = `settled pnl ${market.pnl.toFixed(4)}`;

    this.emit('action', {
      type: 'settled',
      slug: market.slug,
      side: null,
      state: market.state,
      spent: market.totalCost,
      shares: market.legs.Up.shares + market.legs.Down.shares,
      timestamp: Date.now(),
    });
    logger.info('value.engine: market settled', {
      slug: market.slug,
      state: market.state,
      totalCost: market.totalCost,
      redeemed: market.redeemed,
      pnl: market.pnl,
    });
    this.emit('markets-updated', this.snapshotMarkets());
  }
}
