import { EventEmitter } from 'events';
import logger from '../logger.js';
import { ClobClient } from '../clob.js';
import { waitForResolution } from '../market.js';
import { mergePositions } from '../onchain.js';
import {
  VALUE_ABSOLUTE_FIRST_LEG_MAX_PRICE,
  VALUE_DRY_RUN,
  VALUE_ENDGAME_EXIT_BELOW_PRICE,
  VALUE_EXTENDED_HOLD_MAX_MS_15M,
  VALUE_EXTENDED_HOLD_MAX_MS_5M,
  VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_15M,
  VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_5M,
  VALUE_FIRST_LEG_MIN_PRICE,
  VALUE_IMMEDIATE_EXIT_BELOW_PRICE,
  VALUE_CONTINUE_MIN_PROFIT_PER_SHARE,
  VALUE_DIRECT_TAKE_PROFIT_PER_SHARE,
  VALUE_FIRST_LEG_CUTOFF_SECONDS,
  VALUE_LEG_USDC,
  VALUE_MAX_BOOK_AGE_MS,
  VALUE_MAX_ONE_LEG_HOLD_MS_15M,
  VALUE_MAX_ONE_LEG_HOLD_MS_5M,
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
  VALUE_STABLE_SNAPSHOTS_REQUIRED,
  VALUE_TARGET_PRICE,
  VALUE_TARGET_SHARES,
  VALUE_TRAILING_DRAWDOWN_PER_SHARE_15M,
  VALUE_TRAILING_DRAWDOWN_PER_SHARE_5M,
  VALUE_EXTREME_SPREAD,
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

function isPairedState(state) {
  return state === 'PAIRED' || state === 'FORCED_PAIRED';
}

export class ValueStrategyEngine extends EventEmitter {
  constructor(wallet) {
    super();
    this.wallet = wallet;
    this.markets = new Map();
    this.actions = 0;
    this.failures = 0;
    this.settlementTasks = new Map();
    this._processedOrderIds = new Set();
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
      this.emit('market-init', {
        slug: created.slug,
        conditionId: created.conditionId,
        question: created.question,
        symbol: created.symbol,
        duration: created.duration,
        windowTs: created.windowTs,
        closeTs: created.closeTs,
        upTokenId: created.upToken?.tokenId ?? null,
        downTokenId: created.downToken?.tokenId ?? null,
        replayConfig: {
          dryRun: VALUE_DRY_RUN,
          targetPrice: VALUE_TARGET_PRICE,
          absoluteFirstLegMaxPrice: VALUE_ABSOLUTE_FIRST_LEG_MAX_PRICE,
          firstLegMinPrice: VALUE_FIRST_LEG_MIN_PRICE,
          oppositeMaxPrice: VALUE_OPPOSITE_MAX_PRICE,
          oppositeGapToTargetMax: VALUE_OPPOSITE_GAP_TO_TARGET_MAX,
          orderMode: VALUE_ORDER_MODE,
          legUsdc: VALUE_LEG_USDC,
          targetShares: VALUE_TARGET_SHARES,
          maxSpread: VALUE_MAX_SPREAD,
          extremeSpread: VALUE_EXTREME_SPREAD,
          requiredDepthMultiplier: VALUE_REQUIRED_DEPTH_MULTIPLIER,
          firstLegCutoffSeconds: VALUE_FIRST_LEG_CUTOFF_SECONDS,
          secondLegCutoffSeconds: VALUE_SECOND_LEG_CUTOFF_SECONDS,
          secondLegHardMaxPrice: VALUE_SECOND_LEG_HARD_MAX_PRICE,
          secondLegMaxSpread: VALUE_SECOND_LEG_MAX_SPREAD,
          secondLegExtremeSpread: VALUE_SECOND_LEG_EXTREME_SPREAD,
          secondLegMinDepthMultiplier: VALUE_SECOND_LEG_MIN_DEPTH_MULTIPLIER,
          secondLegMinLockProfitPerShare: VALUE_SECOND_LEG_MIN_LOCK_PROFIT_PER_SHARE,
          maxOneLegHoldMs5m: VALUE_MAX_ONE_LEG_HOLD_MS_5M,
          maxOneLegHoldMs15m: VALUE_MAX_ONE_LEG_HOLD_MS_15M,
          noUnpairedHoldLastMs5m: VALUE_NO_UNPAIRED_HOLD_LAST_MS_5M,
          noUnpairedHoldLastMs15m: VALUE_NO_UNPAIRED_HOLD_LAST_MS_15M,
          maxBookAgeMs: VALUE_MAX_BOOK_AGE_MS,
          maxUnpairedLossPerShare: VALUE_MAX_UNPAIRED_LOSS_PER_SHARE,
          mergeOnSecondLeg: VALUE_MERGE_ON_SECOND_LEG,
          immediateExitBelowPrice: VALUE_IMMEDIATE_EXIT_BELOW_PRICE,
          endgameExitBelowPrice: VALUE_ENDGAME_EXIT_BELOW_PRICE,
        },
        createdAt: Date.now(),
      });
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
    const pairedOpen = openMarkets.filter((market) => isPairedState(market.state)).length;
    const strandedOpen = openMarkets.filter((market) =>
      market.state === 'WAIT_UP' || market.state === 'WAIT_DOWN'
    ).length;
    const closed = markets.filter((market) => market.settled || market.state === 'FLAT');
    const closedMarkets = closed.length;
    const openCost = openMarkets.reduce((sum, market) => sum + market.totalCost - market.cashProceeds, 0);
    const settledPnl = closed.reduce((sum, market) => sum + Number(market.pnl ?? 0), 0);
    const profitMarkets = closed.filter((market) => Number(market.pnl ?? 0) > 0).length;
    const lossMarkets = closed.filter((market) => Number(market.pnl ?? 0) < 0).length;
    const totalProfitSum = closed.reduce((sum, market) => sum + Math.max(0, Number(market.pnl ?? 0)), 0);
    const totalLossSum = closed.reduce((sum, market) => sum + Math.min(0, Number(market.pnl ?? 0)), 0);

    const exitQualityMarkets = markets
      .map((market) => this._singleLegExitOutcome(market))
      .filter(Boolean);
    const misexitMarkets = exitQualityMarkets.filter((item) => item.kind === 'misexit');
    const correctexitMarkets = exitQualityMarkets.filter((item) => item.kind === 'correctexit');

    return {
      trackedMarkets: markets.length,
      openMarkets: openMarkets.length,
      pairedOpenMarkets: pairedOpen,
      strandedOpenMarkets: strandedOpen,
      settledMarkets: closedMarkets,
      profitMarkets,
      lossMarkets,
      totalProfitSum: totalProfitSum.toFixed(2),
      totalLossSum: totalLossSum.toFixed(2),
      misexitMarkets: misexitMarkets.length,
      correctexitMarkets: correctexitMarkets.length,
      lossSumFromMisexitMarkets: misexitMarkets.reduce((sum, item) => sum + Math.min(0, item.actualPnl), 0).toFixed(2),
      lossSumFromCorrectexitMarkets: correctexitMarkets.reduce((sum, item) => sum + Math.min(0, item.actualPnl), 0).toFixed(2),
      missedProfitSumFromMisexitMarkets: misexitMarkets.reduce((sum, item) => sum + Math.max(0, item.holdPnl - item.actualPnl), 0).toFixed(2),
      missedLossSumFromCorrectexitMarkets: correctexitMarkets.reduce((sum, item) => sum + Math.max(0, item.actualPnl - item.holdPnl), 0).toFixed(2),
      openCost: openCost.toFixed(2),
      settledPnl: settledPnl.toFixed(2),
      actions: this.actions,
      failures: this.failures,
    };
  }

  _singleLegExitOutcome(market) {
    if (!market?.settled || !market.firstSide) return null;
    const enteredLegs = this._enteredLegs(market);
    if (enteredLegs.length !== 1) return null;
    const firstSide = market.firstSide;
    if (enteredLegs[0] !== firstSide) return null;

    const winner = this._winningOutcome(market);
    if (!winner) return null;

    const leg = market.legs[firstSide];
    const actualPnl = Number(market.pnl ?? 0);
    const holdPnl = (Number(leg.shares ?? 0) * (winner === firstSide ? 1 : 0)) - Number(market.totalCost ?? 0);
    return {
      kind: winner === firstSide ? 'misexit' : 'correctexit',
      actualPnl,
      holdPnl,
    };
  }

  snapshotMarkets() {
    return [...this.markets.values()]
      .sort((a, b) => b.closeTs - a.closeTs)
      .map((market) => {
        const enteredLegs = this._enteredLegs(market);
        const winningOutcome = this._winningOutcome(market);
        const onlyFirstLegTraded = enteredLegs.length === 1 && Boolean(market.firstSide);
        const firstLegEndedUpWinner = Boolean(
          market.settled
          && onlyFirstLegTraded
          && market.firstSide
          && winningOutcome
          && market.firstSide === winningOutcome
        );
        return ({
        slug: market.slug,
        question: market.question,
        conditionId: market.conditionId,
        closeTs: market.closeTs,
        timeLeftSec: Math.max(0, market.closeTs - nowSec()),
        marketState: market.settled ? 'SETTLED' : 'OPEN',
        state: market.state,
        targetPrice: VALUE_TARGET_PRICE,
        firstSide: market.firstSide,
        positionType: this._positionType(market),
        enteredLegs,
        winningOutcome,
        onlyFirstLegTraded,
        firstLegEndedUpWinner,
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
        exitReview: market.exitReview ? {
          side: market.exitReview.side,
          actionType: market.exitReview.actionType,
          exitedAt: market.exitReview.exitedAt,
          baseNetRecovery: market.exitReview.baseNetRecovery,
          bestPostExitNetRecovery: market.exitReview.bestPostExitNetRecovery,
          improvementUsdc: market.exitReview.improvementUsdc,
          improvementPerShare: market.exitReview.improvementPerShare,
          bestSeenAt: market.exitReview.bestSeenAt,
          bestSeenVwap: market.exitReview.bestSeenVwap,
          couldHaveDoneBetter: market.exitReview.couldHaveDoneBetter,
        } : null,
        lastAction: market.lastAction,
      });
      });
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
      extendedHold: null,
      exitReview: null,
      stableSnapshotCount: 0,
      firstFee: 0,
      secondFee: 0,
      mergedUsdc: 0,
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
      hadImmediateExit: false,
      hadForcePair: false,
      outcomes: [],
      payouts: [],
    };
  }

  _positionType(market) {
    const up = this._openShares(market.legs.Up) > 1e-9;
    const down = this._openShares(market.legs.Down) > 1e-9;
    if (up && down) return market.state === 'FORCED_PAIRED' ? 'Forced Paired' : 'Paired';
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

  _valueOpenShares(market, side) {
    return this._openShares(market.legs[side]);
  }

  _hasOpenExposure(market) {
    return !market.settled && ['WAIT_UP', 'WAIT_DOWN', 'PAIRED', 'FORCED_PAIRED'].includes(market.state);
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
    await this._updateExitHindsight(market, {
      Up: upBook,
      Down: downBook,
    });

    const timeLeftSec = market.closeTs - nowSec();
    this._emitQuote(market, {
      timeLeftSec,
      upBookLive: Boolean(upBook),
      downBookLive: Boolean(downBook),
      upBook,
      downBook,
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
      const timeSinceOpenSec = nowSec() - market.windowTs;
      if (timeSinceOpenSec < VALUE_OPEN_WAIT_SECONDS) {
        this._resetStability(market);
        this._emitDecision(market, {
          type: 'poll-skip',
          side: null,
          reason: 'open-wait',
          timeLeftSec,
          timeSinceOpenSec,
        });
        return;
      }
      if (this._countOpenMarkets() >= VALUE_MAX_OPEN_MARKETS) {
        await this._cancelMarketOrders(market, 'max-open-markets');
        this._resetStability(market);
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
        this._resetStability(market);
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
        this._resetStability(market);
        this._emitDecision(market, {
          type: 'poll-skip',
          side: null,
          reason: 'first-leg-cutoff',
          timeLeftSec,
        });
        return;
      }
      await this._tryEnterFirstLeg(market, upBook, downBook, timeLeftSec);
      return;
    }

    if (market.state === 'WAIT_DOWN') {
      await this._ensureSecondLegAndExit(market);
      await this._manageSecondLegState(market, 'Up', upBook, 'Down', downBook, timeLeftSec);
      return;
    }

    if (market.state === 'WAIT_UP') {
      await this._ensureSecondLegAndExit(market);
      await this._manageSecondLegState(market, 'Down', downBook, 'Up', upBook, timeLeftSec);
      return;
    }

    if (isPairedState(market.state)) {
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

  async _updateExitHindsight(market, booksBySide) {
    const review = market.exitReview;
    if (!review?.active || !review.side || review.shares <= 1e-9) return;
    const book = booksBySide?.[review.side];
    if (!book) return;

    const tokenId = review.side === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const feeRateBps = await this._getFeeRateBps(tokenId);
    const directExit = this._evaluateDirectSellExit(book, review.shares, feeRateBps);
    if (!directExit.allowed) return;

    if (directExit.netRecovery > Number(review.bestPostExitNetRecovery ?? Number.NEGATIVE_INFINITY)) {
      review.bestPostExitNetRecovery = directExit.netRecovery;
      review.bestSeenAt = Date.now();
      review.bestSeenVwap = directExit.vwap;
      review.improvementUsdc = directExit.netRecovery - Number(review.baseNetRecovery ?? 0);
      review.improvementPerShare = review.shares > 1e-9 ? review.improvementUsdc / review.shares : 0;
      review.couldHaveDoneBetter = review.improvementUsdc > 0.01;
    }
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

  _targetShares() {
    if (VALUE_ORDER_MODE === 'SHARES') return VALUE_TARGET_SHARES;
    if (!Number.isFinite(VALUE_TARGET_PRICE) || VALUE_TARGET_PRICE <= 0) return 0;
    return VALUE_LEG_USDC / VALUE_TARGET_PRICE;
  }

  _requiredDepthShares() {
    return this._targetShares() * VALUE_REQUIRED_DEPTH_MULTIPLIER;
  }

  _maxFirstLegPrice(market, timeLeftSec) {
    if (market.duration === '5m') {
      if (timeLeftSec > 180) return Math.min(VALUE_ABSOLUTE_FIRST_LEG_MAX_PRICE, VALUE_TARGET_PRICE + 0.01);
      if (timeLeftSec > 120) return Math.min(VALUE_ABSOLUTE_FIRST_LEG_MAX_PRICE, VALUE_TARGET_PRICE);
      if (timeLeftSec > 90) return Math.max(VALUE_FIRST_LEG_MIN_PRICE, VALUE_TARGET_PRICE - 0.03);
      return null;
    }

    if (timeLeftSec > 600) return VALUE_ABSOLUTE_FIRST_LEG_MAX_PRICE;
    if (timeLeftSec > 300) return Math.min(VALUE_ABSOLUTE_FIRST_LEG_MAX_PRICE, VALUE_TARGET_PRICE + 0.01);
    if (timeLeftSec > 180) return Math.min(VALUE_ABSOLUTE_FIRST_LEG_MAX_PRICE, VALUE_TARGET_PRICE);
    return null;
  }

  _dynamicSecondLegMinLockProfitPerShare(market) {
    const timeToExpiryMs = Math.max(0, (market.closeTs * 1000) - Date.now());
    if (market.duration === '5m') {
      if (timeToExpiryMs > 180_000) return VALUE_SECOND_LEG_MIN_LOCK_PROFIT_EARLY_PER_SHARE;
      if (timeToExpiryMs > 90_000) return VALUE_SECOND_LEG_MIN_LOCK_PROFIT_MID_PER_SHARE;
      if (timeToExpiryMs > 60_000) return VALUE_SECOND_LEG_MIN_LOCK_PROFIT_LATE_PER_SHARE;
      return VALUE_SECOND_LEG_MIN_LOCK_PROFIT_PER_SHARE;
    }
    if (timeToExpiryMs > 300_000) return VALUE_SECOND_LEG_MIN_LOCK_PROFIT_EARLY_PER_SHARE;
    if (timeToExpiryMs > 180_000) return VALUE_SECOND_LEG_MIN_LOCK_PROFIT_MID_PER_SHARE;
    if (timeToExpiryMs > 120_000) return VALUE_SECOND_LEG_MIN_LOCK_PROFIT_LATE_PER_SHARE;
    return VALUE_SECOND_LEG_MIN_LOCK_PROFIT_PER_SHARE;
  }

  _spread(book) {
    const bestAsk = bestAskFromBook(book)?.price ?? null;
    const bestBid = bestBidFromBook(book)?.price ?? null;
    if (!Number.isFinite(bestAsk) || !Number.isFinite(bestBid)) return null;
    return bestAsk - bestBid;
  }

  _bookDepthAtOrBelowPrice(book, maxPrice) {
    const asks = Array.isArray(book?.asks) ? book.asks : [];
    return asks
      .filter((ask) => Number.isFinite(ask.price) && Number.isFinite(ask.size) && ask.price > 0 && ask.size > 0 && ask.price <= maxPrice)
      .reduce((sum, ask) => sum + ask.size, 0);
  }

  _bookIsHealthy(book) {
    if (!book) return false;
    const bestAsk = bestAskFromBook(book);
    const bestBid = bestBidFromBook(book);
    if (!bestAsk || !bestBid) return false;

    const spread = bestAsk.price - bestBid.price;
    const orderSize = this._targetShares();
    if (!Number.isFinite(orderSize) || orderSize <= 0) return false;
    if (spread > VALUE_EXTREME_SPREAD) return false;
    if (!Number.isFinite(bestAsk.size) || bestAsk.size < orderSize) return false;
    if (!Number.isFinite(bestBid.size) || bestBid.size < orderSize) return false;
    return true;
  }

  _resetStability(market) {
    market.stableSnapshotCount = 0;
  }

  _advanceStability(market, upBook, downBook) {
    if (!this._bookIsHealthy(upBook) || !this._bookIsHealthy(downBook)) {
      this._resetStability(market);
      return false;
    }
    const upSpread = this._spread(upBook);
    const downSpread = this._spread(downBook);
    if (!Number.isFinite(upSpread) || !Number.isFinite(downSpread)) {
      this._resetStability(market);
      return false;
    }
    if (upSpread > VALUE_MAX_SPREAD || downSpread > VALUE_MAX_SPREAD) {
      this._resetStability(market);
      return false;
    }
    market.stableSnapshotCount = Number(market.stableSnapshotCount ?? 0) + 1;
    return market.stableSnapshotCount >= VALUE_STABLE_SNAPSHOTS_REQUIRED;
  }

  _evaluateFirstLegCandidate(market, side, book, oppositeBook, timeLeftSec) {
    const bestAsk = bestAskFromBook(book);
    const bestBid = bestBidFromBook(book);
    if (!bestAsk || !bestBid) return { allowed: false, reason: 'missing-best-level' };

    const spread = bestAsk.price - bestBid.price;
    if (!Number.isFinite(spread) || spread > VALUE_MAX_SPREAD) {
      return { allowed: false, reason: 'spread-too-wide', spread };
    }
    if (bestAsk.price < VALUE_FIRST_LEG_MIN_PRICE) {
      return { allowed: false, reason: 'best-ask-too-low', bestAsk: bestAsk.price };
    }

    const effectiveMaxFirstLegPrice = this._maxFirstLegPrice(market, timeLeftSec);
    if (!Number.isFinite(effectiveMaxFirstLegPrice)) {
      return { allowed: false, reason: 'first-leg-window-expired', timeLeftSec };
    }
    if (bestAsk.price > effectiveMaxFirstLegPrice) {
      return { allowed: false, reason: 'best-ask-too-high', bestAsk: bestAsk.price, maxFirstLegPrice: effectiveMaxFirstLegPrice };
    }

    const oppositeBestAsk = bestAskFromBook(oppositeBook);
    if (!oppositeBestAsk) {
      return { allowed: false, reason: 'opposite-missing-best-ask' };
    }
    if (oppositeBestAsk.price > VALUE_OPPOSITE_MAX_PRICE) {
      return { allowed: false, reason: 'opposite-too-expensive', oppositeBestAsk: oppositeBestAsk.price };
    }
    const oppositeGapToTarget = oppositeBestAsk.price - VALUE_SECOND_LEG_HARD_MAX_PRICE;
    if (oppositeGapToTarget > VALUE_OPPOSITE_GAP_TO_TARGET_MAX) {
      return { allowed: false, reason: 'opposite-too-far-from-target', oppositeBestAsk: oppositeBestAsk.price, oppositeGapToTarget };
    }

    const targetShares = this._targetShares();
    const requiredDepth = this._requiredDepthShares();
    const depth = this._bookDepthAtOrBelowPrice(book, effectiveMaxFirstLegPrice);
    if (depth < requiredDepth) {
      return { allowed: false, reason: 'insufficient-depth', depth, requiredDepth };
    }

    const plan = estimateBuyCostForSharesFromBook(book, targetShares, effectiveMaxFirstLegPrice);
    if (!plan || !plan.fullyFilled || plan.fillShares + 1e-9 < targetShares) {
      return { allowed: false, reason: 'cannot-fill-full-size', targetShares, plan: plan ?? null };
    }
    if (!Number.isFinite(plan.avgFillPrice) || plan.avgFillPrice > effectiveMaxFirstLegPrice) {
      return { allowed: false, reason: 'vwap-too-expensive', avgFillPrice: plan?.avgFillPrice ?? null };
    }

    return {
      allowed: true,
      side,
      targetShares,
      requiredDepth,
      depth,
      bestAsk: bestAsk.price,
      bestBid: bestBid.price,
      oppositeBestAsk: oppositeBestAsk.price,
      spread,
      maxFirstLegPrice: effectiveMaxFirstLegPrice,
      plan,
    };
  }

  _oneLegHoldLimits(market) {
    if (market.duration === '5m') {
      return {
        maxOneLegHoldMs: VALUE_MAX_ONE_LEG_HOLD_MS_5M,
        maxExtendedHoldMs: VALUE_EXTENDED_HOLD_MAX_MS_5M,
        finalExitBeforeExpiryMs: VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_5M,
        trailingDrawdownPerShare: VALUE_TRAILING_DRAWDOWN_PER_SHARE_5M,
        noUnpairedHoldLastMs: VALUE_NO_UNPAIRED_HOLD_LAST_MS_5M,
      };
    }
    return {
      maxOneLegHoldMs: VALUE_MAX_ONE_LEG_HOLD_MS_15M,
      maxExtendedHoldMs: VALUE_EXTENDED_HOLD_MAX_MS_15M,
      finalExitBeforeExpiryMs: VALUE_FINAL_EXIT_BEFORE_EXPIRY_MS_15M,
      trailingDrawdownPerShare: VALUE_TRAILING_DRAWDOWN_PER_SHARE_15M,
      noUnpairedHoldLastMs: VALUE_NO_UNPAIRED_HOLD_LAST_MS_15M,
    };
  }

  _averageEntryPrice(leg) {
    if (Number.isFinite(leg?.avgPrice)) return Number(leg.avgPrice);
    const shares = Number(leg?.shares ?? 0);
    if (shares <= 1e-9) return 0;
    return Number(leg?.spent ?? 0) / shares;
  }

  _entryFeeEstimateUsdc(leg, feeRateBps) {
    if (!leg?.entered) return 0;
    const shares = Number(leg?.shares ?? 0);
    const price = this._averageEntryPrice(leg);
    if (shares <= 1e-9 || !Number.isFinite(price) || price <= 0) return 0;
    return ClobClient.estimateTakerFeeUsdc({
      shares,
      price,
      feeRateBps,
    });
  }

  _entryAllInCostUsdc(market, side, feeRateBps) {
    const leg = market.legs[side];
    return Number(leg?.spent ?? 0) + this._entryFeeEstimateUsdc(leg, feeRateBps);
  }

  _netExitProfitPerShare(market, side, directExit, feeRateBps) {
    const shares = this._valueOpenShares(market, side);
    if (shares <= 1e-9 || !directExit?.allowed) return null;
    const costBasis = this._entryAllInCostUsdc(market, side, feeRateBps);
    return (directExit.netRecovery - costBasis) / shares;
  }

  async _getFeeRateBps(tokenId) {
    try {
      return Number(await ClobClient.getTakerFeeBps(tokenId)) || 0;
    } catch {
      return 0;
    }
  }

  _bookAgeMs(sideQuote) {
    return Date.now() - Number(sideQuote?.observedAt ?? 0);
  }

  _secondLegRequiredDepthShares(market) {
    return this._targetShares() * VALUE_SECOND_LEG_MIN_DEPTH_MULTIPLIER;
  }

  async _evaluateSecondLegCandidate(market, secondSide, secondBook) {
    const secondTokenId = secondSide === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const secondQuote = market.lastLiveQuote?.[secondSide];
    if (!secondQuote?.observedAt || this._bookAgeMs(secondQuote) > VALUE_MAX_BOOK_AGE_MS) {
      return { allowed: false, reason: 'SECOND_BOOK_STALE' };
    }

    const bestBid = bestBidFromBook(secondBook);
    const bestAsk = bestAskFromBook(secondBook);
    if (!bestBid || !bestAsk) {
      return { allowed: false, reason: 'SECOND_BOOK_EMPTY' };
    }

    const spread = bestAsk.price - bestBid.price;
    if (spread > VALUE_SECOND_LEG_EXTREME_SPREAD) {
      return { allowed: false, reason: 'SECOND_SPREAD_EXTREME', spread };
    }
    if (spread > VALUE_SECOND_LEG_MAX_SPREAD) {
      return { allowed: false, reason: 'SECOND_SPREAD_TOO_WIDE', spread };
    }

    const maxLimitPrice = Math.min(VALUE_TARGET_PRICE, VALUE_SECOND_LEG_HARD_MAX_PRICE);
    const depth = this._bookDepthAtOrBelowPrice(secondBook, maxLimitPrice);
    const requiredDepth = this._secondLegRequiredDepthShares(market);
    if (depth < requiredDepth) {
      return { allowed: false, reason: 'NOT_ENOUGH_SECOND_DEPTH', depth, requiredDepth, spread };
    }

    const shares = this._targetShares();
    const plan = estimateBuyCostForSharesFromBook(secondBook, shares, maxLimitPrice);
    if (!plan || !plan.fullyFilled || plan.fillShares + 1e-9 < shares) {
      return { allowed: false, reason: 'CANNOT_FILL_SECOND_SIZE', depth, spread, plan: plan ?? null };
    }

    const feeRateBps = await this._getFeeRateBps(secondTokenId);
    const secondFee = ClobClient.estimateTakerFeeUsdc({
      shares,
      price: plan.avgFillPrice,
      feeRateBps,
    });
    const totalCost = market.totalCost + plan.spentUsdc + secondFee;
    const mergePayout = shares;
    const lockProfit = mergePayout - totalCost;
    const minLockProfit = shares * this._dynamicSecondLegMinLockProfitPerShare(market);
    if (lockProfit < minLockProfit) {
      return {
        allowed: false,
        reason: 'LOCK_PROFIT_TOO_SMALL',
        depth,
        spread,
        plan,
        estimatedSecondFee: secondFee,
        estimatedLockProfit: lockProfit,
      };
    }

    return {
      allowed: true,
      spread,
      depth,
      plan,
      feeRateBps,
      estimatedSecondFee: secondFee,
      estimatedLockProfit: lockProfit,
      maxLimitPrice,
    };
  }

  _evaluateDirectSellExit(book, shares, feeRateBps) {
    const plan = estimateSellProceedsForSharesFromBook(book, shares, 0.0001);
    if (!plan || !plan.fullyFilled || plan.soldShares + 1e-9 < shares) {
      return { allowed: false, reason: 'NO_DIRECT_SELL_DEPTH', netRecovery: -Infinity };
    }
    const fee = ClobClient.estimateTakerFeeUsdc({
      shares,
      price: plan.avgFillPrice,
      feeRateBps,
    });
    return {
      allowed: true,
      minPrice: plan.avgFillPrice,
      vwap: plan.avgFillPrice,
      fee,
      plan,
      netRecovery: plan.proceedsUsdc - fee,
    };
  }

  _evaluateHedgeMergeExit(book, shares, feeRateBps) {
    const plan = estimateBuyCostForSharesFromBook(book, shares, 0.99);
    if (!plan || !plan.fullyFilled || plan.fillShares + 1e-9 < shares) {
      return { allowed: false, reason: 'NO_HEDGE_BUY_DEPTH', netRecovery: -Infinity };
    }
    const fee = ClobClient.estimateTakerFeeUsdc({
      shares,
      price: plan.avgFillPrice,
      feeRateBps,
    });
    return {
      allowed: true,
      maxPrice: plan.avgFillPrice,
      vwap: plan.avgFillPrice,
      fee,
      plan,
      netRecovery: shares - (plan.spentUsdc + fee),
    };
  }

  async _shouldStopLossUnpairedFirstLeg(market, openSide, openBook) {
    const shares = this._openShares(market.legs[openSide]);
    if (shares <= 1e-9) return false;
    const tokenId = openSide === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const feeRateBps = await this._getFeeRateBps(tokenId);
    const directExit = this._evaluateDirectSellExit(openBook, shares, feeRateBps);
    if (!directExit.allowed) return false;
    const netProfitPerShare = this._netExitProfitPerShare(market, openSide, directExit, feeRateBps);
    if (!Number.isFinite(netProfitPerShare)) return false;
    const lossPerShare = -netProfitPerShare;
    return lossPerShare >= VALUE_MAX_UNPAIRED_LOSS_PER_SHARE;
  }

  async _tryEnterFirstLeg(market, upBook, downBook, timeLeftSec) {
    const stableEnough = this._advanceStability(market, upBook, downBook);
    if (!stableEnough) {
      this._emitDecision(market, {
        type: 'poll-skip',
        side: null,
        reason: 'market-not-stable',
        timeLeftSec,
        stableSnapshotCount: market.stableSnapshotCount,
        requiredStableSnapshots: VALUE_STABLE_SNAPSHOTS_REQUIRED,
        upSpread: this._spread(upBook),
        downSpread: this._spread(downBook),
      });
      return;
    }

    const upCandidate = this._evaluateFirstLegCandidate(market, 'Up', upBook, downBook, timeLeftSec);
    const downCandidate = this._evaluateFirstLegCandidate(market, 'Down', downBook, upBook, timeLeftSec);
    const allowedCandidates = [upCandidate, downCandidate].filter((candidate) => candidate.allowed);
    if (!allowedCandidates.length) {
      this._emitDecision(market, {
        type: 'poll-skip',
        side: null,
        reason: 'no-first-leg-candidate',
        timeLeftSec,
        upCandidate,
        downCandidate,
      });
      return;
    }

    allowedCandidates.sort((a, b) => a.plan.avgFillPrice - b.plan.avgFillPrice);
    const chosen = allowedCandidates[0];
    const chosenBook = chosen.side === 'Up' ? upBook : downBook;
    const entered = await this._enterLeg(market, chosen.side, chosenBook, {
      exactPlan: chosen.plan,
      entryRole: 'first',
      useFok: true,
      maxPriceOverride: VALUE_TARGET_PRICE,
    });
    if (entered) {
      this._resetStability(market);
    }
  }

  async _evaluateOneLegCheckpoint(market, openSide, openBook, secondSide, secondBook) {
    const { finalExitBeforeExpiryMs } = this._oneLegHoldLimits(market);
    const timeToExpiryMs = Math.max(0, (market.closeTs * 1000) - Date.now());
    if (timeToExpiryMs <= finalExitBeforeExpiryMs) {
      return {
        action: 'EXIT',
        reason: 'CHECKPOINT_TOO_CLOSE_TO_EXPIRY',
      };
    }

    const secondCandidate = await this._evaluateSecondLegCandidate(market, secondSide, secondBook);
    if (secondCandidate.allowed) {
      return {
        action: 'COMPLETE_SECOND_LEG',
        reason: 'SECOND_LEG_AVAILABLE_AT_CHECKPOINT',
        candidate: secondCandidate,
      };
    }

    const openTokenId = openSide === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const feeRateBps = await this._getFeeRateBps(openTokenId);
    const shares = this._valueOpenShares(market, openSide);
    const directExit = this._evaluateDirectSellExit(openBook, shares, feeRateBps);
    if (!directExit.allowed) {
      return {
        action: 'EXIT',
        reason: 'NO_FIRST_LEG_EXIT_DEPTH_AT_CHECKPOINT',
        directExit,
      };
    }

    const netProfitPerShare = this._netExitProfitPerShare(market, openSide, directExit, feeRateBps);
    if (!Number.isFinite(netProfitPerShare) || netProfitPerShare <= 0) {
      return {
        action: 'EXIT',
        reason: 'FIRST_LEG_NOT_PROFITABLE_AT_CHECKPOINT',
        directExit,
        netProfitPerShare,
      };
    }

    if (netProfitPerShare >= VALUE_DIRECT_TAKE_PROFIT_PER_SHARE) {
      return {
        action: 'DIRECT_PROFIT_EXIT',
        reason: 'FIRST_LEG_DIRECT_PROFIT_TARGET_REACHED',
        directExit,
        netProfitPerShare,
      };
    }

    if (netProfitPerShare >= VALUE_CONTINUE_MIN_PROFIT_PER_SHARE) {
      return {
        action: 'EXTENDED_HOLD',
        reason: 'FIRST_LEG_PROFITABLE_ALLOW_EXTENDED_HOLD',
        directExit,
        netProfitPerShare,
      };
    }

    return {
      action: 'EXIT',
      reason: 'FIRST_LEG_PROFIT_TOO_SMALL_TO_EXTEND',
      directExit,
      netProfitPerShare,
    };
  }

  async _manageExtendedHoldState(market, openSide, openBook, secondSide, secondBook, timeLeftSec) {
    const hold = market.extendedHold;
    if (!hold?.active) return false;

    const { maxExtendedHoldMs, finalExitBeforeExpiryMs, trailingDrawdownPerShare } = this._oneLegHoldLimits(market);
    const nowMs = Date.now();
    const timeToExpiryMs = Math.max(0, (market.closeTs * 1000) - nowMs);
    const extendedElapsedMs = nowMs - Number(hold.startedAt ?? nowMs);

    if (extendedElapsedMs >= maxExtendedHoldMs) {
      await this._exitUnpairedFirstLeg(market, openSide, openBook, secondSide, secondBook, 'EXTENDED_HOLD_TIME_EXCEEDED');
      return true;
    }

    if (timeToExpiryMs <= finalExitBeforeExpiryMs) {
      await this._exitUnpairedFirstLeg(market, openSide, openBook, secondSide, secondBook, 'EXTENDED_HOLD_TOO_CLOSE_TO_EXPIRY');
      return true;
    }

    const candidate = await this._evaluateSecondLegCandidate(market, secondSide, secondBook);
    if (candidate.allowed) {
      const entered = await this._enterLeg(market, secondSide, secondBook, {
        exactPlan: candidate.plan,
        entryRole: 'second',
        useFok: true,
        maxPriceOverride: candidate.maxLimitPrice,
      });
      if (entered && VALUE_MERGE_ON_SECOND_LEG) {
        await this._mergeMatchedPair(market, this._targetShares(), 'extended-hold-second-leg-merge');
      }
      return true;
    }

    const openTokenId = openSide === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const feeRateBps = await this._getFeeRateBps(openTokenId);
    const shares = this._valueOpenShares(market, openSide);
    const directExit = this._evaluateDirectSellExit(openBook, shares, feeRateBps);
    const netProfitPerShare = directExit.allowed
      ? this._netExitProfitPerShare(market, openSide, directExit, feeRateBps)
      : null;

    if (Number.isFinite(netProfitPerShare)) {
      hold.bestNetExitProfitPerShare = Math.max(
        Number(hold.bestNetExitProfitPerShare ?? Number.NEGATIVE_INFINITY),
        netProfitPerShare,
      );
      if (netProfitPerShare >= VALUE_DIRECT_TAKE_PROFIT_PER_SHARE) {
        const sold = await this._sellShares(market, openSide, openBook, shares, {
          actionType: 'extended-hold-profit-exit',
          minPrice: directExit.minPrice,
        });
        if (sold) {
          market.lastAction = `extended hold profit exited ${openSide.toLowerCase()}`;
          this.emit('markets-updated', this.snapshotMarkets());
        }
        return true;
      }
      if (netProfitPerShare <= 0) {
        await this._exitUnpairedFirstLeg(market, openSide, openBook, secondSide, secondBook, 'EXTENDED_HOLD_LOST_PROFIT');
        return true;
      }
      if (netProfitPerShare <= Number(hold.bestNetExitProfitPerShare) - trailingDrawdownPerShare) {
        await this._exitUnpairedFirstLeg(market, openSide, openBook, secondSide, secondBook, 'EXTENDED_HOLD_TRAILING_STOP_TRIGGERED');
        return true;
      }
    }

    this._emitDecision(market, {
      type: 'extended-hold',
      side: secondSide,
      reason: candidate.reason ?? 'EXTENDED_HOLD_WAITING',
      timeLeftSec,
      waitingFor: secondSide,
      quote: sideQuotes(market.quote[secondSide]),
      exitPlan: market.exitPlan,
      candidate,
      netProfitPerShare,
      bestNetExitProfitPerShare: hold.bestNetExitProfitPerShare ?? null,
      trailingDrawdownPerShare,
    });
    return true;
  }

  async _manageSecondLegState(market, openSide, openBook, secondSide, secondBook, timeLeftSec) {
    if (market.state !== `WAIT_${secondSide.toUpperCase()}` && market.state !== `WAIT_${secondSide === 'Up' ? 'UP' : 'DOWN'}`) {
      // no-op; kept defensive against state changes during async work
    }

    if (await this._simulateExitFill(market, openSide, openBook, secondBook)) return;

    const elapsedSinceFirstFill = Date.now() - Number(market.legs[openSide].enteredAt ?? Date.now());
    const timeToExpiryMs = Math.max(0, (market.closeTs * 1000) - Date.now());
    const { maxOneLegHoldMs, noUnpairedHoldLastMs } = this._oneLegHoldLimits(market);

    if (await this._manageExtendedHoldState(market, openSide, openBook, secondSide, secondBook, timeLeftSec)) {
      return;
    }

    if (elapsedSinceFirstFill >= maxOneLegHoldMs) {
      const checkpoint = await this._evaluateOneLegCheckpoint(market, openSide, openBook, secondSide, secondBook);
      if (checkpoint.action === 'COMPLETE_SECOND_LEG') {
        const entered = await this._enterLeg(market, secondSide, secondBook, {
          exactPlan: checkpoint.candidate.plan,
          entryRole: 'second',
          useFok: true,
          maxPriceOverride: checkpoint.candidate.maxLimitPrice,
        });
        if (entered && VALUE_MERGE_ON_SECOND_LEG) {
          await this._mergeMatchedPair(market, this._targetShares(), 'checkpoint-second-leg-merge');
        }
        return;
      }
      if (checkpoint.action === 'DIRECT_PROFIT_EXIT') {
        const sold = await this._sellShares(market, openSide, openBook, this._valueOpenShares(market, openSide), {
          actionType: 'checkpoint-profit-exit',
          minPrice: checkpoint.directExit.minPrice,
        });
        if (sold) {
          market.lastAction = `checkpoint profit exited ${openSide.toLowerCase()}`;
          this.emit('markets-updated', this.snapshotMarkets());
        }
        return;
      }
      if (checkpoint.action === 'EXTENDED_HOLD') {
        market.extendedHold = {
          active: true,
          startedAt: Date.now(),
          bestNetExitProfitPerShare: checkpoint.netProfitPerShare,
          activatedReason: checkpoint.reason,
        };
        market.lastAction = `extended hold armed for ${openSide.toLowerCase()}`;
        this._emitDecision(market, {
          type: 'checkpoint',
          side: secondSide,
          reason: checkpoint.reason,
          timeLeftSec,
          waitingFor: secondSide,
          quote: sideQuotes(market.quote[secondSide]),
          exitPlan: market.exitPlan,
          directExit: checkpoint.directExit,
          netProfitPerShare: checkpoint.netProfitPerShare,
        });
        this.emit('markets-updated', this.snapshotMarkets());
        return;
      }
      await this._exitUnpairedFirstLeg(market, openSide, openBook, secondSide, secondBook, checkpoint.reason ?? 'MAX_ONE_LEG_HOLD_EXCEEDED');
      return;
    }

    if (timeToExpiryMs <= noUnpairedHoldLastMs) {
      await this._exitUnpairedFirstLeg(market, openSide, openBook, secondSide, secondBook, 'TOO_CLOSE_TO_EXPIRY_UNPAIRED');
      return;
    }

    if (await this._shouldStopLossUnpairedFirstLeg(market, openSide, openBook)) {
      await this._exitUnpairedFirstLeg(market, openSide, openBook, secondSide, secondBook, 'STOP_LOSS_UNPAIRED_FIRST_LEG');
      return;
    }

    const candidate = await this._evaluateSecondLegCandidate(market, secondSide, secondBook);
    this._emitDecision(market, {
      type: 'waiting',
      side: secondSide,
      reason: candidate.allowed ? 'second-leg-candidate-allowed' : candidate.reason,
      timeLeftSec,
      waitingFor: secondSide,
      quote: sideQuotes(market.quote[secondSide]),
      exitPlan: market.exitPlan,
      candidate,
    });

    if (!candidate.allowed) {
      if (this._shouldImmediateExitStrandedLeg(market, openSide, openBook)) {
        await this._exitUnpairedFirstLeg(market, openSide, openBook, secondSide, secondBook, 'IMMEDIATE_EXIT_THRESHOLD');
      } else if (timeLeftSec <= VALUE_SECOND_LEG_CUTOFF_SECONDS) {
        await this._exitUnpairedFirstLeg(market, openSide, openBook, secondSide, secondBook, 'SECOND_LEG_CUTOFF');
      }
      return;
    }

    const entered = await this._enterLeg(market, secondSide, secondBook, {
      exactPlan: candidate.plan,
      entryRole: 'second',
      useFok: true,
      maxPriceOverride: candidate.maxLimitPrice,
    });
    if (entered && VALUE_MERGE_ON_SECOND_LEG) {
      await this._mergeMatchedPair(market, this._targetShares(), 'second-leg-merge');
    }
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
      if (order.role !== 'first') continue;
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
    const leg = market.legs[side];
    const openShares = this._valueOpenShares(market, side);
    if (openShares <= 1e-9) return false;

    const bestBid = bestBidFromBook(book)?.price ?? null;
    if (!Number.isFinite(bestBid) || bestBid >= market.exitPlan.triggerPrice) return false;

    await this._cancelMarketOrders(market, 'immediate-exit');
    await this._forcePairOnly(market, side, book, oppositeSide(side), oppositeBook, {
      immediate: true,
      source: 'simulated-exit-order',
    });
    return true;
  }

  async handleFill(fill) {
    const orderId = fill.orderId ?? null;
    if (orderId && this._processedOrderIds.has(orderId)) return;
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
    if (fill.orderId) this._processedOrderIds.add(fill.orderId);
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
      market.extendedHold = null;
      market.exitPlan = {
        side,
        triggerPrice: VALUE_IMMEDIATE_EXIT_BELOW_PRICE,
        armedAt: Date.now(),
        mode: 'synthetic-threshold',
      };
      await this._ensureSecondLegAndExit(market);
    } else if (fill.role === 'second') {
      market.pendingBuyOrders[side] = null;
      market.extendedHold = null;
      market.exitPlan = null;
      await this._cancelMarketOrders(market, 'pair-complete');
      this._ensureSettlementWatch(market);
    }

    this.emit('markets-updated', this.snapshotMarkets());
  }

  async _recordSellFill(market, side, fill) {
    if (fill.orderId) this._processedOrderIds.add(fill.orderId);
    const leg = market.legs[side];
    const tokenId = side === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const feeRateBps = await this._getFeeRateBps(tokenId);
    const estimatedFee = ClobClient.estimateTakerFeeUsdc({
      shares: fill.shares,
      price: fill.price,
      feeRateBps,
    });
    leg.soldShares += fill.shares;
    leg.soldUsdc += fill.proceedsUsdc;
    leg.sellAvgPrice = leg.soldShares > 0 ? leg.soldUsdc / leg.soldShares : fill.price;
    leg.soldAt = Date.now();
    market.cashProceeds += fill.proceedsUsdc;
    market.extendedHold = null;
    market.exitPlan = null;
    if (market.state === 'FLAT' || (this._openShares(leg) <= 1e-9 && market.hadAnyTrade)) {
      market.exitReview = {
        active: true,
        side,
        shares: fill.shares,
        actionType: 'sell-fill',
        exitedAt: Date.now(),
        baseNetRecovery: fill.proceedsUsdc - estimatedFee,
        bestPostExitNetRecovery: fill.proceedsUsdc - estimatedFee,
        improvementUsdc: 0,
        improvementPerShare: 0,
        bestSeenAt: null,
        bestSeenVwap: fill.price,
        couldHaveDoneBetter: false,
      };
    }
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

  async _enterLeg(market, side, book, { force = false, targetSharesOverride = null, exactPlan = null, entryRole = null, useFok = false, maxPriceOverride = null } = {}) {
    const leg = market.legs[side];
    if (leg.entered) {
      this._emitDecision(market, {
        type: 'buy-skipped',
        side,
        reason: 'already-entered',
        force,
      });
      return false;
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
      return false;
    }
    if (!eligible) {
      this._emitDecision(market, {
        type: 'buy-skipped',
        side,
        reason: force ? 'force-not-eligible' : 'not-eligible',
        force,
        quote: sideQuotes({ bestAsk: quote.price }),
      });
      return false;
    }

    const maxPrice = Number.isFinite(maxPriceOverride)
      ? Number(maxPriceOverride)
      : this._entryMaxPrice(market, quote.price, force);

    const plan = exactPlan ?? (Number.isFinite(targetSharesOverride) && targetSharesOverride > 0
      ? estimateBuyCostForSharesFromBook(book, targetSharesOverride, maxPrice)
      : VALUE_ORDER_MODE === 'SHARES'
      ? estimateBuyCostForSharesFromBook(book, VALUE_TARGET_SHARES, maxPrice)
      : ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, VALUE_LEG_USDC, 0));
    if (!plan || plan.fillShares <= 0 || plan.spentUsdc <= 0) {
      this._emitDecision(market, {
        type: 'buy-skipped',
        side,
        reason: 'no-fill-plan',
        force,
        targetSharesOverride,
        maxPrice,
        bestAsk: quote.price,
        executionPlan: plan ?? null,
      });
      return false;
    }

    const tokenId = side === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const feeRateBps = await this._getFeeRateBps(tokenId);
    const estimatedFee = ClobClient.estimateTakerFeeUsdc({
      shares: plan.soldShares,
      price: plan.avgFillPrice ?? bestBid.price,
      feeRateBps,
    });
    const snapshot = bookSnapshot(book);
    try {
      let response = null;
      if (!VALUE_DRY_RUN) {
        if (useFok) {
          response = await ClobClient.postFOKLimitBuy(this.wallet, tokenId, maxPrice, plan.fillShares);
          if (response?.success === false) {
            this._emitDecision(market, {
              type: 'buy-skipped',
              side,
              reason: 'fok-rejected',
              force,
              bestAsk: quote.price,
              maxPrice,
              executionPlan: plan,
            });
            return false;
          }
        } else {
          response = await ClobClient.postIOCBuy(this.wallet, tokenId, maxPrice, plan.spentUsdc);
        }
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
      market.extendedHold = null;
      if (force) market.hadForcePair = true;
      if (!market.firstSide) market.firstSide = side;
      market.lastAction = `${VALUE_DRY_RUN ? 'dry-run' : 'buy'} ${side.toLowerCase()} @ ${leg.avgPrice.toFixed(4)}`;
      market.state = this._computeState(market);
      this.actions += 1;
      if (isPairedState(market.state)) this._ensureSettlementWatch(market);

      const responseOrderId = response?.orderID ?? response?.orderId ?? null;
      if (!VALUE_DRY_RUN && responseOrderId) {
        this._processedOrderIds.add(responseOrderId);
      }

      const action = {
        type: VALUE_DRY_RUN ? 'dry-run-buy' : 'buy',
        slug: market.slug,
        side,
        state: market.state,
        spent: leg.spent,
        shares: leg.shares,
        price: leg.avgPrice,
        forced: force,
        useFok,
        role: entryRole,
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
        useFok,
        role: entryRole,
        targetSharesOverride,
        tokenId,
        bestAsk: quote.price,
        maxPrice,
        executionPlan: plan,
        dryRun: VALUE_DRY_RUN,
      });
      this.emit('markets-updated', this.snapshotMarkets());
      if (isPairedState(market.state)) {
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
      return true;
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
        forced: force,
        targetSharesOverride,
        tokenId,
        bestAsk: quote?.price ?? null,
        maxPrice,
        executionPlan: plan,
        book: snapshot,
        timestamp: Date.now(),
      });
      return false;
    }
  }

  _computeState(market) {
    const up = this._openShares(market.legs.Up) > 1e-9;
    const down = this._openShares(market.legs.Down) > 1e-9;
    if (up && down) return market.hadForcePair ? 'FORCED_PAIRED' : 'PAIRED';
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

    await this._forcePairOnly(market, openSide, openBook, oppositeSide, oppositeBook, {
      immediate,
      source: immediate ? 'immediate-exit' : 'endgame',
    });
  }

  _shouldImmediateExitStrandedLeg(market, side, book) {
    const leg = market.legs[side];
    if (!leg?.entered || this._valueOpenShares(market, side) <= 1e-9) return false;
    if (!Number.isFinite(VALUE_IMMEDIATE_EXIT_BELOW_PRICE) || VALUE_IMMEDIATE_EXIT_BELOW_PRICE <= 0) {
      return false;
    }

    const bestBid = bestBidFromBook(book)?.price ?? null;
    return Number.isFinite(bestBid) && bestBid < VALUE_IMMEDIATE_EXIT_BELOW_PRICE;
  }

  _shouldExitStrandedLeg(market, side, book) {
    const leg = market.legs[side];
    if (!leg?.entered || this._valueOpenShares(market, side) <= 1e-9) return false;
    if (!Number.isFinite(VALUE_ENDGAME_EXIT_BELOW_PRICE) || VALUE_ENDGAME_EXIT_BELOW_PRICE <= 0) {
      return false;
    }

    const bestBid = bestBidFromBook(book)?.price ?? null;
    return Number.isFinite(bestBid) && bestBid < VALUE_ENDGAME_EXIT_BELOW_PRICE;
  }

  async _flattenOpenLeg(market, side, book) {
    return this._sellShares(market, side, book, this._openShares(market.legs[side]), {
      actionType: 'flatten',
      minPrice: 0.01,
    });
  }

  async _sellShares(market, side, book, targetShares, { actionType = 'sell', minPrice = 0.01 } = {}) {
    const leg = market.legs[side];
    const openShares = Math.min(this._openShares(leg), Number(targetShares ?? 0));
    if (openShares <= 1e-9) {
      this._emitDecision(market, {
        type: `${actionType}-skipped`,
        side,
        reason: 'already-flat',
      });
      return true;
    }

    const bestBid = bestBidFromBook(book);
    if (!bestBid || !Number.isFinite(bestBid.price) || bestBid.price <= 0) {
      this._emitDecision(market, {
        type: `${actionType}-skipped`,
        side,
        reason: 'no-best-bid',
      });
      return false;
    }

    const plan = estimateSellProceedsForSharesFromBook(book, openShares, minPrice);
    if (!plan || !plan.fullyFilled || plan.soldShares <= 0 || plan.proceedsUsdc <= 0) {
      this._emitDecision(market, {
        type: `${actionType}-skipped`,
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
      if (market.state === 'FLAT') {
        market.exitReview = {
          active: true,
          side,
          shares: plan.soldShares,
          actionType,
          exitedAt: Date.now(),
          baseNetRecovery: plan.proceedsUsdc - estimatedFee,
          bestPostExitNetRecovery: plan.proceedsUsdc - estimatedFee,
          improvementUsdc: 0,
          improvementPerShare: 0,
          bestSeenAt: null,
          bestSeenVwap: leg.sellAvgPrice,
          couldHaveDoneBetter: false,
        };
      }
      market.pnl = market.cashProceeds + market.redeemed - market.totalCost;
      this.actions += 1;

      this.emit('action', {
        type: VALUE_DRY_RUN ? `dry-run-${actionType}` : actionType,
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
      logger.info(`value.engine: leg ${actionType}`, {
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

  async _forcePairOnly(market, openSide, openBook, oppositeSideName, oppositeBook, { immediate = false, source = 'force-pair' } = {}) {
    const targetShares = this._valueOpenShares(market, openSide);
    if (targetShares <= 1e-9) {
      market.lastAction = `${source} skipped - no stranded value shares`;
      this._emitDecision(market, {
        type: immediate ? 'immediate-exit' : 'endgame',
        side: openSide,
        reason: 'no-stranded-value-shares',
        openSide,
        oppositeSide: oppositeSideName,
      });
      this._ensureSettlementWatch(market);
      this.emit('markets-updated', this.snapshotMarkets());
      return;
    }

    if (!oppositeBook) {
      market.lastAction = `${source} no ${oppositeSideName.toLowerCase()} book for force-pair`;
      this._emitDecision(market, {
        type: immediate ? 'immediate-exit' : 'endgame',
        side: oppositeSideName,
        reason: 'force-pair-no-opposite-book',
        openSide,
        oppositeSide: oppositeSideName,
        targetShares,
      });
      this._ensureSettlementWatch(market);
      this.emit('markets-updated', this.snapshotMarkets());
      logger.info(`value.engine: ${source} skipped, opposite-leg book unavailable`, {
        slug: market.slug,
        openSide,
        oppositeSide: oppositeSideName,
        targetShares,
        dryRun: VALUE_DRY_RUN,
      });
      return;
    }

    const paired = await this._enterLeg(market, oppositeSideName, oppositeBook, {
      force: true,
      targetSharesOverride: targetShares,
    });
    if (!paired) {
      this._ensureSettlementWatch(market);
      return;
    }
    market.lastAction = `${source} forced paired`;
    this._ensureSettlementWatch(market);
    this.emit('markets-updated', this.snapshotMarkets());
  }

  async _mergeMatchedPair(market, shares, source = 'merge') {
    const mergeShares = Math.min(
      Number(shares ?? 0),
      this._openShares(market.legs.Up),
      this._openShares(market.legs.Down),
    );
    if (!Number.isFinite(mergeShares) || mergeShares <= 1e-9) return false;

    if (!VALUE_DRY_RUN) {
      await mergePositions(market.conditionId, mergeShares);
    }

    market.legs.Up.soldShares += mergeShares;
    market.legs.Down.soldShares += mergeShares;
    market.extendedHold = null;
    market.cashProceeds += mergeShares;
    market.mergedUsdc += mergeShares;
    market.state = this._computeState(market);
    market.pnl = market.cashProceeds + market.redeemed - market.totalCost;
    market.lastAction = `${source} ${mergeShares.toFixed(4)} merged`;
    this.actions += 1;
    this.emit('action', {
      type: VALUE_DRY_RUN ? 'dry-run-merged' : 'merged',
      slug: market.slug,
      side: null,
      state: market.state,
      shares: mergeShares,
      spent: mergeShares,
      timestamp: Date.now(),
    });
    this.emit('markets-updated', this.snapshotMarkets());
    return true;
  }

  async _exitUnpairedFirstLeg(market, openSide, openBook, secondSide, secondBook, reason) {
    await this._cancelMarketOrders(market, reason);
    const shares = this._openShares(market.legs[openSide]);
    const openTokenId = openSide === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const secondTokenId = secondSide === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const [openFeeRateBps, secondFeeRateBps] = await Promise.all([
      this._getFeeRateBps(openTokenId),
      this._getFeeRateBps(secondTokenId),
    ]);

    const directExit = this._evaluateDirectSellExit(openBook, shares, openFeeRateBps);
    const hedgeMergeExit = this._evaluateHedgeMergeExit(secondBook, shares, secondFeeRateBps);
    this._emitDecision(market, {
      type: 'emergency-exit',
      side: openSide,
      reason,
      openSide,
      oppositeSide: secondSide,
      directExit,
      hedgeMergeExit,
    });

    if (hedgeMergeExit.allowed && hedgeMergeExit.netRecovery > directExit.netRecovery) {
      const paired = await this._enterLeg(market, secondSide, secondBook, {
        exactPlan: hedgeMergeExit.plan,
        targetSharesOverride: shares,
        entryRole: 'second',
        useFok: true,
        maxPriceOverride: hedgeMergeExit.maxPrice,
      });
      if (paired) {
        await this._mergeMatchedPair(market, shares, 'emergency-hedge-merge');
        return;
      }
    }

    if (directExit.allowed) {
      const sold = await this._sellShares(market, openSide, openBook, shares, {
        actionType: 'emergency-exit',
        minPrice: directExit.minPrice,
      });
      if (sold) {
        market.lastAction = `emergency exited ${openSide.toLowerCase()} (${reason})`;
        this.emit('markets-updated', this.snapshotMarkets());
        return;
      }
    }

    market.lastAction = `failed to exit ${openSide.toLowerCase()} (${reason})`;
    this._ensureSettlementWatch(market);
    this.emit('markets-updated', this.snapshotMarkets());
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
      question: market.question,
      symbol: market.symbol,
      duration: market.duration,
      windowTs: market.windowTs,
      closeTs: market.closeTs,
      state: market.state,
      marketState: market.settled ? 'SETTLED' : 'OPEN',
      timeLeftSec: extra.timeLeftSec ?? Math.max(0, market.closeTs - nowSec()),
      firstSide: market.firstSide,
      positionType: this._positionType(market),
      enteredLegs: this._enteredLegs(market),
      up: {
        ...sideQuotes(market.quote.Up),
        bookLive: extra.upBookLive ?? null,
      },
      down: {
        ...sideQuotes(market.quote.Down),
        bookLive: extra.downBookLive ?? null,
      },
      books: {
        up: extra.upBook ? bookSnapshot(extra.upBook) : null,
        down: extra.downBook ? bookSnapshot(extra.downBook) : null,
      },
      strategy: {
        totalCost: market.totalCost,
        cashProceeds: market.cashProceeds,
        redeemed: market.redeemed,
        pnl: market.pnl,
        lastAction: market.lastAction,
        exitPlan: market.exitPlan,
        extendedHold: market.extendedHold,
        firstFee: market.firstFee,
        secondFee: market.secondFee,
        mergedUsdc: market.mergedUsdc,
        hadAnyTrade: market.hadAnyTrade,
        hadImmediateExit: market.hadImmediateExit,
        hadForcePair: market.hadForcePair,
      },
      legs: {
        up: { ...market.legs.Up },
        down: { ...market.legs.Down },
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
