import { EventEmitter } from 'events';
import crypto from 'node:crypto';
import axios from 'axios';
import WebSocket from 'ws';
import { Wallet } from 'ethers';
import {
  ClobClient as PolymarketClobClient,
  Chain,
  OrderType,
  Side,
} from '@polymarket/clob-client-v2';
import {
  API_KEY,
  API_PASSPHRASE,
  API_SECRET,
  BOOK_POLL_MS,
  CLOB_API_URL,
  CLOB_WS_URL,
  FUNDER_ADDRESS,
  GAMMA_API_URL,
  POLYGON_RPC,
  PRIVATE_KEY,
  SIGNATURE_TYPE,
  USDC_SCALE,
} from './config.js';
import logger from './logger.js';

const SDK_CHAIN = Chain.POLYGON;
const DEFAULT_TICK_SIZE = '0.01';
const DEFAULT_MIN_ORDER_SIZE = '5';
const BOOK_HEARTBEAT_MS = 10_000;
const USER_HEARTBEAT_MS = 10_000;

function parsePositiveNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimestampMs(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric > 1e12) return Math.trunc(numeric);
    if (numeric > 1e9) return Math.trunc(numeric * 1000);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCreds(creds = null) {
  if (!creds) return null;
  const key = String(creds.key ?? creds.apiKey ?? '').trim();
  const secret = String(creds.secret ?? '').trim();
  const passphrase = String(creds.passphrase ?? '').trim();
  if (!key || !secret || !passphrase) return null;
  return {
    key,
    apiKey: key,
    secret,
    passphrase,
  };
}

function normalizeBook(raw) {
  if (!raw) return null;
  const bids = Array.isArray(raw.bids)
    ? raw.bids.map((level) => ({
      price: Number(level.price),
      size: Number(level.size),
    })).filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0)
      .sort((a, b) => b.price - a.price)
    : [];
  const asks = Array.isArray(raw.asks)
    ? raw.asks.map((level) => ({
      price: Number(level.price),
      size: Number(level.size),
    })).filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0)
      .sort((a, b) => a.price - b.price)
    : [];
  return {
    market: raw.market ?? null,
    asset_id: raw.asset_id ?? null,
    assetId: raw.asset_id ?? raw.assetId ?? null,
    bids,
    asks,
    tickSize: parsePositiveNumber(raw.tick_size ?? raw.tickSize, Number(DEFAULT_TICK_SIZE)) ?? Number(DEFAULT_TICK_SIZE),
    minOrderSize: parsePositiveNumber(raw.min_order_size ?? raw.minOrderSize, Number(DEFAULT_MIN_ORDER_SIZE)) ?? Number(DEFAULT_MIN_ORDER_SIZE),
    hash: raw.hash ?? null,
    negRisk: Boolean(raw.neg_risk ?? raw.negRisk),
    fetchedAtMs: Date.now(),
    sourceTimestampMs: parseTimestampMs(raw.timestamp) ?? Date.now(),
    lastTradePrice: parsePositiveNumber(raw.last_trade_price ?? raw.lastTradePrice, null),
  };
}

function extractOrderId(response) {
  return response?.orderID ?? response?.orderId ?? response?.id ?? null;
}

function normalizeTradeEvent(raw) {
  if (!raw || raw.event_type !== 'trade') return null;
  const tokenId = String(raw.asset_id ?? raw.assetId ?? '').trim();
  const side = String(raw.side ?? '').toUpperCase();
  const price = Number(raw.price);
  const size = Number(raw.size);
  if (!tokenId || !Number.isFinite(price) || !Number.isFinite(size) || size <= 0) return null;
  return {
    tokenId,
    side,
    price,
    size,
    feeRateBps: Number(raw.fee_rate_bps ?? 0) || 0,
    transactionHash: raw.transaction_hash ?? null,
    market: raw.market ?? null,
    outcome: raw.outcome ?? null,
    timestampMs: parseTimestampMs(raw.timestamp ?? raw.matchtime ?? raw.last_update) ?? Date.now(),
    raw,
  };
}

function normalizeUserFill(raw) {
  if (!raw || raw.event_type !== 'trade') return null;
  const tokenId = String(raw.asset_id ?? raw.assetId ?? '').trim();
  const side = String(raw.side ?? '').toUpperCase();
  const price = Number(raw.price);
  const size = Number(raw.size);
  if (!tokenId || !Number.isFinite(price) || !Number.isFinite(size) || size <= 0) return null;
  return {
    tokenId,
    side,
    price,
    size,
    orderId: raw.taker_order_id ?? raw.order_id ?? null,
    market: raw.market ?? null,
    status: raw.status ?? null,
    timestampMs: parseTimestampMs(raw.timestamp ?? raw.matchtime ?? raw.last_update) ?? Date.now(),
    source: 'user-channel',
    raw,
  };
}

export class ClobClient {
  static _wallet = null;
  static _sdkSigner = null;
  static _sdkClient = null;
  static _sdkCreds = null;
  static _signerAddress = null;
  static _takerFeeBpsCache = new Map();
  static _heartbeatId = crypto.randomUUID();

  static _normalizeWallet(wallet = null) {
    return wallet ?? this._wallet ?? null;
  }

  static _getSdkSigner() {
    if (!this._sdkSigner) {
      const baseWallet = new Wallet(PRIVATE_KEY);
      this._sdkSigner = Object.assign(baseWallet, {
        _signTypedData(domain, types, value) {
          return this.signTypedData(domain, types, value);
        },
      });
      this._signerAddress = baseWallet.address;
    }
    return this._sdkSigner;
  }

  static _buildSdkClient({ creds = null } = {}) {
    const signer = this._getSdkSigner();
    const normalizedCreds = normalizeCreds(creds);
    const options = {
      host: CLOB_API_URL,
      chain: SDK_CHAIN,
      signer,
      ...(normalizedCreds ? { creds: normalizedCreds } : {}),
      throwOnError: true,
      signatureType: SIGNATURE_TYPE,
      ...(Number(SIGNATURE_TYPE) !== 0 ? { funderAddress: FUNDER_ADDRESS } : {}),
    };
    return new PolymarketClobClient(options);
  }

  static _requireSdkClient() {
    if (!this._sdkClient) {
      throw new Error('ClobClient not initialized');
    }
    return this._sdkClient;
  }

  static async _deriveSdkCreds() {
    const bootstrap = this._buildSdkClient();
    const l1Address = this._signerAddress ?? (typeof bootstrap.signer?.getAddress === 'function' ? await bootstrap.signer.getAddress() : null);
    logger.info('CLOB: deriving API credentials via L1 auth…', {
      l1Address,
      funderAddress: FUNDER_ADDRESS,
      signatureType: SIGNATURE_TYPE,
    });
    try {
      return normalizeCreds(await bootstrap.deriveApiKey());
    } catch (err) {
      logger.warn('CLOB: deriveApiKey failed, trying createApiKey fallback', {
        err: err.message,
        l1Address,
        signatureType: SIGNATURE_TYPE,
      });
      return normalizeCreds(await bootstrap.createApiKey());
    }
  }

  static async init(wallet, { apiKey = '', secret = '', passphrase = '' } = {}) {
    this._wallet = wallet ?? this._wallet ?? null;
    this._getSdkSigner();
    logger.info('CLOB: init context', {
      signerAddress: this._signerAddress,
      funderAddress: FUNDER_ADDRESS,
      signatureType: SIGNATURE_TYPE,
    });

    const envCreds = normalizeCreds({ key: apiKey || API_KEY, secret: secret || API_SECRET, passphrase: passphrase || API_PASSPHRASE });
    if (envCreds) {
      this._sdkCreds = envCreds;
      this._sdkClient = this._buildSdkClient({ creds: envCreds });
      logger.info('CLOB: using provided API credentials', { apiKey: envCreds.key });
      return this._sdkClient;
    }

    this._sdkCreds = await this._deriveSdkCreds();
    this._sdkClient = this._buildSdkClient({ creds: this._sdkCreds });
    logger.info('CLOB: credentials derived', { apiKey: this._sdkCreds?.key ?? null });
    return this._sdkClient;
  }

  static async refreshCredentials() {
    this._sdkCreds = await this._deriveSdkCreds();
    this._sdkClient = this._buildSdkClient({ creds: this._sdkCreds });
    logger.info('CLOB: refreshed API credentials', { apiKey: this._sdkCreds?.key ?? null });
    return this._sdkCreds;
  }

  static get creds() {
    return this._sdkCreds;
  }

  static async probeL2Auth() {
    try {
      const orders = await this._requireSdkClient().getOpenOrders();
      logger.info('CLOB: L2 auth probe succeeded', {
        path: '/data/orders',
        count: Array.isArray(orders) ? orders.length : 0,
      });
      return orders;
    } catch (err) {
      if (this._sdkCreds) {
        logger.warn('CLOB: cached API credentials rejected, deriving fresh credentials and retrying');
        await this.refreshCredentials();
        const orders = await this._requireSdkClient().getOpenOrders();
        logger.info('CLOB: L2 auth probe succeeded', {
          path: '/data/orders',
          count: Array.isArray(orders) ? orders.length : 0,
        });
        return orders;
      }
      throw err;
    }
  }

  static async getTakerFeeBps(tokenId) {
    const key = String(tokenId ?? '').trim();
    if (!key) return 0;
    if (this._takerFeeBpsCache.has(key)) return this._takerFeeBpsCache.get(key);

    try {
      const feeRateBps = Number(await this._requireSdkClient().getFeeRateBps(key)) || 0;
      this._takerFeeBpsCache.set(key, feeRateBps);
      return feeRateBps;
    } catch (sdkErr) {
      try {
        const response = await axios.get(`${GAMMA_API_URL}/markets`, {
          params: { clob_token_ids: key },
          timeout: 10_000,
        });
        const markets = Array.isArray(response.data) ? response.data : (Array.isArray(response.data?.data) ? response.data.data : []);
        const market = markets.find((entry) => {
          const ids = Array.isArray(entry?.clobTokenIds) ? entry.clobTokenIds : [];
          return ids.map(String).includes(key);
        }) ?? markets[0];
        const feeRateBps = Number(market?.takerBaseFee ?? 0) || 0;
        this._takerFeeBpsCache.set(key, feeRateBps);
        return feeRateBps;
      } catch {
        this._takerFeeBpsCache.set(key, 0);
        return 0;
      }
    }
  }

  static estimateTakerFeeUsdc({ shares, price, feeRateBps }) {
    const normalizedShares = Number(shares);
    const normalizedPrice = Number(price);
    const normalizedFeeRateBps = Number(feeRateBps);
    if (!Number.isFinite(normalizedShares) || normalizedShares <= 0) return 0;
    if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0 || normalizedPrice >= 1) return 0;
    if (!Number.isFinite(normalizedFeeRateBps) || normalizedFeeRateBps <= 0) return 0;
    const feeRate = normalizedFeeRateBps / 10_000;
    const rawFee = normalizedShares * feeRate * normalizedPrice * (1 - normalizedPrice);
    if (!Number.isFinite(rawFee) || rawFee <= 0) return 0;
    return Math.round(rawFee * 1e5) / 1e5;
  }

  static async estimateTokenTakerFeeUsdc(tokenId, shares, price) {
    const feeRateBps = await this.getTakerFeeBps(tokenId);
    return this.estimateTakerFeeUsdc({ shares, price, feeRateBps });
  }

  static async sendHeartbeat() {
    return this._requireSdkClient().postHeartbeat(this._heartbeatId);
  }

  static async getBook(tokenId, { quietNotFound = false } = {}) {
    try {
      const raw = await this._requireSdkClient().getOrderBook(String(tokenId));
      return normalizeBook(raw);
    } catch (err) {
      const status = Number(err?.status ?? err?.response?.status ?? 0);
      const message = String(err?.message ?? '');
      if (quietNotFound && (status === 404 || /not found|no orderbook/i.test(message))) {
        return null;
      }
      throw err;
    }
  }

  static async getBestAsk(tokenId) {
    const book = await this.getBook(tokenId, { quietNotFound: true });
    if (!book?.asks?.length) return null;
    const bestAsk = book.asks.reduce((best, level) => (!best || level.price < best.price ? level : best), null);
    return bestAsk ? {
      ...bestAsk,
      tickSize: book.tickSize,
      minOrderSize: book.minOrderSize,
      fetchedAtMs: book.fetchedAtMs,
      sourceTimestampMs: book.sourceTimestampMs,
    } : null;
  }

  static estimateMarketBuyFillFromBook(book, maxPrice, amountUsdc, feeRateBps = 0) {
    const normalizedBook = book ? normalizeBook(book) : null;
    const asks = Array.isArray(normalizedBook?.asks) ? normalizedBook.asks : [];
    const limitPrice = Number(maxPrice);
    const budgetUsdc = Number(amountUsdc);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) return null;
    if (!Number.isFinite(budgetUsdc) || budgetUsdc <= 0) return null;

    let remainingUsdc = budgetUsdc;
    let fillShares = 0;
    let spentUsdc = 0;
    let feeUsdc = 0;
    const fills = [];

    for (const level of asks) {
      const price = Number(level.price);
      const size = Number(level.size);
      if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;
      if (price - limitPrice > 1e-9) break;
      const maxAffordableShares = remainingUsdc / price;
      if (!(maxAffordableShares > 1e-9)) break;
      const takeShares = Math.min(size, maxAffordableShares);
      const takeSpentUsdc = takeShares * price;
      if (!(takeShares > 1e-9) || !(takeSpentUsdc > 1e-9)) continue;
      const takeFeeUsdc = this.estimateTakerFeeUsdc({
        shares: takeShares,
        price,
        feeRateBps,
      });
      fills.push({
        price,
        shares: takeShares,
        spentUsdc: takeSpentUsdc,
        feeUsdc: takeFeeUsdc,
      });
      fillShares += takeShares;
      spentUsdc += takeSpentUsdc;
      feeUsdc += takeFeeUsdc;
      remainingUsdc -= takeSpentUsdc;
      if (remainingUsdc <= 1e-9) break;
    }

    if (!(fillShares > 1e-9) || !(spentUsdc > 1e-9)) return null;
    return {
      fillShares,
      spentUsdc,
      avgFillPrice: spentUsdc / fillShares,
      feeRateBps,
      estimatedFeeUsdc: feeUsdc,
      fullyFilled: remainingUsdc <= 1e-6,
      fills,
    };
  }

  static async estimateMarketBuyFill(tokenId, maxPrice, amountUsdc) {
    const [book, feeRateBps] = await Promise.all([
      this.getBook(tokenId, { quietNotFound: true }),
      this.getTakerFeeBps(tokenId),
    ]);
    if (!book) return null;
    return this.estimateMarketBuyFillFromBook(book, maxPrice, amountUsdc, feeRateBps);
  }

  static async postLimitBuy(_wallet, tokenId, price, shares, negRisk = true) {
    const response = await this._requireSdkClient().createAndPostOrder(
      {
        tokenID: String(tokenId),
        price: Number(price),
        size: Number(shares),
        side: Side.BUY,
      },
      {
        tickSize: DEFAULT_TICK_SIZE,
        negRisk,
      },
      OrderType.GTC,
    );
    return extractOrderId(response);
  }

  static async postFOKLimitBuy(_wallet, tokenId, price, shares, negRisk = true) {
    const client = this._requireSdkClient();
    const order = await client.createOrder(
      {
        tokenID: String(tokenId),
        price: Number(price),
        size: Number(shares),
        side: Side.BUY,
      },
      {
        tickSize: DEFAULT_TICK_SIZE,
        negRisk,
      },
    );
    return client.postOrder(order, OrderType.FOK);
  }

  static async postLimitSell(_wallet, tokenId, price, shares, negRisk = true) {
    const response = await this._requireSdkClient().createAndPostOrder(
      {
        tokenID: String(tokenId),
        price: Number(price),
        size: Number(shares),
        side: Side.SELL,
      },
      {
        tickSize: DEFAULT_TICK_SIZE,
        negRisk,
      },
      OrderType.GTC,
    );
    return response;
  }

  static async postIOCBuy(_wallet, tokenId, maxPrice, amountUsdc, negRisk = true) {
    return this._requireSdkClient().createAndPostMarketOrder(
      {
        tokenID: String(tokenId),
        amount: Number(amountUsdc),
        price: Number(maxPrice),
        side: Side.BUY,
        orderType: OrderType.FAK,
      },
      {
        tickSize: DEFAULT_TICK_SIZE,
        negRisk,
      },
      OrderType.FAK,
    );
  }

  static async postFOKBuy(_wallet, tokenId, maxPrice, amountUsdc, negRisk = true) {
    return this._requireSdkClient().createAndPostMarketOrder(
      {
        tokenID: String(tokenId),
        amount: Number(amountUsdc),
        price: Number(maxPrice),
        side: Side.BUY,
        orderType: OrderType.FOK,
      },
      {
        tickSize: DEFAULT_TICK_SIZE,
        negRisk,
      },
      OrderType.FOK,
    );
  }

  static async postFOKSell(_wallet, tokenId, minPrice, shares, negRisk = true) {
    return this._requireSdkClient().createAndPostMarketOrder(
      {
        tokenID: String(tokenId),
        amount: Number(shares),
        price: Number(minPrice),
        side: Side.SELL,
        orderType: OrderType.FOK,
      },
      {
        tickSize: DEFAULT_TICK_SIZE,
        negRisk,
      },
      OrderType.FOK,
    );
  }

  static async cancelOrder(orderId) {
    return this._requireSdkClient().cancelOrder({ orderID: String(orderId) });
  }

  static async cancelAll() {
    return this._requireSdkClient().cancelAll();
  }

  static async cancelMarket(conditionId) {
    return this._requireSdkClient().cancelMarketOrders({ market: String(conditionId) });
  }

  static async getOpenOrders(conditionId = null) {
    return this._requireSdkClient().getOpenOrders(
      conditionId ? { market: String(conditionId) } : undefined,
    );
  }
}

export class BookFeed extends EventEmitter {
  constructor(tokenIds = []) {
    super();
    this.tokenIds = [...new Set((tokenIds ?? []).map((tokenId) => String(tokenId)).filter(Boolean))];
    this._ws = null;
    this._pollTimer = null;
    this._heartbeatTimer = null;
    this._lastBooks = new Map();
    this._stopped = true;
  }

  async _emitBook(tokenId, rawBook = null) {
    const book = rawBook ? normalizeBook(rawBook) : await ClobClient.getBook(tokenId, { quietNotFound: true });
    if (!book) return;
    this._lastBooks.set(String(tokenId), book);
    const bestAsk = book.asks?.[0] ?? null;
    const bestBid = book.bids?.[0] ?? null;
    this.emit('update', {
      tokenId: String(tokenId),
      book,
      bestAsk,
      bestBid,
    });
  }

  async _refreshAllBooks() {
    await Promise.all(this.tokenIds.map(async (tokenId) => {
      try {
        await this._emitBook(tokenId);
      } catch (err) {
        this.emit('error', err);
      }
    }));
  }

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      this._refreshAllBooks().catch((err) => this.emit('error', err));
    }, Math.max(250, Number(BOOK_POLL_MS) || 1_000));
  }

  _clearTimers() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _connectWs() {
    if (!this.tokenIds.length) return;
    const ws = new WebSocket(`${CLOB_WS_URL.replace(/\/$/, '')}/market`);
    this._ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        assets_ids: this.tokenIds,
        type: 'market',
        custom_feature_enabled: true,
      }));
      this._heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('PING');
        }
      }, BOOK_HEARTBEAT_MS);
    });

    ws.on('message', (buf) => {
      try {
        const rawText = buf.toString();
        if (!rawText || rawText === 'PONG' || rawText === 'PING') return;
        if (!(rawText.startsWith('{') || rawText.startsWith('['))) return;
        const message = JSON.parse(rawText);
        if (!message || typeof message !== 'object') return;
        if (message.event_type === 'book') {
          void this._emitBook(message.asset_id ?? message.assetId, message).catch((err) => this.emit('error', err));
          return;
        }
        if (message.event_type === 'best_bid_ask') {
          const tokenId = String(message.asset_id ?? message.assetId ?? '');
          if (!tokenId) return;
          const previous = this._lastBooks.get(tokenId) ?? {
            bids: [],
            asks: [],
            tickSize: Number(DEFAULT_TICK_SIZE),
            minOrderSize: Number(DEFAULT_MIN_ORDER_SIZE),
          };
          const nextBook = {
            ...previous,
            asset_id: tokenId,
            assetId: tokenId,
            bids: Number.isFinite(Number(message.best_bid)) && Number(message.best_bid) > 0
              ? [{ price: Number(message.best_bid), size: previous.bids?.[0]?.size ?? 0 }]
              : previous.bids,
            asks: Number.isFinite(Number(message.best_ask)) && Number(message.best_ask) > 0
              ? [{ price: Number(message.best_ask), size: previous.asks?.[0]?.size ?? 0 }]
              : previous.asks,
            timestamp: message.timestamp,
          };
          void this._emitBook(tokenId, nextBook).catch((err) => this.emit('error', err));
          return;
        }
        if (message.event_type === 'last_trade_price') {
          const trade = normalizeTradeEvent(message);
          if (trade) this.emit('trade', trade);
          return;
        }
      } catch (err) {
        this.emit('error', err);
      }
    });

    ws.on('error', (err) => {
      this.emit('error', err);
    });

    ws.on('close', () => {
      this._clearTimers();
      this._ws = null;
      if (!this._stopped) {
        setTimeout(() => {
          if (!this._stopped) this._connectWs();
        }, 1_000);
      }
    });
  }

  start() {
    this._stopped = false;
    void this._refreshAllBooks().catch((err) => this.emit('error', err));
    this._startPolling();
    this._connectWs();
  }

  stop() {
    this._stopped = true;
    this._clearTimers();
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        // ignore
      }
      this._ws = null;
    }
  }
}

export class FillFeed extends EventEmitter {
  constructor({ markets = [] } = {}) {
    super();
    this.markets = Array.isArray(markets) ? markets.map(String).filter(Boolean) : [];
    this._ws = null;
    this._heartbeatTimer = null;
    this._stopped = true;
  }

  _connect() {
    const creds = ClobClient.creds;
    if (!creds) {
      throw new Error('FillFeed requires initialized CLOB credentials');
    }
    const ws = new WebSocket(`${CLOB_WS_URL.replace(/\/$/, '')}/user`);
    this._ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        auth: {
          apiKey: creds.apiKey ?? creds.key,
          secret: creds.secret,
          passphrase: creds.passphrase,
        },
        ...(this.markets.length ? { markets: this.markets } : {}),
        type: 'user',
      }));
      this._heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('PING');
        }
      }, USER_HEARTBEAT_MS);
    });

    ws.on('message', (buf) => {
      try {
        const rawText = buf.toString();
        if (!rawText || rawText === 'PONG' || rawText === 'PING') return;
        if (!(rawText.startsWith('{') || rawText.startsWith('['))) return;
        const message = JSON.parse(rawText);
        const fill = normalizeUserFill(message);
        if (fill) {
          this.emit('fill', fill);
        }
      } catch (err) {
        this.emit('error', err);
      }
    });

    ws.on('error', (err) => {
      this.emit('error', err);
    });

    ws.on('close', () => {
      if (this._heartbeatTimer) {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
      }
      this._ws = null;
      if (!this._stopped) {
        setTimeout(() => {
          if (!this._stopped) this._connect();
        }, 1_000);
      }
    });
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        // ignore
      }
      this._ws = null;
    }
  }
}
