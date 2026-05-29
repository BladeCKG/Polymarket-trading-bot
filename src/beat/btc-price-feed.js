import axios from 'axios';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  BTC_PRICE_STALL_RECONNECT_MS,
} from '../config.js';
import logger from '../logger.js';

const PING_INTERVAL_MS = 5_000;

function defaultFeedConfigFor(productId = 'btcusdt', source = 'rtds') {
  const raw = String(productId ?? 'btcusdt').trim();
  const symbol = raw.toUpperCase().includes('-')
    ? raw.toUpperCase().split('-')[0]
    : raw.toUpperCase().replace(/USDT$|USD$/g, '').replace(/[^A-Z]/g, '') || 'BTC';
  const normalized = symbol || 'BTC';
  const restUrl = `https://api.binance.com/api/v3/ticker/price?symbol=${normalized}USDT`;
  const configBySource = {
    rtds: {
      url: 'wss://ws-live-data.polymarket.com',
      productId: `${normalized.toLowerCase()}usdt`,
      topic: 'crypto_prices',
      restUrl,
    },
    binance: {
      url: `wss://stream.binance.com:9443/ws/${normalized.toLowerCase()}usdt@ticker`,
      productId: `${normalized}USDT`,
      topic: 'crypto_prices',
      restUrl,
    },
    coinbase: {
      url: 'wss://ws-feed.exchange.coinbase.com',
      productId: `${normalized}-USD`,
      topic: 'crypto_prices',
      restUrl,
    },
    okx: {
      url: 'wss://ws.okx.com:8443/ws/v5/public',
      productId: `${normalized}-USDT`,
      topic: 'crypto_prices',
      restUrl,
    },
    hyperliquid: {
      url: 'wss://api.hyperliquid.xyz/ws',
      productId: normalized,
      topic: 'crypto_prices',
      restUrl,
    },
  };
  return configBySource[source] ?? configBySource.rtds;
}

export class BtcPriceFeed extends EventEmitter {
  constructor({
    config = null,
    url = null,
    productId = null,
    restUrl = null,
    topic = null,
    source = null,
  } = {}) {
    super();
    const resolvedSource = source || (url ? this._detectSource(url) : 'rtds');
    const defaults = defaultFeedConfigFor(productId, resolvedSource);
    this.config = config;
    this.url = url ?? defaults.url;
    this.source = resolvedSource;
    this.topic = config?.BTC_PRICE_TOPIC ?? topic ?? defaults.topic;
    this.productId = productId ?? defaults.productId;
    this.restUrl = restUrl ?? defaults.restUrl;
    this.stallReconnectMs = Number(config?.BTC_PRICE_STALL_RECONNECT_MS ?? BTC_PRICE_STALL_RECONNECT_MS) || BTC_PRICE_STALL_RECONNECT_MS;
    this._ws = null;
    this._closed = false;
    this._reconnectDelayMs = 1_000;
    this._latest = null;
    this._waiters = new Set();
    this._lastTickAtMs = 0;
    this._stallCheckTimer = null;
    this._pingTimer = null;
  }

  _logContext(extra = {}) {
    return {
      source: this.source,
      productId: this.productId,
      url: this.url,
      ...extra,
    };
  }

  _detectSource(url) {
    if (/polymarket|ws-live-data/i.test(url)) return 'rtds';
    if (/binance/i.test(url)) return 'binance';
    if (/coinbase|exchange.coinbase/i.test(url)) return 'coinbase';
    if (/okx/i.test(url)) return 'okx';
    if (/hyperliquid/i.test(url)) return 'hyperliquid';
    if (/chainlink/i.test(url)) return 'chainlink';
    return 'unknown';
  }

  start() {
    this._closed = false;
    this._lastTickAtMs = Date.now();
    this._startStallWatch();
    this._connect();
  }

  stop() {
    this._closed = true;
    for (const waiter of this._waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('BTC price feed stopped'));
    }
    this._waiters.clear();
    this._stopStallWatch();
    this._stopPing();
    this._ws?.close();
  }

  updateConfig(config) {
    this.config = config ?? this.config;
    const nextUrl = this.url;
    const nextTopic = this.config?.BTC_PRICE_TOPIC ?? this.topic ?? 'crypto_prices';
    const nextProductId = this.productId;
    const nextRestUrl = this.restUrl;
    const nextStallReconnectMs = Number(this.config?.BTC_PRICE_STALL_RECONNECT_MS ?? BTC_PRICE_STALL_RECONNECT_MS) || BTC_PRICE_STALL_RECONNECT_MS;
    const changed = nextUrl !== this.url || nextTopic !== this.topic || nextProductId !== this.productId || nextRestUrl !== this.restUrl;
    this.url = nextUrl;
    this.topic = nextTopic;
    this.productId = nextProductId;
    this.restUrl = nextRestUrl;
    this.stallReconnectMs = nextStallReconnectMs;
    if (changed && this._ws && !this._closed) {
      this._ws.close();
    }
  }

  getLatest() {
    return this._latest;
  }

  _baseSymbol() {
    const raw = String(this.productId ?? '').trim().toUpperCase();
    if (!raw) return 'BTC';
    if (raw.includes('-')) return raw.split('-')[0] || 'BTC';
    if (raw.endsWith('USDT')) return raw.slice(0, -4) || 'BTC';
    if (raw.endsWith('USD')) return raw.slice(0, -3) || 'BTC';
    return raw.replace(/[^A-Z]/g, '') || 'BTC';
  }

  _binanceSymbol() {
    return `${this._baseSymbol()}USDT`;
  }

  _coinbaseProductId() {
    return `${this._baseSymbol()}-USD`;
  }

  _okxInstId() {
    return `${this._baseSymbol()}-USDT`;
  }

  _historicalTick(price, timeMs, source, extra = {}) {
    return {
      source,
      symbol: this.productId?.toLowerCase?.() ?? this._baseSymbol().toLowerCase(),
      price,
      bestBid: null,
      bestAsk: null,
      productId: this.productId,
      timeMs,
      isoTime: new Date(timeMs).toISOString(),
      historical: true,
      ...extra,
    };
  }

  async _fetchHistoricalTickFromBinance(timestampMs) {
    const baseParams = {
      symbol: this._binanceSymbol(),
      interval: '1s',
      startTime: timestampMs,
      endTime: timestampMs + 1_000,
      limit: 1,
    };
    let rows = [];
    try {
      const res = await axios.get('https://api.binance.com/api/v3/klines', { params: baseParams, timeout: 5_000 });
      rows = Array.isArray(res?.data) ? res.data : [];
    } catch {
      rows = [];
    }

    if (!rows.length) {
      const minuteStartMs = Math.floor(timestampMs / 60_000) * 60_000;
      const res = await axios.get('https://api.binance.com/api/v3/klines', {
        params: {
          symbol: this._binanceSymbol(),
          interval: '1m',
          startTime: minuteStartMs,
          endTime: minuteStartMs + 60_000,
          limit: 1,
        },
        timeout: 5_000,
      });
      rows = Array.isArray(res?.data) ? res.data : [];
    }

    const candle = rows[0];
    const candleStartMs = Number(candle?.[0]);
    const openPrice = Number(candle?.[1]);
    if (!Number.isFinite(candleStartMs) || !Number.isFinite(openPrice)) {
      throw new Error('Binance historical response missing candle open price');
    }
    return this._historicalTick(openPrice, candleStartMs, 'binance', {
      candleOpenTimeMs: candleStartMs,
      candleCloseTimeMs: Number(candle?.[6] ?? candleStartMs),
    });
  }

  async _fetchHistoricalTickFromCoinbase(timestampMs) {
    const candleStartMs = Math.floor(timestampMs / 60_000) * 60_000;
    const startSec = Math.floor(candleStartMs / 1_000);
    const endSec = startSec + 60;
    const res = await axios.get(`https://api.exchange.coinbase.com/products/${this._coinbaseProductId()}/candles`, {
      params: {
        granularity: 60,
        start: startSec,
        end: endSec,
      },
      timeout: 5_000,
    });
    const rows = Array.isArray(res?.data) ? res.data : [];
    const candle = rows.find((row) => Number(row?.[0]) === startSec) ?? rows[0];
    const rowStartSec = Number(candle?.[0]);
    const openPrice = Number(candle?.[3]);
    if (!Number.isFinite(rowStartSec) || !Number.isFinite(openPrice)) {
      throw new Error('Coinbase historical response missing candle open price');
    }
    return this._historicalTick(openPrice, rowStartSec * 1_000, 'coinbase', {
      candleOpenTimeMs: rowStartSec * 1_000,
      candleCloseTimeMs: (rowStartSec + 60) * 1_000 - 1,
    });
  }

  async _fetchHistoricalTickFromOkx(timestampMs) {
    const params = {
      instId: this._okxInstId(),
      bar: '1s',
      after: timestampMs + 1,
      limit: 1,
    };
    let rows = [];
    try {
      const res = await axios.get('https://www.okx.com/api/v5/market/history-candles', { params, timeout: 5_000 });
      rows = Array.isArray(res?.data?.data) ? res.data.data : [];
    } catch {
      rows = [];
    }

    if (!rows.length) {
      const minuteStartMs = Math.floor(timestampMs / 60_000) * 60_000;
      const res = await axios.get('https://www.okx.com/api/v5/market/history-candles', {
        params: {
          instId: this._okxInstId(),
          bar: '1m',
          after: minuteStartMs + 1,
          limit: 1,
        },
        timeout: 5_000,
      });
      rows = Array.isArray(res?.data?.data) ? res.data.data : [];
    }

    const candle = rows[0];
    const candleStartMs = Number(candle?.[0]);
    const openPrice = Number(candle?.[1]);
    if (!Number.isFinite(candleStartMs) || !Number.isFinite(openPrice)) {
      throw new Error('OKX historical response missing candle open price');
    }
    const barMs = candle?.[8] === '1' ? 60_000 : 1_000;
    return this._historicalTick(openPrice, candleStartMs, 'okx', {
      candleOpenTimeMs: candleStartMs,
      candleCloseTimeMs: candleStartMs + barMs - 1,
    });
  }

  async _fetchHistoricalTickFromHyperliquid(timestampMs) {
    const candleStartMs = Math.floor(timestampMs / 60_000) * 60_000;
    const body = {
      type: 'candleSnapshot',
      req: {
        coin: this._baseSymbol(),
        interval: '1m',
        startTime: candleStartMs,
        endTime: candleStartMs + 60_000,
      },
    };
    const res = await axios.post('https://api.hyperliquid.xyz/info', body, { timeout: 5_000 });
    const rows = Array.isArray(res?.data)
      ? res.data
      : (typeof res?.data === 'string' ? JSON.parse(res.data) : []);
    const candle = rows.find((row) => Number(row?.t) === candleStartMs) ?? rows[0];
    const rowStartMs = Number(candle?.t);
    const openPrice = Number(candle?.o);
    if (!Number.isFinite(rowStartMs) || !Number.isFinite(openPrice)) {
      throw new Error('Hyperliquid historical response missing candle open price');
    }
    return this._historicalTick(openPrice, rowStartMs, 'hyperliquid', {
      candleOpenTimeMs: rowStartMs,
      candleCloseTimeMs: Number(candle?.T ?? (rowStartMs + 60_000 - 1)),
    });
  }

  async fetchHistoricalTickAt(timestampMs) {
    const attempts = [
      ['binance', () => this._fetchHistoricalTickFromBinance(timestampMs)],
      ['coinbase', () => this._fetchHistoricalTickFromCoinbase(timestampMs)],
      ['okx', () => this._fetchHistoricalTickFromOkx(timestampMs)],
      ['hyperliquid', () => this._fetchHistoricalTickFromHyperliquid(timestampMs)],
    ];
    const failures = [];
    for (const [name, fn] of attempts) {
      try {
        return await fn();
      } catch (err) {
        failures.push(`${name}: ${err.message}`);
      }
    }
    throw new Error(`No historical price source available for ${new Date(timestampMs).toISOString()} (${failures.join('; ')})`);
  }

  async fetchRestTick(timeoutMs = 5_000) {
    if (!this.restUrl) {
      throw new Error(`No REST price URL configured for ${this.source}`);
    }
    const res = await axios.get(this.restUrl, { timeout: timeoutMs });
    const payload = res?.data ?? {};
    const price = Number(payload.price);
    if (!Number.isFinite(price)) {
      throw new Error('BTC REST price response missing numeric price');
    }

    const tick = {
      source: this.source,
      symbol: this.productId?.toLowerCase?.() ?? 'unknown',
      price,
      bestBid: this._latest?.bestBid ?? null,
      bestAsk: this._latest?.bestAsk ?? null,
      productId: this.productId,
      timeMs: Date.now(),
      isoTime: new Date().toISOString(),
    };

    this._latest = tick;
    this._lastTickAtMs = Date.now();
    this.emit('tick', tick);
    for (const waiter of [...this._waiters]) {
      if (tick.timeMs >= waiter.timestampMs) {
        waiter.resolve(tick);
      }
    }

    return tick;
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
      this._lastTickAtMs = Date.now();
      this._reconnectDelayMs = 1_000;
      this._subscribe();
      this._startPing();
      logger.debug('BtcPriceFeed: connected', {
        ...this._logContext({
          topic: this.topic,
          filters: this.productId,
        }),
      });
    });

    this._ws.on('message', (raw) => {
      // Any inbound frame proves the transport is alive, even if it does not
      // contain a matching BTC tick for this configured product.
      this._lastTickAtMs = Date.now();
      try {
        const text = raw.toString();
        if (this._handleControlMessage(text)) {
          return;
        }
        const msg = JSON.parse(text);
        this._handleMessage(msg);
      } catch (err) {
        logger.warn('BtcPriceFeed: parse error', this._logContext({ err: err.message }));
      }
    });

    this._ws.on('error', (err) => {
      logger.warn('BtcPriceFeed: websocket error', this._logContext({ err: err.message }));
      this.emit('error', err);
    });

    this._ws.on('pong', () => {
      this._lastTickAtMs = Date.now();
    });

    this._ws.on('ping', () => {
      this._lastTickAtMs = Date.now();
    });

    this._ws.on('close', () => {
      this._stopPing();
      if (this._closed) return;
      const delayMs = this._reconnectDelayMs;
      this._reconnectDelayMs = Math.min(this._reconnectDelayMs * 2, 30_000);
      logger.warn('BtcPriceFeed: websocket closed, reconnecting', this._logContext({ delayMs }));
      setTimeout(() => this._connect(), delayMs);
    });
  }

  _subscribe() {
    const payload = this._subscriptionPayload();
    if (!payload) return;
    this._ws?.send(JSON.stringify(payload));
  }

  _subscriptionPayload() {
    if (this.source === 'coinbase') {
      return {
        type: 'subscribe',
        product_ids: this.productId ? [this.productId] : [],
        channels: ['ticker'],
      };
    }

    if (this.source === 'okx') {
      return {
        op: 'subscribe',
        args: [{
          channel: 'tickers',
          instId: this.productId,
        }],
      };
    }

    if (this.source === 'hyperliquid') {
      return {
        method: 'subscribe',
        subscription: {
          type: 'trades',
          coin: this.productId,
        },
      };
    }

    if (this.source === 'binance') {
      return null;
    }

    const subscription = {
      topic: this.topic,
      type: 'update',
    };
    if (this.productId) {
      subscription.filters = this.productId;
    }
    return {
      action: 'subscribe',
      subscriptions: [subscription],
    };
  }

  _handleMessage(msg) {
    if (this.source === 'rtds') {
      return this._handleRtdsMessage(msg);
    } else if (this.source === 'binance') {
      return this._handleBinanceMessage(msg);
    } else if (this.source === 'coinbase') {
      return this._handleCoinbaseMessage(msg);
    } else if (this.source === 'okx') {
      return this._handleOkxMessage(msg);
    } else if (this.source === 'hyperliquid') {
      return this._handleHyperliquidMessage(msg);
    } else if (this.source === 'chainlink') {
      return this._handleChainlinkMessage(msg);
    }
  }

  _handleControlMessage(text) {
    const normalized = String(text ?? '').trim().toLowerCase();
    if (!normalized) return true;
    if (normalized === 'pong' || normalized === 'ping') {
      this._lastTickAtMs = Date.now();
      return true;
    }
    return false;
  }

  _handleRtdsMessage(msg) {
    if (!msg || msg.topic !== this.topic) return;

    const payload = msg.payload ?? {};
    if (msg.type === 'subscribe' && Array.isArray(payload.data)) {
      const latest = payload.data
        .map((item) => ({
          symbol: String(item?.symbol ?? '').toLowerCase(),
          price: Number(item?.value ?? item?.price),
          timeMs: Number(item?.timestamp ?? msg.timestamp),
          payload: item,
        }))
        .filter((item) => Number.isFinite(item.price) && Number.isFinite(item.timeMs))
        .sort((a, b) => Number(b.timeMs) - Number(a.timeMs))[0];
      if (latest) {
        this._emitTick(latest);
      }
      return;
    }

    if (msg.type !== 'update' || !payload || typeof payload !== 'object') return;

    const tickInfo = {
      symbol: String(payload.symbol ?? '').toLowerCase(),
      price: Number(payload.value ?? payload.price),
      bestBid: Number(payload.best_bid ?? payload.bestBid ?? NaN),
      bestAsk: Number(payload.best_ask ?? payload.bestAsk ?? NaN),
      timeMs: Number(payload.timestamp ?? msg.timestamp),
    };

    if (!Number.isFinite(tickInfo.price) || !Number.isFinite(tickInfo.timeMs)) return;
    if (this.productId && !String(this.productId).split(',').map((s) => s.trim().toLowerCase()).includes(tickInfo.symbol)) {
      return;
    }

    this._emitTick(tickInfo);
  }

  _handleBinanceMessage(msg) {
    if (!msg?.c) return;
    const price = Number(msg.c);
    const bestBid = Number(msg.b);
    const bestAsk = Number(msg.a);
    const timeMs = Number(msg.E ?? msg.T ?? Date.now());
    const tickInfo = {
      symbol: this.productId?.toLowerCase?.() ?? 'unknown',
      price,
      bestBid,
      bestAsk,
      timeMs,
    };
    if (!Number.isFinite(tickInfo.price) || !Number.isFinite(tickInfo.timeMs)) return;
    this._emitTick(tickInfo);
  }

  _handleCoinbaseMessage(msg) {
    if (msg.type !== 'ticker' && msg.type !== 'match') return;
    const tickInfo = {
      symbol: String(msg.product_id ?? '').toLowerCase(),
      price: Number(msg.price),
      bestBid: Number(msg.best_bid ?? NaN),
      bestAsk: Number(msg.best_ask ?? NaN),
      timeMs: Date.parse(msg.time) || Date.now(),
    };
    if (!Number.isFinite(tickInfo.price) || !Number.isFinite(tickInfo.timeMs)) return;
    this._emitTick(tickInfo);
  }

  _handleOkxMessage(msg) {
    if (!Array.isArray(msg.data)) return;
    const data = msg.data?.[0];
    if (!data) return;
    const tickInfo = {
      symbol: String(data.instId ?? '').toLowerCase(),
      price: Number(data.last ?? data.lastPx),
      bestBid: Number(data.bidPx ?? NaN),
      bestAsk: Number(data.askPx ?? NaN),
      timeMs: Number(data.ts ?? Date.now()),
    };
    if (!Number.isFinite(tickInfo.price) || !Number.isFinite(tickInfo.timeMs)) return;
    this._emitTick(tickInfo);
  }

  _handleHyperliquidMessage(msg) {
    if (msg.channel !== 'trades') return;
    const trades = Array.isArray(msg.data) ? msg.data : [];
    if (!Array.isArray(trades) || trades.length === 0) return;
    const latest = trades[trades.length - 1];
    const tickInfo = {
      symbol: String(latest.coin ?? this.productId ?? '').toLowerCase(),
      price: Number(latest.px),
      bestBid: null,
      bestAsk: null,
      timeMs: Number(latest.time ?? Date.now()),
    };
    if (!Number.isFinite(tickInfo.price) || !Number.isFinite(tickInfo.timeMs)) return;
    this._emitTick(tickInfo);
  }

  _handleChainlinkMessage(msg) {
    const tickInfo = {
      symbol: String(msg.symbol ?? '').toLowerCase(),
      price: Number(msg.price ?? msg.value),
      bestBid: null,
      bestAsk: null,
      timeMs: Number(msg.timestamp ?? msg.ts ?? Date.now()),
    };
    if (!Number.isFinite(tickInfo.price) || !Number.isFinite(tickInfo.timeMs)) return;
    this._emitTick(tickInfo);
  }

  _emitTick({ symbol, price, bestBid, bestAsk, timeMs }) {
    const tick = {
      source: this.source,
      symbol,
      price,
      bestBid: Number.isFinite(bestBid) ? bestBid : null,
      bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
      productId: this.productId,
      timeMs,
      isoTime: new Date(timeMs).toISOString(),
    };

    this._latest = tick;
    this._lastTickAtMs = Date.now();
    this.emit('tick', tick);
    for (const waiter of [...this._waiters]) {
      if (tick.timeMs >= waiter.timestampMs) {
        waiter.resolve(tick);
      }
    }
  }

  _startStallWatch() {
    this._stopStallWatch();
    this._stallCheckTimer = setInterval(() => {
      if (this._closed || !this._ws) return;
      if (this._ws.readyState !== WebSocket.OPEN) return;
      const idleMs = Date.now() - this._lastTickAtMs;
      if (idleMs <= this.stallReconnectMs) return;
      logger.warn('BtcPriceFeed: tick stream stalled, forcing reconnect', this._logContext({
        idleMs,
        stallReconnectMs: this.stallReconnectMs,
      }));
      try {
        this._ws.terminate();
      } catch (err) {
        logger.warn('BtcPriceFeed: terminate failed after stall', this._logContext({
          err: err.message,
        }));
      }
    }, 1_000);
    this._stallCheckTimer.unref?.();
  }

  _startPing() {
    this._stopPing();
    if (this.source === 'binance' || this.source === 'coinbase' || this.source === 'hyperliquid') {
      return;
    }
    this._pingTimer = setInterval(() => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      try {
        if (this.source === 'okx') {
          this._ws.send('ping');
        } else {
          this._ws.send('PING');
        }
      } catch (err) {
        logger.warn('BtcPriceFeed: failed to send ping', this._logContext({ err: err.message }));
      }
    }, PING_INTERVAL_MS);
    this._pingTimer.unref?.();
  }

  _stopPing() {
    if (!this._pingTimer) return;
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  _stopStallWatch() {
    if (!this._stallCheckTimer) return;
    clearInterval(this._stallCheckTimer);
    this._stallCheckTimer = null;
  }
}
