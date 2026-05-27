/**
 * trader.js
 * Per-market state machine implementing the 9 trading rules
 * reverse-engineered from wallet 0xcfb103c37c0234f524c632d964ed31f117b5f694.
 *
 * Rules recap:
 *  RULE 0 – universe filter (checked before constructing Trader)
 *  RULE 1 – enter within 10s of window open; stop 15s before close
 *  RULE 2 – post dual-sided limit ladder on both Up and Down at window open
 *  RULE 3 – take aggressively when combined ask < (1 - TARGET_EDGE)
 *  RULE 4 – merge matched pairs within ~10s of holding them
 *  RULE 5 – NEVER post a sell order
 *  RULE 6 – cancel all orders at t=300 (window close)
 *  RULE 7 – redeem winning tokens at t≈600 (oracle resolution)
 *  RULE 8 – three circuit breakers
 *  RULE 9 – per-market capital cap
 */
import {
  LADDER_LEVELS,
  LADDER_SIZE_PER_LEVEL,
  TARGET_EDGE,
  MERGE_THRESHOLD_USDC,
  MAX_TAKER_FILL_USDC,
  MAX_SPEND_PER_MARKET,
  MAX_INVENTORY_IMBALANCE,
  COMBINED_ASK_STOP,
  MARKET_WINDOW_SECONDS,
  STOP_BUYING_BEFORE_CLOSE,
  REDEEM_DELAY_AFTER_CLOSE,
  BOOK_POLL_MS,
  HEARTBEAT_INTERVAL_MS,
} from './config.js';
import { ClobClient, BookFeed } from './clob.js';
import { mergePositions, redeemPositions, getTokenBalances, sleep } from './onchain.js';
import { waitForResolution, msUntil } from './market.js';
import { marketLogger } from './logger.js';

const PHASE = {
  INIT:       'INIT',
  LIVE:       'LIVE',
  CLOSING:    'CLOSING',
  CANCELLED:  'CANCELLED',
  RESOLVING:  'RESOLVING',
  DONE:       'DONE',
  HALTED:     'HALTED',
};

export class Trader {
  constructor(market, wallet, pnl) {
    this.market   = market;
    this.wallet   = wallet;
    this.pnl      = pnl;
    this.log      = marketLogger(market.slug);

    this.balanceUp   = 0;
    this.balanceDown = 0;

    this.totalSpent   = 0;
    this.mergedUsdc   = 0;
    this.redeemedUsdc = 0;

    this.openOrders = new Map();
    this.phase = PHASE.INIT;
    this.halted = false;
    this._feed = null;
    this._bestAskUp = null;
    this._bestAskDown = null;
    this._merging = false;
    this._heartbeatTimer = null;
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    const tick = () => {
      ClobClient.sendHeartbeat().catch((err) => {
        this.log.warn('Trader: CLOB heartbeat failed', { err: err.message });
      });
    };
    tick();
    this._heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  async run() {
    const { windowTs, conditionId, upToken, downToken } = this.market;
    const windowClose = windowTs + MARKET_WINDOW_SECONDS;

    this.log.info('Trader: starting', {
      conditionId,
      upTokenId:   upToken.tokenId,
      downTokenId: downToken.tokenId,
      windowOpen:  new Date(windowTs * 1000).toISOString(),
      windowClose: new Date(windowClose * 1000).toISOString(),
    });

    const waitMs = msUntil(windowTs) + 1000;
    if (waitMs > 0) {
      this.log.debug('Trader: waiting for window open', { waitMs: Math.round(waitMs) });
      await sleep(waitMs);
    }

    this.phase = PHASE.LIVE;
    this._startFeed([upToken.tokenId, downToken.tokenId]);

    try {
      await this._postLadder(upToken.tokenId, downToken.tokenId);
      this._startHeartbeat();
      await this._arbLoop(windowClose, conditionId, upToken.tokenId, downToken.tokenId);

      this.phase = PHASE.CANCELLED;
      this._stopHeartbeat();
      await this._cancelAllOrders(conditionId);
    } finally {
      this._stopHeartbeat();
      this._feed?.stop();
    }

    await this._tryMerge(conditionId, { force: true });

    this.phase = PHASE.RESOLVING;
    await this._redeemPhase(conditionId, windowClose);

    this.phase = PHASE.DONE;
    this.log.info('Trader: market complete', {
      totalSpent: this.totalSpent.toFixed(4),
      mergedUsdc: this.mergedUsdc.toFixed(4),
      redeemedUsdc: this.redeemedUsdc.toFixed(4),
      netPnl: (this.mergedUsdc + this.redeemedUsdc - this.totalSpent).toFixed(4),
    });
  }

  async _postLadder(upTokenId, downTokenId) {
    this.log.info('Trader: posting ladder', { levels: LADDER_LEVELS.length });
    const posts = [];
    for (const price of LADDER_LEVELS) {
      const shares = LADDER_SIZE_PER_LEVEL / price;
      posts.push(this._safeLimitBuy(upTokenId, price, shares));
      posts.push(this._safeLimitBuy(downTokenId, price, shares));
    }
    await Promise.allSettled(posts);
    this.log.info('Trader: ladder posted');
  }

  async _arbLoop(windowClose, conditionId, upTokenId, downTokenId) {
    while (true) {
      const now = Math.floor(Date.now() / 1000);
      if (now >= windowClose - STOP_BUYING_BEFORE_CLOSE) {
        this.log.info('Trader: approaching window close, stopping buys');
        break;
      }

      if (this._checkCircuitBreakers()) break;
      await this._tryArb(upTokenId, downTokenId);
      await this._tryMerge(conditionId);

      if (now % 30 === 0) {
        await this._syncBalances(upTokenId, downTokenId);
      }

      await sleep(BOOK_POLL_MS);
    }
  }

  async _tryArb(upTokenId, downTokenId) {
    const upAsk = this._bestAskUp;
    const downAsk = this._bestAskDown;
    if (!upAsk || !downAsk) return;

    const combined = upAsk.price + downAsk.price;
    if (combined > COMBINED_ASK_STOP) {
      this.log.warn('Trader: RULE-8 combined ask stop triggered', { combined });
      this.halted = true;
      return;
    }

    if (combined >= 1 - TARGET_EDGE) return;

    const remainingBudget = MAX_SPEND_PER_MARKET - this.totalSpent;
    if (remainingBudget < 1) return;

    const maxShares = Math.min(
      upAsk.size,
      downAsk.size,
      MAX_TAKER_FILL_USDC / combined,
      remainingBudget / combined,
    );

    if (maxShares < 1) return;

    this.log.info('Trader: RULE-3 arb triggered', {
      upPrice: upAsk.price,
      downPrice: downAsk.price,
      combined: combined.toFixed(4),
      edge: (1 - combined).toFixed(4),
      shares: maxShares.toFixed(2),
    });

    const upSpendUsdc = maxShares * upAsk.price;
    const downSpendUsdc = maxShares * downAsk.price;
    const [upRes, downRes] = await Promise.allSettled([
      ClobClient.postFOKBuy(this.wallet, upTokenId, upAsk.price, upSpendUsdc),
      ClobClient.postFOKBuy(this.wallet, downTokenId, downAsk.price, downSpendUsdc),
    ]);

    if (upRes.status === 'fulfilled' && downRes.status === 'fulfilled') {
      const spentUp = maxShares * upAsk.price;
      const spentDown = maxShares * downAsk.price;
      this.totalSpent += spentUp + spentDown;
      this.balanceUp += maxShares;
      this.balanceDown += maxShares;
      this.pnl.recordBuy(this.market.slug, 'Up', upAsk.price, maxShares);
      this.pnl.recordBuy(this.market.slug, 'Down', downAsk.price, maxShares);
    } else {
      this.log.warn('Trader: arb leg partially failed', {
        upStatus: upRes.status,
        downStatus: downRes.status,
      });
      await this._syncBalances(upTokenId, downTokenId);
    }
  }

  async _tryMerge(conditionId, { force = false } = {}) {
    if (this._merging) return;
    const pairs = Math.min(this.balanceUp, this.balanceDown);
    if (pairs < MERGE_THRESHOLD_USDC && !force) return;
    if (pairs < 0.001) return;

    this._merging = true;
    try {
      this.log.info('Trader: RULE-4 merging pairs', { pairs: pairs.toFixed(4) });
      const txHash = await mergePositions(conditionId, pairs);
      this.balanceUp -= pairs;
      this.balanceDown -= pairs;
      this.mergedUsdc += pairs;
      this.pnl.recordMerge(this.market.slug, pairs);

      this.log.info('Trader: merge done', {
        pairs: pairs.toFixed(4),
        mergedTotal: this.mergedUsdc.toFixed(4),
        tx: txHash,
      });
    } catch (err) {
      this.log.error('Trader: merge failed', { err: err.message });
    } finally {
      this._merging = false;
    }
  }

  async _redeemPhase(conditionId, windowClose) {
    const redeemNotBefore = (windowClose + REDEEM_DELAY_AFTER_CLOSE) * 1000;
    const waitForRedeemMs = redeemNotBefore - Date.now();
    if (waitForRedeemMs > 0) {
      this.log.debug('Trader: waiting for oracle resolution…', { waitSec: Math.round(waitForRedeemMs / 1000) });
      await sleep(waitForRedeemMs);
    }

    try {
      await waitForResolution(this.market.slug, 400_000, 10_000);
    } catch (err) {
      this.log.warn('Trader: resolution poll timed out, attempting redeem anyway', { err: err.message });
    }

    const totalHeld = this.balanceUp + this.balanceDown;
    if (totalHeld < 0.001) {
      this.log.info('Trader: no tokens to redeem');
      return;
    }

    try {
      this.log.info('Trader: RULE-7 redeeming positions', {
        upHeld: this.balanceUp.toFixed(4),
        downHeld: this.balanceDown.toFixed(4),
      });
      const txHash = await redeemPositions(conditionId);
      const estimatedPayout = Math.max(this.balanceUp, this.balanceDown);
      this.redeemedUsdc += estimatedPayout;
      this.pnl.recordRedeem(this.market.slug, estimatedPayout, txHash);
    } catch (err) {
      this.log.error('Trader: redeem failed', { err: err.message });
    }
  }

  async _cancelAllOrders(conditionId) {
    this.log.info('Trader: RULE-6 cancelling all open orders');
    try {
      await ClobClient.cancelMarket(conditionId);
      this.openOrders.clear();
    } catch (err) {
      this.log.warn('Trader: cancelMarket failed, trying global cancel', { err: err.message });
      try {
        await ClobClient.cancelAll();
        this.openOrders.clear();
      } catch (err2) {
        this.log.error('Trader: cancelAll also failed', { err: err2.message });
      }
    }
  }

  _checkCircuitBreakers() {
    if (this.halted) return true;

    const imbalanceUsdc = Math.abs(this.balanceUp - this.balanceDown);
    if (imbalanceUsdc > MAX_INVENTORY_IMBALANCE) {
      this.log.warn('Trader: RULE-8 inventory imbalance circuit breaker', {
        imbalanceUsdc: imbalanceUsdc.toFixed(2),
        balanceUp: this.balanceUp.toFixed(4),
        balanceDown: this.balanceDown.toFixed(4),
      });
      if (imbalanceUsdc > MAX_INVENTORY_IMBALANCE * 2) {
        this.halted = true;
        return true;
      }
    }

    if (this.totalSpent >= MAX_SPEND_PER_MARKET) {
      this.log.info('Trader: RULE-9 spend cap reached', { totalSpent: this.totalSpent.toFixed(2) });
      this.halted = true;
      return true;
    }

    return false;
  }

  _startFeed(tokenIds) {
    this._feed = new BookFeed(tokenIds);
    this._feed.on('update', ({ tokenId, bestAsk }) => {
      if (tokenId === this.market.upToken.tokenId) {
        this._bestAskUp = bestAsk;
      } else if (tokenId === this.market.downToken.tokenId) {
        this._bestAskDown = bestAsk;
      }
    });
    this._feed.on('error', (err) => {
      this.log.warn('Trader: BookFeed error', { err: err.message });
    });
    this._feed.start();
  }

  async _safeLimitBuy(tokenId, price, shares) {
    const cost = price * shares;
    if (this.totalSpent + cost > MAX_SPEND_PER_MARKET) return;

    try {
      const orderId = await ClobClient.postLimitBuy(this.wallet, tokenId, price, shares);
      this.openOrders.set(orderId, { tokenId, price, shares });
    } catch (err) {
      this.log.warn('Trader: limit buy failed', { tokenId, price, shares, err: err.message });
    }
  }

  async _syncBalances(upTokenId, downTokenId) {
    try {
      const bals = await getTokenBalances([upTokenId, downTokenId]);
      this.balanceUp = bals[upTokenId] ?? this.balanceUp;
      this.balanceDown = bals[downTokenId] ?? this.balanceDown;
      this.log.debug('Trader: balances synced', {
        up: this.balanceUp.toFixed(4),
        down: this.balanceDown.toFixed(4),
      });
    } catch (err) {
      this.log.warn('Trader: balance sync failed', { err: err.message });
    }
  }
}
