/**
 * beat/fill-feed.js
 * ───────────────────────────────────────────────────────────────────────────
 * 우리 지갑(FUNDER_ADDRESS)의 체결을 Polygon 온체인 OrderFilled 이벤트로 직접
 * 추적한다. 목적: 라이브 매수의 "실제 체결 결과(shares/usdc)"를 API 폴링 없이
 * 가능한 한 빨리 확보하는 것.
 *
 * 이 전략의 모든 매수는 FAK/FOK 마켓(테이커) 주문이므로, 우리는 항상 OrderFilled
 * 이벤트의 taker(=topics[3]) 로 나타난다. 테이커-매수 한 건의 매핑은 v1/v2 공통:
 *   - tokenId  = 매도자(maker)가 판 토큰 (decoded.tokenId, maker가 SELL일 때)
 *   - shares   = makerAmountFilled / 1e6   (maker가 우리에게 넘긴 토큰 수량)
 *   - usdc     = takerAmountFilled / 1e6   (우리가 maker에게 지불한 USDC)
 * (copy/exchangeContracts.decodeOrderFilledLog 의 maker 관점 isBuy=false 가 곧
 *  우리의 테이커-매수를 의미한다.)
 *
 * 토큰별 누적 확정 체결(shares/usdc)을 보관하고, 증가분을 기다리는 헬퍼를 제공한다.
 * BeatTrader 는 매수 직전 base 를 스냅샷하고, 매수 후 (API 파싱 vs 온체인 증가분)
 * 중 먼저 도착한 값을 사용한다. 워터마크로 중복 계상을 방지한다.
 */
import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { FUNDER_ADDRESS, POLYGON_WS_RPC, USDC_SCALE } from '../config.js';
import logger from '../logger.js';
import {
  WATCHED_EXCHANGES,
  decodeOrderFilledLog,
  makerTopic,
} from '../copy/exchangeContracts.js';

const WATCHDOG_INTERVAL_MS = 30_000;
const INITIAL_BLOCK_TIMEOUT_MS = 20_000;
const MAX_BLOCK_SILENCE_MS = 90_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

function lower(addr) {
  return typeof addr === 'string' ? addr.toLowerCase() : '';
}

export class BeatFillFeed extends EventEmitter {
  /**
   * @param {string[]} tokenIds  관심 토큰(현재 마켓들의 up/down). 비우면 전체 허용.
   */
  constructor(tokenIds = []) {
    super();
    this.funder = lower(FUNDER_ADDRESS);
    this._tokenIds = new Set(tokenIds.map(String).filter(Boolean));
    this._provider = null;
    this._filters = [];
    this._socketListeners = [];
    this._blockListener = null;
    this._seenLogs = new Set();
    this._stopped = true;
    this._connecting = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._destroyTimer = null;
    this._watchdogTimer = null;
    this._lastBlockAt = 0;
    this._connectedAt = 0;
    // 토큰별 누적 확정 체결.
    this._cumShares = new Map();   // tokenId -> shares
    this._cumUsdc = new Map();     // tokenId -> usdc
    this.active = false;
  }

  /** 마켓이 추가될 때 관심 토큰을 등록한다(전역 단일 피드 재사용 시). */
  trackTokens(tokenIds = []) {
    for (const id of tokenIds) {
      const s = String(id);
      if (s) this._tokenIds.add(s);
    }
  }

  cumulativeShares(tokenId) {
    return Number(this._cumShares.get(String(tokenId)) ?? 0);
  }

  cumulativeUsdc(tokenId) {
    return Number(this._cumUsdc.get(String(tokenId)) ?? 0);
  }

  async start() {
    if (!POLYGON_WS_RPC) {
      logger.warn('BeatFillFeed: POLYGON_WS_RPC not set, on-chain fill feed disabled');
      return false;
    }
    if (!this.funder) {
      logger.warn('BeatFillFeed: FUNDER_ADDRESS not set, on-chain fill feed disabled');
      return false;
    }
    this._stopped = false;
    await this._connect();
    this._startWatchdog();
    this.active = true;
    return true;
  }

  stop() {
    this._stopped = true;
    this.active = false;
    if (this._destroyTimer) { clearTimeout(this._destroyTimer); this._destroyTimer = null; }
    if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
    this._clearReconnectTimer();
    this._teardownProvider(this._provider);
    this._provider = null;
    this._filters = [];
    this._blockListener = null;
    this._socketListeners = [];
    this._connectedAt = 0;
    this._lastBlockAt = 0;
    this._connecting = false;
  }

  async _connect() {
    if (this._stopped || this._connecting) return;
    this._connecting = true;
    this._clearReconnectTimer();

    const provider = new ethers.WebSocketProvider(POLYGON_WS_RPC);
    this._provider = provider;
    const takerTopic = makerTopic(this.funder); // zero-padded address (topics[3] = taker)

    for (const exchange of WATCHED_EXCHANGES) {
      // topics: [OrderFilled, orderHash(any), maker(any), taker=us]
      const filter = {
        address: exchange.address,
        topics: [exchange.orderFilledTopic, null, null, takerTopic],
      };
      const listener = (log) => {
        this._lastBlockAt = Date.now();
        try {
          this._handleLog(exchange, log);
        } catch (err) {
          logger.debug('BeatFillFeed: log handle error', { err: err.message });
        }
      };
      provider.on(filter, listener);
      this._filters.push({ filter, listener });
    }

    this._blockListener = () => { this._lastBlockAt = Date.now(); };
    provider.on('block', this._blockListener);
    await provider.getBlockNumber();
    this._connectedAt = Date.now();
    this._lastBlockAt = 0;
    this._attachSocketListeners(provider);
    this._reconnectAttempts = 0;
    this._connecting = false;

    logger.info('BeatFillFeed: listening for our on-chain fills', {
      funder: this.funder,
      exchanges: WATCHED_EXCHANGES.map((e) => e.key),
    });
  }

  _handleLog(exchange, log) {
    if (this._stopped) return;
    const dedupKey = `${log.transactionHash}:${log.index ?? log.logIndex ?? 0}`;
    if (this._seenLogs.has(dedupKey)) return;
    this._seenLogs.add(dedupKey);
    if (this._seenLogs.size > 10_000) {
      this._seenLogs = new Set([...this._seenLogs].slice(-5_000));
    }

    const decoded = decodeOrderFilledLog(exchange, log);
    // 우리는 taker. maker 관점 isBuy=false(=maker SELL) 이어야 우리의 매수.
    if (decoded.isBuy) return;          // maker가 BUY → 우리는 SELL(이 전략엔 없음)
    if (lower(decoded.taker) !== this.funder) return;

    const tokenId = String(decoded.tokenId);
    if (this._tokenIds.size && !this._tokenIds.has(tokenId)) return;

    const shares = Number(decoded.makerAmountFilled) / USDC_SCALE; // maker가 넘긴 토큰
    const usdc = Number(decoded.takerAmountFilled) / USDC_SCALE;   // 우리가 지불한 USDC
    if (!Number.isFinite(shares) || !Number.isFinite(usdc) || shares <= 0 || usdc <= 0) return;

    this._cumShares.set(tokenId, this.cumulativeShares(tokenId) + shares);
    this._cumUsdc.set(tokenId, this.cumulativeUsdc(tokenId) + usdc);

    logger.debug('BeatFillFeed: confirmed on-chain fill', {
      tokenId, shares, usdc, txHash: log.transactionHash,
      cumShares: this.cumulativeShares(tokenId),
    });
    this.emit('fill', {
      tokenId,
      shares,
      usdc,
      txHash: lower(log.transactionHash),
      cumulativeShares: this.cumulativeShares(tokenId),
      cumulativeUsdc: this.cumulativeUsdc(tokenId),
    });
  }

  /**
   * tokenId 누적 확정 체결이 baseShares 를 초과할 때까지 대기.
   * 초과분(delta)을 { shares, usdc, source:'chain' } 으로 반환. timeout 시 null.
   */
  waitForIncrease(tokenId, baseShares, baseUsdc, timeoutMs = 4_000) {
    const id = String(tokenId);
    const already = this.cumulativeShares(id);
    if (already > baseShares + 1e-9) {
      return Promise.resolve({
        shares: already - baseShares,
        spentUsdc: this.cumulativeUsdc(id) - baseUsdc,
        source: 'chain',
      });
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        this.off('fill', onFill);
        clearTimeout(timer);
        resolve(val);
      };
      const onFill = (f) => {
        if (String(f.tokenId) !== id) return;
        if (f.cumulativeShares > baseShares + 1e-9) {
          finish({
            shares: f.cumulativeShares - baseShares,
            spentUsdc: f.cumulativeUsdc - baseUsdc,
            source: 'chain',
          });
        }
      };
      const timer = setTimeout(() => finish(null), Math.max(250, timeoutMs));
      timer.unref?.();
      this.on('fill', onFill);
    });
  }

  _startWatchdog() {
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    this._watchdogTimer = setInterval(() => {
      if (this._stopped || !this._provider || !this._connectedAt) return;
      const hasSeenBlock = this._lastBlockAt > 0;
      const reference = hasSeenBlock ? this._lastBlockAt : this._connectedAt;
      const allowed = hasSeenBlock ? MAX_BLOCK_SILENCE_MS : INITIAL_BLOCK_TIMEOUT_MS;
      if (Date.now() - reference <= allowed) return;
      logger.warn('BeatFillFeed: chain feed stalled, reconnecting');
      this._scheduleReconnect('stalled');
    }, WATCHDOG_INTERVAL_MS);
    this._watchdogTimer.unref?.();
  }

  _attachSocketListeners(provider) {
    try {
      const socket = provider.websocket;
      if (!socket) return;
      const onClose = () => this._scheduleReconnect('socket-close');
      const onError = () => this._scheduleReconnect('socket-error');
      if (typeof socket.on === 'function') {
        socket.on('close', onClose);
        socket.on('error', onError);
        this._socketListeners.push(['close', onClose], ['error', onError]);
      } else if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('close', onClose);
        socket.addEventListener('error', onError);
        this._socketListeners.push(['close', onClose], ['error', onError]);
      }
    } catch {
      // rely on watchdog
    }
  }

  _scheduleReconnect(reason) {
    if (this._stopped || this._reconnectTimer || this._connecting) return;
    const current = this._provider;
    this._provider = null;
    this._teardownProvider(current);
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** Math.min(this._reconnectAttempts, 4)));
    this._reconnectAttempts += 1;
    logger.info('BeatFillFeed: scheduling reconnect', { reason, delay, attempt: this._reconnectAttempts });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      void this._connect().catch((err) => {
        this._connecting = false;
        logger.warn('BeatFillFeed: reconnect failed', { err: err.message });
        this._scheduleReconnect('reconnect-failed');
      });
    }, delay);
    this._reconnectTimer.unref?.();
  }

  _clearReconnectTimer() {
    if (!this._reconnectTimer) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  _teardownProvider(provider) {
    if (!provider) return;
    for (const { filter, listener } of this._filters) {
      try { provider.off(filter, listener); } catch { /* ignore */ }
    }
    this._filters = [];
    if (this._blockListener) {
      try { provider.off('block', this._blockListener); } catch { /* ignore */ }
    }
    try {
      const socket = provider.websocket;
      for (const [evt, handler] of this._socketListeners) {
        if (typeof socket?.off === 'function') socket.off(evt, handler);
        else if (typeof socket?.removeEventListener === 'function') socket.removeEventListener(evt, handler);
      }
    } catch { /* ignore */ }
    this._socketListeners = [];
    if (this._destroyTimer) { clearTimeout(this._destroyTimer); this._destroyTimer = null; }
    this._destroyTimer = setTimeout(() => {
      this._destroyTimer = null;
      void provider.destroy().catch(() => {});
    }, 1_000);
    this._destroyTimer.unref?.();
  }
}
