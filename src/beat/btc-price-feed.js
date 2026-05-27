import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { BTC_PRICE_PRODUCT_ID, BTC_PRICE_WS_URL } from '../config.js';
import logger from '../logger.js';

export class BtcPriceFeed extends EventEmitter {
  constructor({
    url = BTC_PRICE_WS_URL,
    productId = BTC_PRICE_PRODUCT_ID,
  } = {}) {
    super();
    this.url = url;
    this.productId = productId;
    this._ws = null;
    this._closed = false;
    this._reconnectDelayMs = 1_000;
    this._latest = null;
    this._waiters = new Set();
  }

  start() {
    this._closed = false;
    this._connect();
  }

  stop() {
    this._closed = true;
    for (const waiter of this._waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('BTC price feed stopped'));
    }
    this._waiters.clear();
    this._ws?.close();
  }

  getLatest() {
    return this._latest;
  }

  async waitForTickAfter(timestampMs, timeoutMs = 20_000) {
    const latest = this._latest;
    if (latest && latest.timeMs >= timestampMs) return latest;

    return new Promise((resolve, reject) => {
      const waiter = {
        timestampMs,
        resolve: (tick) => {
          clearTimeout(waiter.timeout);
          this._waiters.delete(waiter);
          resolve(tick);
        },
        reject: (err) => {
          clearTimeout(waiter.timeout);
          this._waiters.delete(waiter);
          reject(err);
        },
        timeout: setTimeout(() => {
          waiter.reject(new Error(`Timed out waiting for BTC tick after ${new Date(timestampMs).toISOString()}`));
        }, timeoutMs),
      };
      this._waiters.add(waiter);
    });
  }

  _connect() {
    if (this._closed) return;

    this._ws = new WebSocket(this.url);

    this._ws.on('open', () => {
      this._reconnectDelayMs = 1_000;
      if (!this._isBinanceUrl()) {
        this._ws?.send(JSON.stringify({
          type: 'subscribe',
          product_ids: [this.productId],
          channels: ['ticker', 'heartbeat'],
        }));
      }
      logger.debug('BtcPriceFeed: connected', {
        url: this.url,
        productId: this.productId,
      });
    });

    this._ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleMessage(msg);
      } catch (err) {
        logger.warn('BtcPriceFeed: parse error', { err: err.message });
      }
    });

    this._ws.on('error', (err) => {
      logger.warn('BtcPriceFeed: websocket error', { err: err.message });
      this.emit('error', err);
    });

    this._ws.on('close', () => {
      if (this._closed) return;
      const delayMs = this._reconnectDelayMs;
      this._reconnectDelayMs = Math.min(this._reconnectDelayMs * 2, 30_000);
      logger.warn('BtcPriceFeed: websocket closed, reconnecting', { delayMs });
      setTimeout(() => this._connect(), delayMs);
    });
  }

  _handleMessage(msg) {
    if (this._isBinanceUrl()) {
      const price = Number(msg.c);
      const bestBid = Number(msg.b);
      const bestAsk = Number(msg.a);
      const timeMs = Number(msg.E ?? msg.T ?? Date.now());
      const tick = {
        price,
        bestBid,
        bestAsk,
        productId: this.productId,
        timeMs,
        isoTime: new Date(timeMs).toISOString(),
      };
      if (!Number.isFinite(tick.price) || !Number.isFinite(tick.timeMs)) return;
      this._latest = tick;
      this.emit('tick', tick);
      for (const waiter of [...this._waiters]) {
        if (tick.timeMs >= waiter.timestampMs) {
          waiter.resolve(tick);
        }
      }
      return;
    }

    if (msg.type !== 'ticker' || msg.product_id !== this.productId) return;

    const tick = {
      price: Number(msg.price),
      bestBid: Number(msg.best_bid),
      bestAsk: Number(msg.best_ask),
      sequence: Number(msg.sequence),
      productId: msg.product_id,
      timeMs: Date.parse(msg.time),
      isoTime: msg.time,
    };

    if (!Number.isFinite(tick.price) || !Number.isFinite(tick.timeMs)) return;

    this._latest = tick;
    this.emit('tick', tick);

    for (const waiter of [...this._waiters]) {
      if (tick.timeMs >= waiter.timestampMs) {
        waiter.resolve(tick);
      }
    }
  }

  _isBinanceUrl() {
    return /binance/i.test(this.url);
  }
}
