import { EventEmitter } from 'events';
import logger from '../logger.js';
import { ClobClient } from '../clob.js';
import { waitForResolution } from '../market.js';
import {
  COMBINED_ASK_STOP,
  MAX_TAKER_FILL_USDC,
  TARGET_EDGE,
} from '../config.js';
import {
  VALUE_DRY_RUN,
  VALUE_ENDGAME_EXIT_BELOW_PRICE,
  VALUE_IMMEDIATE_EXIT_BELOW_PRICE,
  VALUE_FIRST_LEG_CUTOFF_SECONDS,
  VALUE_LEG_USDC,
  VALUE_MAX_OPEN_MARKETS,
  VALUE_MAX_SLIPPAGE,
  VALUE_MAX_STRANDED_LEGS,
  VALUE_ORDER_MODE,
  VALUE_SECOND_LEG_CUTOFF_SECONDS,
  VALUE_TARGET_PRICE,
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

function sideQuotes(quote) {
  return {
    bestAsk: quote?.bestAsk ?? null,
    bestBid: quote?.bestBid ?? null,
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
        if ((existing.closed || existing.resolved) && this._hasOpenExposure(existing)) {
          this._ensureSettlementWatch(existing);
        }
        continue;
      }
      const created = this._createMarketState(market);
      this.markets.set(market.slug, created);
      if ((created.closed || created.resolved) && this._hasOpenExposure(created)) {
        this._ensureSettlementWatch(created);
      }
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
    const results = await Promise.allSettled(
      openMarkets.map((market) => this._pollMarket(market))
    );
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (result.status === 'fulfilled') continue;
      logger.debug('value.engine: market poll failed', {
        slug: openMarkets[i]?.slug ?? null,
        err: result.reason?.message ?? String(result.reason),
      });
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
    const closed = markets.filter((market) => market.settled || market.state === 'FLAT');
    const closedMarkets = closed.length;
    const openCost = openMarkets.reduce((sum, market) => sum + market.totalCost - market.cashProceeds, 0);
    const settledPnl = closed.reduce((sum, market) => sum + Number(market.pnl ?? 0), 0);
    const profitMarkets = closed.filter((market) => Number(market.pnl ?? 0) > 0).length;
    const lossMarkets = closed.filter((market) => Number(market.pnl ?? 0) < 0).length;

    return {
      trackedMarkets: markets.length,
      openMarkets: openMarkets.length,
      pairedOpenMarkets: pairedOpen,
      strandedOpenMarkets: strandedOpen,
      settledMarkets: closedMarkets,
      profitMarkets,
      lossMarkets,
      openCost: openCost.toFixed(2),
      settledPnl: settledPnl.toFixed(2),
      actions: this.actions,
      failures: this.failures,
    };
  }

  snapshotMarkets() {
    return [...this.markets.values()]
      .sort((a, b) => b.closeTs - a.closeTs)
      .map((market) => ({
        slug: market.slug,
        question: market.question,
        conditionId: market.conditionId,
        closeTs: market.closeTs,
        timeLeftSec: Math.max(0, market.closeTs - nowSec()),
        marketState: market.settled ? 'SETTLED' : 'OPEN',
        state: market.state,
        targetPrice: VALUE_TARGET_PRICE,
        firstSide: market.firstSide,
        strategyType: market.arbPairCount > 0 && market.hadAnyTrade ? (market.firstSide === 'Pair' ? 'Arb' : 'Mixed') : 'Value',
        arbPairCount: market.arbPairCount,
        arbPairShares: market.arbPairShares,
        arbPairSpent: market.arbPairSpent,
        positionType: this._positionType(market),
        enteredLegs: this._enteredLegs(market),
        winningOutcome: this._winningOutcome(market),
        upFinalValue: this._outcomePayout(market, 'Up'),
        downFinalValue: this._outcomePayout(market, 'Down'),
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
        settlementSource: market.settlementSource,
        lastAction: market.lastAction,
      }));
  }

  _outcomePayout(market, outcomeName) {
    if (!Array.isArray(market.outcomes) || !Array.isArray(market.payouts)) return null;
    const index = market.outcomes.findIndex((outcome) => outcome === outcomeName);
    if (index < 0) return null;
    const payout = Number(market.payouts[index] ?? 0);
    return Number.isFinite(payout) ? payout : null;
  }

  _createMarketState(market) {
    return {
      ...market,
      state: 'NONE',
      active: true,
      firstSide: null,
      lastAction: null,
      quote: { Up: null, Down: null },
      lastLiveQuote: { Up: null, Down: null },
      pendingBuyOrders: { Up: null, Down: null },
      exitPlan: null,
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
      settlementSource: null,
      hasAnyLeg: false,
      hadAnyTrade: false,
      arbPairCount: 0,
      arbPairShares: 0,
      arbPairSpent: 0,
      hadImmediateExit: false,
      hadForcePair: false,
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
      arbShares: 0,
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

  _valueOpenShares(market, side) {
    const leg = market.legs[side];
    return Math.max(0, this._openShares(leg) - Number(leg.arbShares ?? 0));
  }

  _hasOpenExposure(market) {
    return !market.settled && ['WAIT_UP', 'WAIT_DOWN', 'PAIRED'].includes(market.state);
  }

  async _pollMarket(market) {
    const [upBook, downBook] = await Promise.all([
      this._getBookIfLive(market, 'Up', market.upToken.tokenId),
      this._getBookIfLive(market, 'Down', market.downToken.tokenId),
    ]);

    market.quote.Up = {
      bestAsk: upBook ? (bestAskFromBook(upBook)?.price ?? null) : null,
      bestBid: upBook ? (bestBidFromBook(upBook)?.price ?? null) : null,
    };
    market.quote.Down = {
      bestAsk: downBook ? (bestAskFromBook(downBook)?.price ?? null) : null,
      bestBid: downBook ? (bestBidFromBook(downBook)?.price ?? null) : null,
    };
    this._updateLastLiveQuote(market, 'Up');
    this._updateLastLiveQuote(market, 'Down');

    const timeLeftSec = market.closeTs - nowSec();
    this._emitQuote(market, {
      timeLeftSec,
      upBookLive: Boolean(upBook),
      downBookLive: Boolean(downBook),
    });
    if (timeLeftSec <= 0) {
      await this._cancelMarketOrders(market, 'market-closed');
      const estimated = this._estimateCloseResolution(market);
      if (estimated) {
        this._settleMarket(market, estimated, { source: 'close-price-estimate' });
        return;
      }
      if (this._hasOpenExposure(market)) this._ensureSettlementWatch(market);
      this._emitDecision(market, {
        type: 'poll-skip',
        side: null,
        reason: 'awaiting-resolution-fallback',
        timeLeftSec,
      });
      return;
    }

    if (market.state === 'NONE') {
      if (this._countOpenMarkets() >= VALUE_MAX_OPEN_MARKETS) {
        await this._cancelMarketOrders(market, 'max-open-markets');
        this._emitDecision(market, {
          type: 'poll-skip',
          side: null,
          reason: 'max-open-markets',
          timeLeftSec,
        });
        return;
      }
      if (this._countStrandedLegs() >= VALUE_MAX_STRANDED_LEGS) {
        await this._cancelMarketOrders(market, 'max-stranded-legs');
        this._emitDecision(market, {
          type: 'poll-skip',
          side: null,
          reason: 'max-stranded-legs',
          timeLeftSec,
        });
        return;
      }
      if (timeLeftSec <= VALUE_FIRST_LEG_CUTOFF_SECONDS) {
        await this._cancelMarketOrders(market, 'first-leg-cutoff');
        this._emitDecision(market, {
          type: 'poll-skip',
          side: null,
          reason: 'first-leg-cutoff',
          timeLeftSec,
        });
        return;
      }
      if (await this._tryArbPair(market, upBook, downBook)) {
        return;
      }
      await this._ensureFirstLegOrders(market);
      await this._simulatePendingFills(market);
      return;
    }

    if (market.state === 'WAIT_DOWN') {
      await this._ensureSecondLegAndExit(market);
      await this._simulatePendingFills(market);
      if (market.state !== 'WAIT_DOWN') return;
      if (await this._simulateExitFill(market, 'Up', upBook, downBook)) return;
      if (this._shouldImmediateExitStrandedLeg(market, 'Up', upBook)) {
        await this._cancelMarketOrders(market, 'immediate-exit');
        await this._handleEndgame(market, 'Up', upBook, 'Down', downBook, { immediate: true });
        return;
      }
      if (timeLeftSec <= VALUE_SECOND_LEG_CUTOFF_SECONDS) {
        await this._cancelMarketOrders(market, 'second-leg-cutoff');
        await this._handleEndgame(market, 'Up', upBook, 'Down', downBook);
        return;
      }
      this._emitDecision(market, {
        type: 'waiting',
        side: 'Down',
        reason: market.pendingBuyOrders.Down ? 'second-order-resting' : 'second-order-missing',
        timeLeftSec,
        waitingFor: 'Down',
        quote: sideQuotes(market.quote.Down),
        exitPlan: market.exitPlan,
      });
      return;
    }

    if (market.state === 'WAIT_UP') {
      await this._ensureSecondLegAndExit(market);
      await this._simulatePendingFills(market);
      if (market.state !== 'WAIT_UP') return;
      if (await this._simulateExitFill(market, 'Down', downBook, upBook)) return;
      if (this._shouldImmediateExitStrandedLeg(market, 'Down', downBook)) {
        await this._cancelMarketOrders(market, 'immediate-exit');
        await this._handleEndgame(market, 'Down', downBook, 'Up', upBook, { immediate: true });
        return;
      }
      if (timeLeftSec <= VALUE_SECOND_LEG_CUTOFF_SECONDS) {
        await this._cancelMarketOrders(market, 'second-leg-cutoff');
        await this._handleEndgame(market, 'Down', downBook, 'Up', upBook);
        return;
      }
      this._emitDecision(market, {
        type: 'waiting',
        side: 'Up',
        reason: market.pendingBuyOrders.Up ? 'second-order-resting' : 'second-order-missing',
        timeLeftSec,
        waitingFor: 'Up',
        quote: sideQuotes(market.quote.Up),
        exitPlan: market.exitPlan,
      });
      return;
    }

    if (market.state === 'PAIRED') {
      if (timeLeftSec > VALUE_SECOND_LEG_CUTOFF_SECONDS) {
        await this._tryArbPair(market, upBook, downBook);
      }
      this._ensureSettlementWatch(market);
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

  _isAtTarget(price) {
    return Number.isFinite(price) && price > 0 && price <= VALUE_TARGET_PRICE;
  }

  _isSecondLegEligible(price) {
    return Number.isFinite(price) && price > 0 && price <= VALUE_TARGET_PRICE;
  }

  _updateLastLiveQuote(market, side) {
    const quote = market.quote?.[side];
    if (!quote) return;
    const bestAsk = Number.isFinite(quote.bestAsk) ? quote.bestAsk : null;
    const bestBid = Number.isFinite(quote.bestBid) ? quote.bestBid : null;
    if (bestAsk == null && bestBid == null) return;
    market.lastLiveQuote[side] = {
      bestAsk,
      bestBid,
      observedAt: Date.now(),
    };
  }

  _signalPrice(quote) {
    if (!quote) return null;
    if (Number.isFinite(quote.bestBid)) return Number(quote.bestBid);
    if (Number.isFinite(quote.bestAsk)) return Number(quote.bestAsk);
    return null;
  }

  _estimateCloseResolution(market) {
    const upPrice = this._signalPrice(market.quote?.Up) ?? this._signalPrice(market.lastLiveQuote?.Up);
    const downPrice = this._signalPrice(market.quote?.Down) ?? this._signalPrice(market.lastLiveQuote?.Down);

    let winner = null;
    if (Number.isFinite(upPrice) && Number.isFinite(downPrice)) {
      if (upPrice > downPrice) winner = 'Up';
      else if (downPrice > upPrice) winner = 'Down';
    } else if (Number.isFinite(upPrice)) {
      winner = upPrice >= 0.5 ? 'Up' : 'Down';
    } else if (Number.isFinite(downPrice)) {
      winner = downPrice >= 0.5 ? 'Down' : 'Up';
    }

    if (!winner) return null;
    return {
      outcomes: ['Up', 'Down'],
      resolvedPayouts: winner === 'Up' ? [1, 0] : [0, 1],
      derivedFrom: {
        upPrice: Number.isFinite(upPrice) ? upPrice : null,
        downPrice: Number.isFinite(downPrice) ? downPrice : null,
      },
    };
  }

  _countOpenMarkets() {
    return [...this.markets.values()].filter((market) => this._hasOpenExposure(market)).length;
  }

  _countStrandedLegs() {
    return [...this.markets.values()].filter((market) =>
      !market.settled && (market.state === 'WAIT_UP' || market.state === 'WAIT_DOWN')
    ).length;
  }

  async _tryArbPair(market, upBook, downBook) {
    const upAsk = bestAskFromBook(upBook);
    const downAsk = bestAskFromBook(downBook);
    if (!upAsk || !downAsk) return false;

    const combined = upAsk.price + downAsk.price;
    if (!Number.isFinite(combined) || combined <= 0) return false;

    if (combined > COMBINED_ASK_STOP) {
      this._emitDecision(market, {
        type: 'arb-skip',
        side: null,
        reason: 'combined-ask-stop',
        combined,
      });
      return false;
    }

    if (combined >= 1 - TARGET_EDGE) {
      this._emitDecision(market, {
        type: 'arb-skip',
        side: null,
        reason: 'edge-not-met',
        combined,
        edge: 1 - combined,
      });
      return false;
    }

    const targetShares = this._targetShares();
    const shares = Math.min(
      Number(upAsk.size ?? 0),
      Number(downAsk.size ?? 0),
      Number.isFinite(targetShares) ? targetShares : 0,
      combined > 0 ? MAX_TAKER_FILL_USDC / combined : 0,
    );

    if (!Number.isFinite(shares) || shares <= 0) {
      this._emitDecision(market, {
        type: 'arb-skip',
        side: null,
        reason: 'no-arb-size',
        combined,
      });
      return false;
    }

    const upSpendUsdc = shares * upAsk.price;
    const downSpendUsdc = shares * downAsk.price;
    try {
      if (!VALUE_DRY_RUN) {
        const [upRes, downRes] = await Promise.allSettled([
          ClobClient.postFOKBuy(this.wallet, market.upToken.tokenId, upAsk.price, upSpendUsdc),
          ClobClient.postFOKBuy(this.wallet, market.downToken.tokenId, downAsk.price, downSpendUsdc),
        ]);
        if (upRes.status !== 'fulfilled' || downRes.status !== 'fulfilled') {
          this.failures += 1;
          this._emitDecision(market, {
            type: 'arb-skip',
            side: null,
            reason: 'arb-leg-failed',
            combined,
            upStatus: upRes.status,
            downStatus: downRes.status,
          });
          return false;
        }
      }

      const now = Date.now();
      const upLeg = market.legs.Up;
      const downLeg = market.legs.Down;
      upLeg.entered = true;
      upLeg.shares += shares;
      upLeg.arbShares += shares;
      upLeg.spent += upSpendUsdc;
      upLeg.avgPrice = upLeg.shares > 0 ? upLeg.spent / upLeg.shares : upAsk.price;
      upLeg.enteredAt ??= now;
      downLeg.entered = true;
      downLeg.shares += shares;
      downLeg.arbShares += shares;
      downLeg.spent += downSpendUsdc;
      downLeg.avgPrice = downLeg.shares > 0 ? downLeg.spent / downLeg.shares : downAsk.price;
      downLeg.enteredAt ??= now;

      market.totalCost += upSpendUsdc + downSpendUsdc;
      market.hasAnyLeg = true;
      market.hadAnyTrade = true;
      market.arbPairCount += 1;
      market.arbPairShares += shares;
      market.arbPairSpent += upSpendUsdc + downSpendUsdc;
      market.firstSide = 'Pair';
      market.exitPlan = null;
      market.state = 'PAIRED';
      market.lastAction = `${VALUE_DRY_RUN ? 'dry-run' : 'arb'} pair up ${upAsk.price.toFixed(4)} + down ${downAsk.price.toFixed(4)}`;
      this.actions += 1;

      this.emit('action', {
        type: VALUE_DRY_RUN ? 'dry-run-arb-buy' : 'arb-buy',
        slug: market.slug,
        side: null,
        state: market.state,
        spent: upSpendUsdc + downSpendUsdc,
        shares,
        upPrice: upAsk.price,
        downPrice: downAsk.price,
        combined,
        timestamp: now,
      });
      this._ensureSettlementWatch(market);
      this.emit('markets-updated', this.snapshotMarkets());
      return true;
    } catch (err) {
      this.failures += 1;
      logger.warn('value.engine: arb pair failed', {
        slug: market.slug,
        err: err.message,
      });
      this.emit('action', {
        type: 'arb-failed',
        slug: market.slug,
        side: null,
        state: market.state,
        spent: upSpendUsdc + downSpendUsdc,
        shares,
        upPrice: upAsk.price,
        downPrice: downAsk.price,
        combined,
        timestamp: Date.now(),
      });
      return false;
    }
  }

  _targetShares() {
    if (VALUE_ORDER_MODE === 'SHARES') return VALUE_TARGET_SHARES;
    if (!Number.isFinite(VALUE_TARGET_PRICE) || VALUE_TARGET_PRICE <= 0) return 0;
    return VALUE_LEG_USDC / VALUE_TARGET_PRICE;
  }

  async _ensureFirstLegOrders(market) {
    await this._ensureRestingBuyOrder(market, 'Up', 'first');
    await this._ensureRestingBuyOrder(market, 'Down', 'first');
  }

  async _ensureSecondLegAndExit(market) {
    const openSide = market.state === 'WAIT_DOWN' ? 'Up' : market.state === 'WAIT_UP' ? 'Down' : null;
    const secondSide = openSide ? oppositeSide(openSide) : null;
    if (!openSide || !secondSide) return;

    market.exitPlan ??= {
      side: openSide,
      triggerPrice: VALUE_IMMEDIATE_EXIT_BELOW_PRICE,
      armedAt: Date.now(),
      mode: 'synthetic-threshold',
    };
    await this._ensureRestingBuyOrder(market, secondSide, 'second');
  }

  async _ensureRestingBuyOrder(market, side, role) {
    if (market.pendingBuyOrders[side]) return;
    const leg = market.legs[side];
    if (leg.entered) return;

    const shares = this._targetShares();
    if (!Number.isFinite(shares) || shares <= 0) return;

    const tokenId = side === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const order = {
      role,
      side,
      tokenId,
      price: VALUE_TARGET_PRICE,
      shares,
      usdcBudget: VALUE_ORDER_MODE === 'USDC' ? VALUE_LEG_USDC : shares * VALUE_TARGET_PRICE,
      orderId: null,
      placedAt: Date.now(),
      live: !VALUE_DRY_RUN,
    };

    try {
      if (!VALUE_DRY_RUN) {
        order.orderId = await ClobClient.postLimitBuy(this.wallet, tokenId, order.price, order.shares);
      }
      market.pendingBuyOrders[side] = order;
      market.lastAction = `${VALUE_DRY_RUN ? 'dry-run' : 'resting'} ${role} ${side.toLowerCase()} bid @ ${order.price.toFixed(4)}`;
      this.emit('action', {
        type: VALUE_DRY_RUN ? 'dry-run-order-placed' : 'order-placed',
        slug: market.slug,
        side,
        role,
        state: market.state,
        price: order.price,
        shares: order.shares,
        spent: order.usdcBudget,
        orderId: order.orderId,
        timestamp: Date.now(),
      });
    } catch (err) {
      this.failures += 1;
      logger.warn('value.engine: resting order failed', {
        slug: market.slug,
        side,
        role,
        err: err.message,
      });
      this._emitDecision(market, {
        type: 'order-skipped',
        side,
        reason: 'resting-order-failed',
        role,
        error: err.message,
      });
    }
  }

  async _cancelMarketOrders(market, reason) {
    const hadOrders = Object.values(market.pendingBuyOrders).some(Boolean);
    market.pendingBuyOrders.Up = null;
    market.pendingBuyOrders.Down = null;
    if (!hadOrders) return;
    if (!VALUE_DRY_RUN) {
      try {
        await ClobClient.cancelMarket(market.conditionId);
      } catch (err) {
        logger.warn('value.engine: cancel market orders failed', {
          slug: market.slug,
          reason,
          err: err.message,
        });
      }
    }
    this.emit('action', {
      type: VALUE_DRY_RUN ? 'dry-run-orders-cancelled' : 'orders-cancelled',
      slug: market.slug,
      side: null,
      state: market.state,
      reason,
      timestamp: Date.now(),
    });
  }

  async _simulatePendingFills(market) {
    if (!VALUE_DRY_RUN) return;

    for (const side of ['Up', 'Down']) {
      const order = market.pendingBuyOrders[side];
      if (!order) continue;
      const bestAsk = market.quote?.[side]?.bestAsk;
      if (!Number.isFinite(bestAsk) || bestAsk > order.price) continue;
      const fillPrice = bestAsk;
      const fillShares = order.shares;
      const spentUsdc = fillPrice * fillShares;
      market.pendingBuyOrders[side] = null;
      await this._recordBuyFill(market, side, {
        role: order.role,
        price: fillPrice,
        shares: fillShares,
        spentUsdc,
        source: 'simulated-resting-order',
        orderId: order.orderId,
      });
      return;
    }
  }

  async _simulateExitFill(market, side, book, oppositeBook) {
    if (!VALUE_DRY_RUN || !market.exitPlan || market.exitPlan.side !== side) return false;
    const openShares = this._valueOpenShares(market, side);
    if (openShares <= 1e-9) return false;

    const bestBid = bestBidFromBook(book)?.price ?? null;
    if (!Number.isFinite(bestBid) || bestBid >= market.exitPlan.triggerPrice) return false;

    const otherSide = oppositeSide(side);
    if (!oppositeBook) {
      this._emitDecision(market, {
        type: 'immediate-exit',
        side: otherSide,
        reason: 'force-pair-no-opposite-book',
        openSide: side,
        oppositeSide: otherSide,
      });
      return false;
    }

    await this._enterLeg(market, otherSide, oppositeBook, {
      force: true,
      targetSharesOverride: openShares,
    });
    return true;
  }

  async handleFill(fill) {
    const tokenId = String(fill.tokenId);
    const side = String(fill.side ?? '').toUpperCase();
    const market = [...this.markets.values()].find((candidate) =>
      !candidate.settled && (
        String(candidate.upToken.tokenId) === tokenId ||
        String(candidate.downToken.tokenId) === tokenId
      )
    );
    if (!market) return;

    const marketSide = String(market.upToken.tokenId) === tokenId ? 'Up' : 'Down';
    if (side === 'BUY') {
      const pending = market.pendingBuyOrders[marketSide];
      await this._recordBuyFill(market, marketSide, {
        role: pending?.role ?? (market.state === 'NONE' ? 'first' : 'second'),
        price: Number(fill.price),
        shares: Number(fill.size),
        spentUsdc: Number(fill.price) * Number(fill.size),
        source: 'user-fill',
        orderId: fill.orderId ?? pending?.orderId ?? null,
      });
      return;
    }

    if (side === 'SELL') {
      await this._recordSellFill(market, marketSide, {
        price: Number(fill.price),
        shares: Number(fill.size),
        proceedsUsdc: Number(fill.price) * Number(fill.size),
        source: 'user-fill',
        orderId: fill.orderId ?? null,
      });
    }
  }

  async _recordBuyFill(market, side, fill) {
    const leg = market.legs[side];
    const prevShares = Number(leg.shares ?? 0);
    const prevSpent = Number(leg.spent ?? 0);
    const nextShares = prevShares + fill.shares;
    const nextSpent = prevSpent + fill.spentUsdc;

    leg.entered = true;
    leg.shares = nextShares;
    leg.spent = nextSpent;
    leg.avgPrice = nextShares > 0 ? nextSpent / nextShares : fill.price;
    leg.enteredAt ??= Date.now();
    leg.response = fill.orderId ?? leg.response;
    market.totalCost += fill.spentUsdc;
    market.hasAnyLeg = true;
    market.hadAnyTrade = true;
    if (!market.firstSide) market.firstSide = side;
    if (fill.role === 'second') market.hadForcePair = market.hadForcePair;
    market.state = this._computeState(market);
    this.actions += 1;
    market.lastAction = `filled ${fill.role} ${side.toLowerCase()} @ ${leg.avgPrice.toFixed(4)}`;

    this.emit('action', {
      type: VALUE_DRY_RUN ? 'dry-run-buy-filled' : 'buy-filled',
      slug: market.slug,
      side,
      role: fill.role,
      state: market.state,
      spent: fill.spentUsdc,
      shares: fill.shares,
      price: fill.price,
      source: fill.source,
      orderId: fill.orderId ?? null,
      timestamp: Date.now(),
    });

    if (fill.role === 'first') {
      await this._cancelMarketOrders(market, 'first-leg-filled');
      market.pendingBuyOrders.Up = null;
      market.pendingBuyOrders.Down = null;
      market.exitPlan = {
        side,
        triggerPrice: VALUE_IMMEDIATE_EXIT_BELOW_PRICE,
        armedAt: Date.now(),
        mode: 'synthetic-threshold',
      };
      await this._ensureSecondLegAndExit(market);
    } else if (fill.role === 'second') {
      market.pendingBuyOrders[side] = null;
      market.exitPlan = null;
      await this._cancelMarketOrders(market, 'pair-complete');
      this._ensureSettlementWatch(market);
    }

    this.emit('markets-updated', this.snapshotMarkets());
  }

  async _recordSellFill(market, side, fill) {
    const leg = market.legs[side];
    leg.soldShares += fill.shares;
    leg.soldUsdc += fill.proceedsUsdc;
    leg.sellAvgPrice = leg.soldShares > 0 ? leg.soldUsdc / leg.soldShares : fill.price;
    leg.soldAt = Date.now();
    market.cashProceeds += fill.proceedsUsdc;
    market.exitPlan = null;
    market.state = this._computeState(market);
    market.pnl = market.cashProceeds + market.redeemed - market.totalCost;
    this.actions += 1;
    market.lastAction = `filled exit ${side.toLowerCase()} @ ${leg.sellAvgPrice.toFixed(4)}`;
    await this._cancelMarketOrders(market, 'exit-filled');
    this.emit('action', {
      type: VALUE_DRY_RUN ? 'dry-run-sell-filled' : 'sell-filled',
      slug: market.slug,
      side,
      state: market.state,
      spent: fill.proceedsUsdc,
      shares: fill.shares,
      price: fill.price,
      source: fill.source,
      orderId: fill.orderId ?? null,
      timestamp: Date.now(),
    });
    this.emit('markets-updated', this.snapshotMarkets());
  }

  async _enterLeg(market, side, book, { force = false, targetSharesOverride = null } = {}) {
    const leg = market.legs[side];
    if (leg.entered) {
      this._emitDecision(market, {
        type: 'buy-skipped',
        side,
        reason: 'already-entered',
        force,
      });
      return;
    }

    const quote = bestAskFromBook(book);
    const eligible = force
      ? Number.isFinite(quote?.price) && quote.price > 0
      : market.state === 'NONE'
      ? this._isAtTarget(quote?.price)
      : this._isSecondLegEligible(quote?.price);
    if (!quote) {
      this._emitDecision(market, {
        type: 'buy-skipped',
        side,
        reason: 'no-best-ask',
        force,
      });
      return;
    }
    if (!eligible) {
      this._emitDecision(market, {
        type: 'buy-skipped',
        side,
        reason: force ? 'force-not-eligible' : 'not-eligible',
        force,
        quote: sideQuotes({ bestAsk: quote.price }),
      });
      return;
    }

    const maxPrice = this._entryMaxPrice(market, quote.price, force);

    const plan = Number.isFinite(targetSharesOverride) && targetSharesOverride > 0
      ? estimateBuyCostForSharesFromBook(book, targetSharesOverride, maxPrice)
      : VALUE_ORDER_MODE === 'SHARES'
      ? estimateBuyCostForSharesFromBook(book, VALUE_TARGET_SHARES, maxPrice)
      : ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, VALUE_LEG_USDC, 0);
    if (!plan || plan.fillShares <= 0 || plan.spentUsdc <= 0) {
      this._emitDecision(market, {
        type: 'buy-skipped',
        side,
        reason: 'no-fill-plan',
        force,
        maxPrice,
        bestAsk: quote.price,
        executionPlan: plan ?? null,
      });
      return;
    }

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
      if (force) market.hadForcePair = true;
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
        targetSharesOverride,
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
        targetSharesOverride,
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
        targetSharesOverride,
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
      return 0.99;
    }
    if (market.state === 'NONE') {
      return Math.min(
        VALUE_TARGET_PRICE,
        Number((bestAsk + VALUE_MAX_SLIPPAGE).toFixed(4)),
      );
    }
    return Math.min(0.99, Number((bestAsk + VALUE_MAX_SLIPPAGE).toFixed(4)));
  }

  async _handleEndgame(market, openSide, openBook, oppositeSide, oppositeBook, { immediate = false } = {}) {
    if (immediate) {
      market.hadImmediateExit = true;
    }
    if (!openBook) {
      market.lastAction = `${immediate ? 'immediate-exit' : 'endgame'} skipped - no ${openSide.toLowerCase()} book`;
      this._emitDecision(market, {
        type: immediate ? 'immediate-exit' : 'endgame',
        side: openSide,
        reason: 'open-leg-book-unavailable',
        openSide,
        oppositeSide,
      });
      this._ensureSettlementWatch(market);
      this.emit('markets-updated', this.snapshotMarkets());
      logger.info(`value.engine: ${immediate ? 'immediate exit' : 'endgame'} skipped, open-leg book unavailable`, {
        slug: market.slug,
        openSide,
        oppositeSide,
        dryRun: VALUE_DRY_RUN,
      });
      return;
    }

    if (!immediate && !this._shouldExitStrandedLeg(market, openSide, openBook)) {
      const legQuote = market.quote?.[openSide] ?? {};
      const holdPrice = Number.isFinite(legQuote.bestBid) ? legQuote.bestBid : legQuote.bestAsk;
      market.lastAction = `holding ${openSide.toLowerCase()} into settlement @ ${Number(holdPrice).toFixed(4)}`;
      this._emitDecision(market, {
        type: 'endgame',
        side: openSide,
        reason: 'hold-into-settlement',
        openSide,
        oppositeSide,
        holdPrice,
        exitBelowPrice: VALUE_ENDGAME_EXIT_BELOW_PRICE,
      });
      logger.info('value.engine: keeping stranded leg into settlement', {
        slug: market.slug,
        side: openSide,
        state: market.state,
        bestBid: legQuote.bestBid ?? null,
        bestAsk: legQuote.bestAsk ?? null,
        exitBelowPrice: VALUE_ENDGAME_EXIT_BELOW_PRICE,
        dryRun: VALUE_DRY_RUN,
      });
      this.emit('markets-updated', this.snapshotMarkets());
      this._ensureSettlementWatch(market);
      return;
    }

    const targetShares = this._valueOpenShares(market, openSide);
    if (targetShares <= 1e-9) {
      this._emitDecision(market, {
        type: immediate ? 'immediate-exit' : 'endgame',
        side: openSide,
        reason: 'no-stranded-value-shares',
        openSide,
        oppositeSide,
      });
      this._ensureSettlementWatch(market);
      this.emit('markets-updated', this.snapshotMarkets());
      return;
    }
    if (!oppositeBook) {
      market.lastAction = `${immediate ? 'immediate-exit' : 'endgame'} no ${oppositeSide.toLowerCase()} book for force-pair`;
      this._emitDecision(market, {
        type: immediate ? 'immediate-exit' : 'endgame',
        side: oppositeSide,
        reason: 'force-pair-no-opposite-book',
        openSide,
        oppositeSide,
      });
      this._ensureSettlementWatch(market);
      this.emit('markets-updated', this.snapshotMarkets());
      logger.info(`value.engine: ${immediate ? 'immediate exit' : 'force-pair'} skipped, opposite-leg book unavailable`, {
        slug: market.slug,
        openSide,
        oppositeSide,
        dryRun: VALUE_DRY_RUN,
      });
      return;
    }
    await this._enterLeg(market, oppositeSide, oppositeBook, {
      force: true,
      targetSharesOverride: targetShares,
    });
  }

  _shouldImmediateExitStrandedLeg(market, side, book) {
    const leg = market.legs[side];
    if (!leg?.entered || this._openShares(leg) <= 1e-9) return false;
    if (!Number.isFinite(VALUE_IMMEDIATE_EXIT_BELOW_PRICE) || VALUE_IMMEDIATE_EXIT_BELOW_PRICE <= 0) {
      return false;
    }

    const bestBid = bestBidFromBook(book)?.price ?? null;
    const bestAsk = bestAskFromBook(book)?.price ?? null;
    const signalPrice = Number.isFinite(bestBid) ? bestBid : bestAsk;
    return Number.isFinite(signalPrice) && signalPrice < VALUE_IMMEDIATE_EXIT_BELOW_PRICE;
  }

  _shouldExitStrandedLeg(market, side, book) {
    const leg = market.legs[side];
    if (!leg?.entered || this._openShares(leg) <= 1e-9) return false;
    if (!Number.isFinite(VALUE_ENDGAME_EXIT_BELOW_PRICE) || VALUE_ENDGAME_EXIT_BELOW_PRICE <= 0) {
      return false;
    }

    const bestBid = bestBidFromBook(book)?.price ?? null;
    const bestAsk = bestAskFromBook(book)?.price ?? null;
    const signalPrice = Number.isFinite(bestBid) ? bestBid : bestAsk;
    return Number.isFinite(signalPrice) && signalPrice < VALUE_ENDGAME_EXIT_BELOW_PRICE;
  }

  async _flattenOpenLeg(market, side, book) {
    const leg = market.legs[side];
    const openShares = this._openShares(leg);
    if (openShares <= 1e-9) {
      this._emitDecision(market, {
        type: 'flatten-skipped',
        side,
        reason: 'already-flat',
      });
      return true;
    }

    const bestBid = bestBidFromBook(book);
    if (!bestBid || !Number.isFinite(bestBid.price) || bestBid.price <= 0) {
      this._emitDecision(market, {
        type: 'flatten-skipped',
        side,
        reason: 'no-best-bid',
      });
      return false;
    }

    const minPrice = 0.01;
    const plan = estimateSellProceedsForSharesFromBook(book, openShares, minPrice);
    if (!plan || !plan.fullyFilled || plan.soldShares <= 0 || plan.proceedsUsdc <= 0) {
      this._emitDecision(market, {
        type: 'flatten-skipped',
        side,
        reason: 'no-sell-plan',
        bestBid: bestBid.price,
        minPrice,
        executionPlan: plan ?? null,
      });
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

  _settleMarket(market, resolved, { source = 'gamma' } = {}) {
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
    market.settlementSource = source;
    market.state = 'SETTLED';
    market.outcomes = outcomes;
    market.payouts = payouts;
    market.lastAction = `settled (${source}) pnl ${market.pnl.toFixed(4)}`;

    this.emit('action', {
      type: 'settled',
      slug: market.slug,
      side: null,
      state: market.state,
      spent: market.totalCost,
      shares: market.legs.Up.shares + market.legs.Down.shares,
      settlementSource: source,
      timestamp: Date.now(),
    });
    logger.info('value.engine: market settled', {
      slug: market.slug,
      state: market.state,
      totalCost: market.totalCost,
      redeemed: market.redeemed,
      pnl: market.pnl,
      settlementSource: source,
    });
    this.emit('markets-updated', this.snapshotMarkets());
  }

  _emitQuote(market, extra = {}) {
    this.emit('quote', {
      slug: market.slug,
      conditionId: market.conditionId,
      state: market.state,
      marketState: market.settled ? 'SETTLED' : 'OPEN',
      timeLeftSec: extra.timeLeftSec ?? Math.max(0, market.closeTs - nowSec()),
      up: {
        ...sideQuotes(market.quote.Up),
        bookLive: extra.upBookLive ?? null,
      },
      down: {
        ...sideQuotes(market.quote.Down),
        bookLive: extra.downBookLive ?? null,
      },
      timestamp: Date.now(),
    });
  }

  _emitDecision(market, payload) {
    this.emit('decision', {
      slug: market.slug,
      conditionId: market.conditionId,
      state: market.state,
      marketState: market.settled ? 'SETTLED' : 'OPEN',
      firstSide: market.firstSide,
      positionType: this._positionType(market),
      up: sideQuotes(market.quote.Up),
      down: sideQuotes(market.quote.Down),
      timestamp: Date.now(),
      ...payload,
    });
  }
}
