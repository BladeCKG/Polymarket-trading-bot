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
  // ... (rest of the class unchanged, omitted for brevity)
}
