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
  }

  async start() {
    if (!POLYGON_WS_RPC) {
      throw new Error('ChainActivityFeed requires POLYGON_WS_RPC to be set');
    }
    if (!this.targets.length) {
      throw new Error('ChainActivityFeed requires at least one target wallet');
    }

    this._provider = new ethers.WebSocketProvider(POLYGON_WS_RPC);
    const targetTopics = this.targets.map(makerTopic);

    for (const exchange of WATCHED_EXCHANGES) {
      const filter = {
        address: exchange.address,
        topics: [exchange.orderFilledTopic, null, targetTopics],
      };
      const listener = (log) => {
        void this._handleLog(exchange, log);
      };
      this._provider.on(filter, listener);
      this._filters.push({ filter, listener });
    }

    logger.info('copy.ChainActivityFeed: listening for on-chain fills', {
      targets: this.targets,
      exchanges: WATCHED_EXCHANGES.map((exchange) => ({
        key: exchange.key,
        address: exchange.address,
      })),
    });
  }

  stop() {
    this._stopped = true;
    const provider = this._provider;
    this._provider = null;
    if (this._destroyTimer) {
      clearTimeout(this._destroyTimer);
      this._destroyTimer = null;
    }

    if (provider) {
      for (const { filter, listener } of this._filters) {
        provider.off(filter, listener);
      }

      try {
        const socket = provider.websocket;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = () => {};
        socket.onclose = () => {};
      } catch {
        // Ignore cases where the websocket is already closed or unavailable.
      }
      this._destroyTimer = setTimeout(() => {
        this._destroyTimer = null;
        void provider.destroy().catch((err) => {
          logger.debug('copy.ChainActivityFeed: provider destroy error', { err: err.message });
        });
      }, 1_000);
      this._destroyTimer.unref?.();
    }
    this._filters = [];
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
      if (!Number.isFinite(size) || !Number.isFinite(usdc) || size <= 0 || usdc <= 0) return;

      this.emit('trade', {
        source: 'chain',
        target: normaliseAddress(decoded.maker),
        tokenId: decoded.tokenId,
        conditionId: market.conditionId?.toLowerCase?.() ?? '',
        side: 'BUY',
        price: usdc / size,
        size,
        usdc,
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
          log,
          decoded,
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
}
