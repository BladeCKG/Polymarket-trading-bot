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
import { bestAskFromBook, estimateBuyCostForSharesFromBook } from './bookMath.js';

function sideStateKey(side) {
  return side === 'Up' ? 'up' : 'down';
}

function oppositeSide(side) {
  return side === 'Up' ? 'Down' : 'Up';
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
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
      if (market.hasAnyLeg) {
        market.active = false;
        this._ensureSettlementWatch(market);
      } else {
        this.markets.delete(slug);
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
    const openMarkets = markets.filter((market) => !market.settled);
    const pairedOpen = openMarkets.filter((market) => market.state === 'PAIRED').length;
    const strandedOpen = openMarkets.filter((market) =>
      market.state === 'WAIT_UP' || market.state === 'WAIT_DOWN'
    ).length;
    const settledMarkets = markets.filter((market) => market.settled).length;
    const openCost = openMarkets.reduce((sum, market) => sum + market.totalCost, 0);
    const settledPnl = markets
      .filter((market) => market.settled)
      .reduce((sum, market) => sum + Number(market.pnl ?? 0), 0);

    return {
      trackedMarkets: markets.length,
      openMarkets: openMarkets.length,
      pairedOpenMarkets: pairedOpen,
      strandedOpenMarkets: strandedOpen,
      settledMarkets,
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
        state: market.state,
        entryBand: `${VALUE_ENTRY_MIN_PRICE.toFixed(2)}-${VALUE_ENTRY_MAX_PRICE.toFixed(2)}`,
        firstSide: market.firstSide,
        upAsk: market.quote.Up?.bestAsk ?? null,
        downAsk: market.quote.Down?.bestAsk ?? null,
        upStatus: market.legs.Up.entered ? 'entered' : 'waiting',
        upSpent: market.legs.Up.spent,
        upShares: market.legs.Up.shares,
        upPrice: market.legs.Up.avgPrice,
        downStatus: market.legs.Down.entered ? 'entered' : 'waiting',
        downSpent: market.legs.Down.spent,
        downShares: market.legs.Down.shares,
        downPrice: market.legs.Down.avgPrice,
        totalCost: market.totalCost,
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
      redeemed: 0,
      pnl: null,
      settled: false,
      settledAt: null,
      hasAnyLeg: false,
      outcomes: [],
      payouts: [],
    };
  }

  _emptyLeg(tokenId) {
    return {
      tokenId,
      entered: false,
      spent: 0,
      shares: 0,
      avgPrice: null,
      enteredAt: null,
      response: null,
    };
  }

  async _pollMarket(market) {
    const [upBook, downBook] = await Promise.all([
      ClobClient.getBook(market.upToken.tokenId),
      ClobClient.getBook(market.downToken.tokenId),
    ]);

    market.quote.Up = { bestAsk: bestAskFromBook(upBook)?.price ?? null };
    market.quote.Down = { bestAsk: bestAskFromBook(downBook)?.price ?? null };

    const timeLeftSec = market.closeTs - nowSec();
    if (timeLeftSec <= 0) {
      if (market.hasAnyLeg) this._ensureSettlementWatch(market);
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
      if (timeLeftSec <= VALUE_SECOND_LEG_CUTOFF_SECONDS) return;
      if (this._isInBand(market.quote.Down?.bestAsk)) {
        await this._enterLeg(market, 'Down', downBook);
      }
      return;
    }

    if (market.state === 'WAIT_UP') {
      if (timeLeftSec <= VALUE_SECOND_LEG_CUTOFF_SECONDS) return;
      if (this._isInBand(market.quote.Up?.bestAsk)) {
        await this._enterLeg(market, 'Up', upBook);
      }
    }
  }

  _isInBand(price) {
    return Number.isFinite(price) && price >= VALUE_ENTRY_MIN_PRICE && price <= VALUE_ENTRY_MAX_PRICE;
  }

  _countOpenMarkets() {
    return [...this.markets.values()].filter((market) => !market.settled && market.hasAnyLeg).length;
  }

  _countStrandedLegs() {
    return [...this.markets.values()].filter((market) =>
      !market.settled && (market.state === 'WAIT_UP' || market.state === 'WAIT_DOWN')
    ).length;
  }

  async _enterLeg(market, side, book) {
    const leg = market.legs[side];
    if (leg.entered) return;

    const quote = bestAskFromBook(book);
    if (!quote || !this._isInBand(quote.price)) return;

    const maxPrice = Math.min(
      VALUE_ENTRY_MAX_PRICE,
      Number((quote.price + VALUE_MAX_SLIPPAGE).toFixed(4)),
    );

    const plan = VALUE_ORDER_MODE === 'SHARES'
      ? estimateBuyCostForSharesFromBook(book, VALUE_TARGET_SHARES, maxPrice)
      : ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, VALUE_LEG_USDC, 0);
    if (!plan || plan.fillShares <= 0 || plan.spentUsdc <= 0) return;

    const tokenId = side === 'Up' ? market.upToken.tokenId : market.downToken.tokenId;
    const sideKey = sideStateKey(side);
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
      if (!market.firstSide) market.firstSide = side;
      market.lastAction = `${VALUE_DRY_RUN ? 'dry-run' : 'buy'} ${side.toLowerCase()} @ ${leg.avgPrice.toFixed(4)}`;
      market.state = this._nextState(market);
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
        timestamp: Date.now(),
      });
    }
  }

  _nextState(market) {
    const up = market.legs.Up.entered;
    const down = market.legs.Down.entered;
    if (up && down) return 'PAIRED';
    if (up) return 'WAIT_DOWN';
    if (down) return 'WAIT_UP';
    return 'NONE';
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

    const upRedeemed = market.legs.Up.entered ? market.legs.Up.shares * (payoutByOutcome.get('Up') ?? 0) : 0;
    const downRedeemed = market.legs.Down.entered ? market.legs.Down.shares * (payoutByOutcome.get('Down') ?? 0) : 0;
    market.redeemed = upRedeemed + downRedeemed;
    market.pnl = market.redeemed - market.totalCost;
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
