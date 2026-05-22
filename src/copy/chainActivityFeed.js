/**
 * copy/chainActivityFeed.js
 * Real-time copy-trade signal feed sourced directly from Polygon exchange logs.
 *
 * This is an alternative to the public REST poller. It listens for Polymarket
 * OrderFilled events on the official exchange contracts, filters for target
 * maker wallets, and normalizes BUY fills into the same shape expected by
 * CopyTrader.
 *
 * Freshness note:
 * We intentionally use the local log receive time as the event timestamp in
 * chain mode. That avoids an extra `getBlock()` RPC call for every new fill,
 * which keeps the feed lightweight and scalable. In practice this is what we
 * care about for copy trading: how fresh the signal was when *we* received it.
 */
import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { POLYGON_WS_RPC, USDC_SCALE } from '../config.js';
import { fetchMarketByTokenId } from '../market.js';
import logger from '../logger.js';
import {
  WATCHED_EXCHANGES,
  decodeOrderFilledLog,
  makerTopic,
} from './exchangeContracts.js';

function normaliseAddress(address) {
  return typeof address === 'string' ? address.toLowerCase() : '';
}

function trimCache(map, maxSize) {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

const WATCHDOG_INTERVAL_MS = 30_000;
const INITIAL_BLOCK_TIMEOUT_MS = 20_000;
const MAX_BLOCK_SILENCE_MS = 90_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

export class ChainActivityFeed extends EventEmitter {
  constructor(targets) {
    super();
    this.targets = [...new Set(targets.map(normaliseAddress).filter(Boolean))];
    this._provider = null;
    this._filters = [];
    this._seenLogs = new Set();
    this._marketCache = new Map();
    this._stopped = false;
    this._destroyTimer = null;
    this._watchdogTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._lastBlockAt = 0;
    this._connectedAt = 0;
    this._connecting = false;
    this._socketListeners = [];
    this._blockListener = null;
  }

  async start() {
    if (!POLYGON_WS_RPC) {
      throw new Error('ChainActivityFeed requires POLYGON_WS_RPC to be set');
    }
    if (!this.targets.length) {
      throw new Error('ChainActivityFeed requires at least one target wallet');
    }

    this._stopped = false;
    await this._connect();
    this._startWatchdog();
  }

  async _connect() {
    if (this._stopped || this._connecting) return;
    this._connecting = true;
    this._clearReconnectTimer();

    const provider = new ethers.WebSocketProvider(POLYGON_WS_RPC);
    this._provider = provider;
    const targetTopics = this.targets.map(makerTopic);

    for (const exchange of WATCHED_EXCHANGES) {
      const filter = {
        address: exchange.address,
        topics: [exchange.orderFilledTopic, null, targetTopics],
      };
      const listener = (log) => {
        this._lastBlockAt = Date.now();
        void this._handleLog(exchange, log);
      };
      provider.on(filter, listener);
      this._filters.push({ filter, listener });
    }

    this._blockListener = () => {
      this._lastBlockAt = Date.now();
    };
    provider.on('block', this._blockListener);
    const blockNumber = await provider.getBlockNumber();
    this._connectedAt = Date.now();
    this._lastBlockAt = 0;
    this._attachSocketListeners(provider);
    this._reconnectAttempts = 0;
    this._connecting = false;

    logger.info('copy.ChainActivityFeed: listening for on-chain fills', {
      blockNumber,
      targets: this.targets,
      exchanges: WATCHED_EXCHANGES.map((exchange) => ({
        key: exchange.key,
        address: exchange.address,
      })),
    });
  }

  stop() {
    this._stopped = true;
    if (this._destroyTimer) {
      clearTimeout(this._destroyTimer);
      this._destroyTimer = null;
    }
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
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

  async _handleLog(exchange, log) {
    if (this._stopped) return;

    const dedupKey = `${log.transactionHash}:${log.index ?? log.logIndex ?? 0}`;
    if (this._seenLogs.has(dedupKey)) return;
    this._seenLogs.add(dedupKey);
    if (this._seenLogs.size > 10_000) {
      const values = [...this._seenLogs];
      this._seenLogs = new Set(values.slice(-5_000));
    }

    try {
      const receivedAt = Date.now();
      const decoded = decodeOrderFilledLog(exchange, log);
      if (!decoded.isBuy) return;

      const market = await this._lookupMarket(decoded.tokenId);
      const timestamp = Math.floor(receivedAt / 1000);
      const ageMs = Math.max(0, Date.now() - receivedAt);
      const token = market.tokens?.find((entry) => String(entry.tokenId) === String(decoded.tokenId)) ?? null;
      const size = Number(decoded.takerAmountFilled) / USDC_SCALE;
      const usdc = Number(decoded.makerAmountFilled) / USDC_SCALE;
      const feeAmount = Number(decoded.fee) / USDC_SCALE;
      const price = usdc / size;
      if (!Number.isFinite(size) || !Number.isFinite(usdc) || size <= 0 || usdc <= 0) return;
      const feeValueUsdc = Number.isFinite(feeAmount) && feeAmount >= 0
        ? feeAmount * price
        : null;

      this.emit('trade', {
        source: 'chain',
        target: normaliseAddress(decoded.maker),
        tokenId: decoded.tokenId,
        conditionId: market.conditionId?.toLowerCase?.() ?? '',
        side: 'BUY',
        price,
        size,
        usdc,
        feeAmount: Number.isFinite(feeAmount) ? feeAmount : null,
        feeUnit: 'SHARES',
        feeValueUsdc,
        feeSource: 'chain-exact',
        timestamp,
        ageMs,
        txHash: normaliseAddress(log.transactionHash),
        slug: market.slug ?? null,
        question: market.question ?? null,
        outcome: token?.outcome ?? null,
        chain: {
          exchange: decoded.exchange,
          exchangeVersion: decoded.exchangeVersion,
          exchangeAddress: decoded.exchangeAddress,
          blockNumber: log.blockNumber,
          logIndex: log.index ?? log.logIndex ?? null,
          receivedAt,
        },
        raw: {
          log: jsonSafe(log),
          decoded: jsonSafe(decoded),
        },
      });
    } catch (err) {
      logger.warn('copy.ChainActivityFeed: decode error', {
        err: err.message,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      });
    }
  }

  async _lookupMarket(tokenId) {
    if (this._marketCache.has(tokenId)) return this._marketCache.get(tokenId);

    const pending = fetchMarketByTokenId(tokenId)
      .then((market) => {
        this._marketCache.set(tokenId, market);
        trimCache(this._marketCache, 1_000);
        return market;
      })
      .catch((err) => {
        this._marketCache.delete(tokenId);
        throw err;
      });

    this._marketCache.set(tokenId, pending);
    return pending;
  }

  _startWatchdog() {
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    this._watchdogTimer = setInterval(() => {
      if (this._stopped || !this._provider || !this._connectedAt) return;
      const hasSeenBlock = this._lastBlockAt > 0;
      const referenceAt = hasSeenBlock ? this._lastBlockAt : this._connectedAt;
      const allowedSilenceMs = hasSeenBlock ? MAX_BLOCK_SILENCE_MS : INITIAL_BLOCK_TIMEOUT_MS;
      const silenceMs = Date.now() - referenceAt;
      if (silenceMs <= allowedSilenceMs) return;

      logger.warn('copy.ChainActivityFeed: chain feed stalled, reconnecting', {
        phase: hasSeenBlock ? 'steady-state' : 'startup',
        silenceMs,
        allowedSilenceMs,
      });
      this._scheduleReconnect(hasSeenBlock ? 'block-heartbeat-stalled' : 'startup-no-blocks');
    }, WATCHDOG_INTERVAL_MS);
    this._watchdogTimer.unref?.();
  }

  _attachSocketListeners(provider) {
    try {
      const socket = provider.websocket;
      if (!socket) return;

      const onClose = (event) => {
        const code = typeof event === 'number' ? event : event?.code;
        const reason = typeof event === 'string' ? event : event?.reason;
        logger.warn('copy.ChainActivityFeed: websocket closed', { code, reason });
        this._scheduleReconnect('socket-close');
      };
      const onError = (err) => {
        logger.warn('copy.ChainActivityFeed: websocket error', {
          err: err?.message ?? String(err),
        });
        this._scheduleReconnect('socket-error');
      };

      if (typeof socket.on === 'function') {
        socket.on('close', onClose);
        socket.on('error', onError);
        this._socketListeners.push(['close', onClose], ['error', onError]);
        return;
      }
      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('close', onClose);
        socket.addEventListener('error', onError);
        this._socketListeners.push(['close', onClose], ['error', onError]);
      }
    } catch {
      // Ignore websocket listener attachment issues and rely on the watchdog.
    }
  }

  _scheduleReconnect(reason) {
    if (this._stopped || this._reconnectTimer || this._connecting) return;
    const currentProvider = this._provider;
    this._provider = null;
    this._teardownProvider(currentProvider);

    const delayMs = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * (2 ** Math.min(this._reconnectAttempts, 4)),
    );
    this._reconnectAttempts += 1;

    logger.info('copy.ChainActivityFeed: scheduling reconnect', {
      reason,
      delayMs,
      attempt: this._reconnectAttempts,
    });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      void this._connect().catch((err) => {
        this._connecting = false;
        logger.warn('copy.ChainActivityFeed: reconnect failed', {
          err: err.message,
          attempt: this._reconnectAttempts,
        });
        this._scheduleReconnect('reconnect-failed');
      });
    }, delayMs);
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
      provider.off(filter, listener);
    }
    this._filters = [];

    if (this._blockListener) {
      provider.off('block', this._blockListener);
    }

    try {
      const socket = provider.websocket;
      for (const [eventName, handler] of this._socketListeners) {
        if (typeof socket?.off === 'function') {
          socket.off(eventName, handler);
        } else if (typeof socket?.removeEventListener === 'function') {
          socket.removeEventListener(eventName, handler);
        }
      }
    } catch {
      // Ignore listener removal issues on a stale websocket.
    }
    this._socketListeners = [];

    if (this._destroyTimer) {
      clearTimeout(this._destroyTimer);
      this._destroyTimer = null;
    }
    this._destroyTimer = setTimeout(() => {
      this._destroyTimer = null;
      void provider.destroy().catch((err) => {
        logger.debug('copy.ChainActivityFeed: provider destroy error', { err: err.message });
      });
    }, 1_000);
    this._destroyTimer.unref?.();
  }
}
