import {
  BEAT_DRY_RUN,
  BEAT_BOOK_POLL_MS,
  BEAT_BUY_COOLDOWN_MS,
  BEAT_DOWN_MAX_BUY_PRICE,
  BEAT_DOWN_MOVE_MAX_USD,
  BEAT_DOWN_MOVE_MIN_USD,
  BEAT_ENTRY_DELAY_SECONDS,
  BEAT_MAX_SLIPPAGE,
  BEAT_ORDER_MODE,
  BEAT_ORDER_SIZE_SHARES,
  BEAT_ORDER_SIZE_USDC,
  BEAT_UP_MAX_BUY_PRICE,
  BEAT_UP_MOVE_MAX_USD,
  BEAT_UP_MOVE_MIN_USD,
  BTC_PRICE_MAX_AGE_MS,
  MAX_INVENTORY_IMBALANCE,
  MAX_SPEND_PER_MARKET,
  MARKET_WINDOW_SECONDS,
  REDEEM_DELAY_AFTER_CLOSE,
  STOP_BUYING_BEFORE_CLOSE,
} from '../config.js';
import { BtcPriceFeed } from './btc-price-feed.js';
import { ClobClient } from '../clob.js';
import { getTokenBalances, redeemPositions, sleep } from '../onchain.js';
import { msUntil, waitForResolution } from '../market.js';
import { marketLogger } from '../logger.js';

const PHASE = {
  INIT: 'INIT',
  CAPTURE_BEAT: 'CAPTURE_BEAT',
  WAITING: 'WAITING',
  LIVE: 'LIVE',
  CANCELLED: 'CANCELLED',
  RESOLVING: 'RESOLVING',
  DONE: 'DONE',
  HALTED: 'HALTED',
};

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

function clampMaxPrice(askPrice, capPrice) {
  return Math.min(capPrice, askPrice + BEAT_MAX_SLIPPAGE);
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

export class BeatTrader {
  constructor(market, wallet, pnl) {
    this.market = market;
    this.wallet = wallet;
    this.pnl = pnl;
    this.log = marketLogger(market.slug);
    this.phase = PHASE.INIT;
    this.halted = false;
    this.balanceUp = 0;
    this.balanceDown = 0;
    this.totalSpent = 0;
    this.redeemedUsdc = 0;
    this.lastBuyAt = 0;
    this.beatPrice = null;
    this.latestBtcTick = null;
    this._btcFeed = null;
  }

  async run() {
    const { windowTs, conditionId, upToken, downToken } = this.market;
    const windowClose = windowTs + MARKET_WINDOW_SECONDS;

    this.log.info('BeatTrader: starting', {
      conditionId,
      dryRun: BEAT_DRY_RUN,
      upTokenId: upToken.tokenId,
      downTokenId: downToken.tokenId,
      windowOpen: new Date(windowTs * 1000).toISOString(),
      windowClose: new Date(windowClose * 1000).toISOString(),
      skipSeconds: BEAT_ENTRY_DELAY_SECONDS,
      orderMode: BEAT_ORDER_MODE,
    });

    this._startBtcFeed();

    try {
      const waitMs = msUntil(windowTs);
      if (waitMs > 0) {
        this.log.debug('BeatTrader: waiting for market open', { waitMs: Math.round(waitMs) });
        await sleep(waitMs);
      }

      this.phase = PHASE.CAPTURE_BEAT;
      this.beatPrice = await this._captureBeatPrice(windowTs);

      this.phase = PHASE.WAITING;
      if (BEAT_ENTRY_DELAY_SECONDS > 0) {
        this.log.info('BeatTrader: skipping early market seconds', {
          skipSeconds: BEAT_ENTRY_DELAY_SECONDS,
          beatPrice: this.beatPrice,
        });
        await sleep(BEAT_ENTRY_DELAY_SECONDS * 1000);
      }

      this.phase = PHASE.LIVE;
      await this._syncBalances(upToken.tokenId, downToken.tokenId);
      await this._monitorLoop(windowClose);

      this.phase = PHASE.CANCELLED;
      await this._cancelAllOrders(conditionId);
    } finally {
      this._btcFeed?.stop();
    }

    this.phase = PHASE.RESOLVING;
    await this._redeemPhase(conditionId, windowClose);

    this.phase = PHASE.DONE;
    this.log.info('BeatTrader: market complete', {
      beatPrice: this.beatPrice,
      totalSpent: this.totalSpent.toFixed(4),
      redeemedUsdc: this.redeemedUsdc.toFixed(4),
      netPnl: (this.redeemedUsdc - this.totalSpent).toFixed(4),
    });
  }

  _startBtcFeed() {
    this._btcFeed = new BtcPriceFeed();
    this._btcFeed.on('tick', (tick) => {
      this.latestBtcTick = tick;
    });
    this._btcFeed.on('error', (err) => {
      this.log.warn('BeatTrader: BTC feed error', { err: err.message });
    });
    this._btcFeed.start();
  }

  async _captureBeatPrice(windowTs) {
    const tick = await this._btcFeed.waitForTickAfter(windowTs * 1000, 20_000);
    this.latestBtcTick = tick;
    this.log.info('BeatTrader: captured BTC beat price', {
      beatPrice: tick.price,
      btcTime: tick.isoTime,
      bestBid: tick.bestBid,
      bestAsk: tick.bestAsk,
    });
    return tick.price;
  }

  async _monitorLoop(windowClose) {
    while (true) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= windowClose - STOP_BUYING_BEFORE_CLOSE) {
        this.log.info('BeatTrader: buy window closed', { stopBeforeClose: STOP_BUYING_BEFORE_CLOSE });
        break;
      }

      if (this._checkCircuitBreakers()) break;

      try {
        await this._maybeBuy();
      } catch (err) {
        this.log.warn('BeatTrader: monitor iteration failed', { err: err.message });
      }

      if (nowSec % 30 === 0) {
        await this._syncBalances(this.market.upToken.tokenId, this.market.downToken.tokenId);
      }

      await sleep(BEAT_BOOK_POLL_MS);
    }
  }

  async _maybeBuy() {
    if (!this.beatPrice) return;
    if (Date.now() - this.lastBuyAt < BEAT_BUY_COOLDOWN_MS) return;

    const tick = this.latestBtcTick;
    if (!tick) return;

    const ageMs = Date.now() - tick.timeMs;
    if (ageMs > BTC_PRICE_MAX_AGE_MS) {
      this.log.debug('BeatTrader: skipping stale BTC tick', { ageMs, maxAgeMs: BTC_PRICE_MAX_AGE_MS });
      return;
    }

    const delta = tick.price - this.beatPrice;
    const signal = this._signalFromDelta(delta);
    if (!signal) return;

    const [upBook, downBook] = await Promise.all([
      ClobClient.getBook(this.market.upToken.tokenId),
      ClobClient.getBook(this.market.downToken.tokenId),
    ]);

    const bookState = {
      Up: {
        tokenId: this.market.upToken.tokenId,
        book: upBook,
        bid: bestBid(upBook),
        ask: bestAsk(upBook),
        maxBuyPrice: BEAT_UP_MAX_BUY_PRICE,
      },
      Down: {
        tokenId: this.market.downToken.tokenId,
        book: downBook,
        bid: bestBid(downBook),
        ask: bestAsk(downBook),
        maxBuyPrice: BEAT_DOWN_MAX_BUY_PRICE,
      },
    };

    const leg = bookState[signal.side];
    if (!leg.ask || leg.ask.price > leg.maxBuyPrice) return;

    const maxPrice = clampMaxPrice(leg.ask.price, leg.maxBuyPrice);
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

  // Updated signal logic: only enforce the max move USD thresholds.
  _signalFromDelta(delta) {
    // Positive move up to the max allowed.
    if (delta > 0 && delta <= BEAT_UP_MOVE_MAX_USD) {
      return { side: 'Up' };
    }
    // Negative move (down) up to the max allowed.
    const downMove = Math.abs(delta);
    if (delta < 0 && downMove <= BEAT_DOWN_MOVE_MAX_USD) {
      return { side: 'Down' };
    }
    return null;
  }

  async _executeBuy({ side, tokenId, book, bestBid, bestAsk, maxPrice, delta, btcPrice }) {
    const remainingBudget = MAX_SPEND_PER_MARKET - this.totalSpent;
    if (remainingBudget < 1) {
      this.halted = true;
      return;
    }

    if (BEAT_ORDER_MODE === 'SHARES') {
      const requestedShares = Math.min(
        BEAT_ORDER_SIZE_SHARES,
        remainingBudget / Math.max(bestAsk.price, 0.0001),
      );
      if (requestedShares <= 0) return;

      const plan = estimateSharesFromBook(book, maxPrice, requestedShares);
      if (!plan.fullyFilled || plan.fillShares <= 0 || plan.spentUsdc <= 0) return;

      let response;
      if (!BEAT_DRY_RUN) {
        try {
          response = await ClobClient.postFOKLimitBuy(this.wallet, tokenId, maxPrice, plan.fillShares);
        } catch (err) {
          this.log.warn('BeatTrader: directional share buy failed', { side, err: err.message });
          return;
        }
        if (response?.success === false) return;
      }

      this._recordBuy(side, plan.spentUsdc / plan.fillShares, plan.fillShares);
      this.lastBuyAt = Date.now();
      this.log.info(`BeatTrader: ${BEAT_DRY_RUN ? 'dry-run buy' : 'bought'} directional shares`, {
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

    const amountUsdc = Math.min(BEAT_ORDER_SIZE_USDC, remainingBudget);
    if (amountUsdc <= 0) return;

    const plan = ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, amountUsdc, 0);
    if (!plan || plan.fillShares <= 0 || plan.spentUsdc <= 0) return;

    let response;
    if (!BEAT_DRY_RUN) {
      try {
        response = await ClobClient.postIOCBuy(this.wallet, tokenId, maxPrice, amountUsdc);
      } catch (err) {
        this.log.warn('BeatTrader: directional USDC buy failed', { side, err: err.message });
        return;
      }
      if (response?.success === false) return;
    }

    this._recordBuy(side, plan.avgFillPrice ?? bestAsk.price, plan.fillShares, plan.spentUsdc);
    this.lastBuyAt = Date.now();
    this.log.info(`BeatTrader: ${BEAT_DRY_RUN ? 'dry-run buy' : 'bought'} directional USDC`, {
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

  _recordBuy(side, avgPrice, shares, spentOverride = null) {
    const spentUsdc = spentOverride ?? (avgPrice * shares);
    this.totalSpent += spentUsdc;
    if (side === 'Up') this.balanceUp += shares;
    else this.balanceDown += shares;
    this.pnl.recordBuy(this.market.slug, side, avgPrice, shares);
  }

  _checkCircuitBreakers() {
    if (this.halted) return true;

    const imbalanceShares = Math.abs(this.balanceUp - this.balanceDown);
    if (imbalanceShares > MAX_INVENTORY_IMBALANCE) {
      this.log.warn('BeatTrader: inventory imbalance limit reached', {
        imbalanceShares,
        balanceUp: this.balanceUp,
        balanceDown: this.balanceDown,
      });
      this.halted = true;
      this.phase = PHASE.HALTED;
      return true;
    }

    if (this.totalSpent >= MAX_SPEND_PER_MARKET) {
      this.log.info('BeatTrader: spend cap reached', { totalSpent: this.totalSpent.toFixed(2) });
      this.halted = true;
      this.phase = PHASE.HALTED;
      return true;
    }

    return false;
  }

  async _cancelAllOrders(conditionId) {
    if (BEAT_DRY_RUN) {
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
    if (BEAT_DRY_RUN) {
      const estimatedPayout = this._estimateRedeemPayout(null);
      this.redeemedUsdc += estimatedPayout;
      this.pnl.recordRedeem(this.market.slug, estimatedPayout, 'dry-run');
      this.log.info('BeatTrader: dry-run redeem simulated', {
        estimatedPayout,
        upHeld: this.balanceUp,
        downHeld: this.balanceDown,
      });
      return;
    }

    const redeemNotBeforeMs = (windowClose + REDEEM_DELAY_AFTER_CLOSE) * 1000;
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

    const totalHeld = this.balanceUp + this.balanceDown;
    if (totalHeld < 0.001) {
      this.log.info('BeatTrader: no tokens to redeem');
      return;
    }

    try {
      const txHash = await redeemPositions(conditionId);
      const estimatedPayout = this._estimateRedeemPayout(resolvedMarket);
      this.redeemedUsdc += estimatedPayout;
      this.pnl.recordRedeem(this.market.slug, estimatedPayout, txHash);
      this.log.info('BeatTrader: redeemed winning position', {
        txHash,
        estimatedPayout,
        upHeld: this.balanceUp,
        downHeld: this.balanceDown,
      });
    } catch (err) {
      this.log.error('BeatTrader: redeem failed', { err: err.message });
    }
  }

  _estimateRedeemPayout(resolvedMarket) {
    const payouts = resolvedMarket?.resolvedPayouts;
    if (Array.isArray(payouts) && payouts.length >= 2) {
      return (this.balanceUp * Number(payouts[0] ?? 0)) + (this.balanceDown * Number(payouts[1] ?? 0));
    }
    return Math.max(this.balanceUp, this.balanceDown);
  }
}
