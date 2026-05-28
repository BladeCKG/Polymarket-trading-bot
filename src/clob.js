/**
 * clob.js
 * Polymarket CLOB client: REST + WebSocket.
 *
 * Responsibilities:
 *  - L1 auth: derive API credentials (apiKey, secret, passphrase) by signing
 *    an EIP-712 message with the EOA private key.
 *  - HMAC auth: sign each REST request.
 *  - EIP-712 order signing for BUY limit and market orders.
 *  - REST helpers: postOrder, cancelOrder, cancelAll, getOpenOrders, getBook.
 *  - WebSocket: subscribe to book snapshots + price-change diffs for a pair of
 *    tokenIds; exposes an EventEmitter interface for the Trader to consume.
 */
import crypto from 'crypto';
import { EventEmitter } from 'events';
import axios from 'axios';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import {
  CLOB_API_URL,
  CLOB_WS_URL,
  GAMMA_API_URL,
  PROXY_WALLET,
  ORDER_DOMAIN,
  ORDER_DOMAIN_BINARY,
  ORDER_TYPES,
  AUTH_DOMAIN,
  AUTH_TYPES,
  USDC_SCALE,
  TOKEN_DECIMALS,
  SIGNATURE_TYPE,
} from './config.js';
import logger from './logger.js';

// ── Side constants (must be the string "BUY"/"SELL", not integers) ────────────
const SIDE_BUY  = 'BUY';
const SIDE_SELL = 'SELL';

const ROUNDING_CONFIG = {
  '0.1':    { price: 1, size: 2, amount: 3 },
  '0.01':   { price: 2, size: 2, amount: 4 },
  '0.001':  { price: 3, size: 2, amount: 5 },
  '0.0001': { price: 4, size: 2, amount: 6 },
};

function roundDown(x, digits) {
  const f = 10 ** digits;
  return Math.floor(x * f) / f;
}

function roundUp(x, digits) {
  const f = 10 ** digits;
  return Math.ceil(x * f) / f;
}

function roundNormal(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function decimalPlaces(x) {
  const s = x.toString();
  if (s.includes('e-')) {
    const [, exp] = s.split('e-');
    return parseInt(exp, 10);
  }
  const parts = s.split('.');
  return parts[1]?.length ?? 0;
}

function toTokenDecimals(x) {
  const scaled = x * USDC_SCALE;
  return BigInt(Math.round(scaled)).toString();
}

function getRoundConfig(tickSize) {
  return ROUNDING_CONFIG[String(tickSize)] ?? ROUNDING_CONFIG['0.01'];
}

// ── HMAC auth headers (for all trading endpoints) ────────────────────────────
function buildHeaders(method, path, body = '') {
  if (!ClobClient._creds) throw new Error('CLOB credentials not initialised — call ClobClient.init() first');
  if (!ClobClient._signerAddress) throw new Error('CLOB signer address not initialised — call ClobClient.init() first');
  const { apiKey, secret, passphrase } = ClobClient._creds;
  const ts  = Math.floor(Date.now() / 1000).toString();
  const msg = ts + method.toUpperCase() + path + body;
  // Decode the base64 secret to raw bytes (as the official SDK does),
  // then encode the HMAC output as URL-safe base64.
  const secretBytes = Buffer.from(secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const rawSig = crypto.createHmac('sha256', secretBytes).update(msg).digest('base64');
  const sig = rawSig.replace(/\+/g, '-').replace(/\//g, '_');
  return {
    // Polymarket L2 auth requires the EOA signer address tied to the API key,
    // not the proxy wallet / funder address.
    'POLY_ADDRESS':    ClobClient._signerAddress,
    'POLY_SIGNATURE':  sig,
    'POLY_TIMESTAMP':  ts,
    'POLY_NONCE':      '0',
    'POLY_API_KEY':    apiKey,
    'POLY_PASSPHRASE': passphrase,
    'Content-Type':    'application/json',
  };
}

// ── REST base call ────────────────────────────────────────────────────────────
async function restCall(method, path, data = null, auth = true, options = {}) {
  const url    = CLOB_API_URL + path;
  const body   = data ? JSON.stringify(data) : '';
  const config = {
    method,
    url,
    headers: auth ? buildHeaders(method, path, body) : { 'Content-Type': 'application/json' },
  };
  if (data) config.data = data;
  try {
    const res = await axios(config);
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data;
    const quietStatuses = new Set(options.quietStatuses ?? []);
    if (
      auth &&
      status === 401 &&
      !config._retriedAfterRefresh &&
      /invalid api key/i.test(detail?.error ?? '')
    ) {
      logger.warn('CLOB: cached API credentials rejected, deriving fresh credentials and retrying');
      await ClobClient.refreshCredentials();
      const retryConfig = {
        ...config,
        headers: buildHeaders(method, path, body),
        _retriedAfterRefresh: true,
      };
      const retryRes = await axios(retryConfig);
      return retryRes.data;
    }
    if (!quietStatuses.has(status)) {
      logger.error('CLOB REST error', { method, path, status, detail });
    }
    throw err;
  }
}

// ── EIP-712 order signing ─────────────────────────────────────────────────────
/**
 * Build and sign a BUY limit order struct.
 *
 * @param {ethers.Wallet} wallet    - Signer wallet (EOA)
 * @param {string}        tokenId   - ERC-1155 token ID (as a decimal string)
 * @param {number}        price     - e.g. 0.50  (human units, 0–1)
 * @param {number}        shares    - e.g. 100   (human units)
 * @param {number}        expiry    - unix ts (0 = GTC)
 * @param {boolean}       negRisk   - true  → Neg Risk CTF Exchange (complementary-token markets)
 *                                    false → standard CTF Exchange (binary YES/NO markets)
 * @returns {{ orderData, signature }}
 */
async function buildLimitBuyOrder(wallet, tokenId, price, shares, expiry = 0, negRisk = true, feeRateBps = '0', tickSize = '0.01') {
  const roundConfig = getRoundConfig(tickSize);
  const rawPrice = roundNormal(price, roundConfig.price);
  const rawTakerAmt = roundDown(shares, roundConfig.size);

  let rawMakerAmt = rawTakerAmt * rawPrice;
  if (decimalPlaces(rawMakerAmt) > roundConfig.amount) {
    rawMakerAmt = roundUp(rawMakerAmt, roundConfig.amount + 4);
    if (decimalPlaces(rawMakerAmt) > roundConfig.amount) {
      rawMakerAmt = roundDown(rawMakerAmt, roundConfig.amount);
    }
  }

  const makerAmt = toTokenDecimals(rawMakerAmt);
  const takerAmt = toTokenDecimals(rawTakerAmt);
  const saltInt  = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

  const signData = {
    salt:          saltInt,
    maker:         PROXY_WALLET,
    signer:        wallet.address,
    taker:         ethers.ZeroAddress,
    tokenId:       tokenId,
    makerAmount:   makerAmt,
    takerAmount:   takerAmt,
    expiration:    expiry.toString(),
    nonce:         '0',
    feeRateBps:    feeRateBps.toString(),
    side:          0,
    signatureType: SIGNATURE_TYPE,
  };

  const domain = negRisk ? ORDER_DOMAIN : ORDER_DOMAIN_BINARY;
  const signature = await wallet.signTypedData(domain, ORDER_TYPES, signData);

  const orderData = {
    ...signData,
    side: SIDE_BUY,
    salt: saltInt,
  };

  return { orderData, signature };
}

async function buildMarketBuyOrder(wallet, tokenId, maxPrice, amountUsdc, expiry = 0, negRisk = true, feeRateBps = '0', tickSize = '0.01') {
  const roundConfig = getRoundConfig(tickSize);
  const rawPrice = roundDown(maxPrice, roundConfig.price);
  const rawMakerAmt = roundDown(amountUsdc, roundConfig.size);

  let rawTakerAmt = rawMakerAmt / rawPrice;
  if (decimalPlaces(rawTakerAmt) > roundConfig.amount) {
    rawTakerAmt = roundUp(rawTakerAmt, roundConfig.amount + 4);
    if (decimalPlaces(rawTakerAmt) > roundConfig.amount) {
      rawTakerAmt = roundDown(rawTakerAmt, roundConfig.amount);
    }
  }

  const makerAmt = toTokenDecimals(rawMakerAmt);
  const takerAmt = toTokenDecimals(rawTakerAmt);
  const saltInt  = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

  const signData = {
    salt:          saltInt,
    maker:         PROXY_WALLET,
    signer:        wallet.address,
    taker:         ethers.ZeroAddress,
    tokenId:       tokenId,
    makerAmount:   makerAmt,
    takerAmount:   takerAmt,
    expiration:    expiry.toString(),
    nonce:         '0',
    feeRateBps:    feeRateBps.toString(),
    side:          0,
    signatureType: SIGNATURE_TYPE,
  };

  const domain = negRisk ? ORDER_DOMAIN : ORDER_DOMAIN_BINARY;
  const signature = await wallet.signTypedData(domain, ORDER_TYPES, signData);

  const orderData = {
    ...signData,
    side: SIDE_BUY,
    salt: saltInt,
  };

  return { orderData, signature };
}

async function buildMarketSellOrder(wallet, tokenId, minPrice, shares, expiry = 0, negRisk = true, feeRateBps = '0', tickSize = '0.01') {
  const roundConfig = getRoundConfig(tickSize);
  const rawPrice = roundUp(minPrice, roundConfig.price);
  const rawMakerAmt = roundDown(shares, roundConfig.size);

  let rawTakerAmt = rawMakerAmt * rawPrice;
  if (decimalPlaces(rawTakerAmt) > roundConfig.amount) {
    rawTakerAmt = roundDown(rawTakerAmt, roundConfig.amount);
  }

  const makerAmt = toTokenDecimals(rawMakerAmt);
  const takerAmt = toTokenDecimals(rawTakerAmt);
  const saltInt  = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

  const signData = {
    salt:          saltInt,
    maker:         PROXY_WALLET,
    signer:        wallet.address,
    taker:         ethers.ZeroAddress,
    tokenId:       tokenId,
    makerAmount:   makerAmt,
    takerAmount:   takerAmt,
    expiration:    expiry.toString(),
    nonce:         '0',
    feeRateBps:    feeRateBps.toString(),
    side:          1,
    signatureType: SIGNATURE_TYPE,
  };

  const domain = negRisk ? ORDER_DOMAIN : ORDER_DOMAIN_BINARY;
  const signature = await wallet.signTypedData(domain, ORDER_TYPES, signData);

  const orderData = {
    ...signData,
    side: SIDE_SELL,
    salt: saltInt,
  };

  return { orderData, signature };
}

// ── Public API ────────────────────────────────────────────────────────────────
export class ClobClient {
  static _creds = null;
  static _signerAddress = null;
  static _wallet = null;
  static _takerFeeCache = new Map();

  /**
   * Initialise the client.
   * Prefer Polymarket's documented L1 -> L2 auth flow and derive credentials
   * from the signer on startup. If derivation fails and explicit credentials
   * were provided, fall back to those as a last resort.
   */
  static async init(wallet, { apiKey, secret, passphrase } = {}) {
    ClobClient._wallet = wallet;
    ClobClient._signerAddress = wallet.address;
    try {
      logger.info('CLOB: deriving API credentials via L1 auth…');
      ClobClient._creds = await ClobClient._deriveCredentials(wallet);
      logger.info('CLOB: credentials derived', { apiKey: ClobClient._creds.apiKey });
      return;
    } catch (err) {
      if (apiKey && secret && passphrase) {
        ClobClient._creds = { apiKey, secret, passphrase };
        logger.warn('CLOB: credential derivation failed, falling back to provided credentials', {
          err: err.message,
        });
        return;
      }
      throw err;
    }
  }

  static async refreshCredentials() {
    if (!ClobClient._wallet) {
      throw new Error('CLOB wallet not initialised — cannot refresh API credentials');
    }
    ClobClient._creds = await ClobClient._deriveCredentials(ClobClient._wallet);
    logger.info('CLOB: refreshed API credentials', { apiKey: ClobClient._creds.apiKey });
    return ClobClient._creds;
  }

  /** L1 auth: sign an EIP-712 auth message and POST to /auth/api-key */
  static async _deriveCredentials(wallet) {
    const ts    = Math.floor(Date.now() / 1000).toString();
    const nonce = 0;
    const authMsg = {
      address:   wallet.address,
      timestamp: ts,
      nonce,
      message:   'This message attests that I control the given wallet',
    };
    const sig = await wallet.signTypedData(AUTH_DOMAIN, AUTH_TYPES, authMsg);

    const headers = {
      // L1 auth also requires the EOA signer address, not the proxy wallet.
      'POLY_ADDRESS':   wallet.address,
      'POLY_SIGNATURE': sig,
      'POLY_TIMESTAMP': ts,
      'POLY_NONCE':     nonce.toString(),
      'Content-Type':   'application/json',
    };
    // Prefer deriving an existing key for nonce=0. Creating a new key fails
    // for wallets that already have credentials, which is the common case.
    try {
      const res = await axios.get(`${CLOB_API_URL}/auth/derive-api-key`, { headers });
      const { apiKey, secret, passphrase } = res.data;
      return { apiKey, secret, passphrase };
    } catch (err) {
      logger.warn('CLOB: derive-api-key failed, trying create-api-key', {
        status: err.response?.status,
        detail: err.response?.data,
      });
      const res = await axios.post(`${CLOB_API_URL}/auth/api-key`, {}, { headers });
      const { apiKey, secret, passphrase } = res.data;
      return { apiKey, secret, passphrase };
    }
  }

  /** Returns current API credentials (for WS auth). */
  static get creds() {
    return ClobClient._creds;
  }

  static async getTakerFeeBps(tokenId) {
    const cached = ClobClient._takerFeeCache.get(tokenId);
    if (cached !== undefined) return cached;

    try {
      const res = await axios.get(`${CLOB_API_URL}/fee-rate`, {
        params: { token_id: tokenId },
        timeout: 10_000,
      });
      const fee = String(res.data?.base_fee ?? 0);
      ClobClient._takerFeeCache.set(tokenId, fee);
      return fee;
    } catch (err) {
      logger.warn('CLOB: fee-rate endpoint failed, falling back to Gamma', {
        tokenId,
        status: err.response?.status,
        detail: err.response?.data,
      });
      const res = await axios.get(`${GAMMA_API_URL}/markets?clob_token_ids=${tokenId}`, {
        timeout: 10_000,
      });
      const market = res.data?.[0];
      const fee = String(market?.takerBaseFee ?? 0);
      ClobClient._takerFeeCache.set(tokenId, fee);
      return fee;
    }
  }

  static feeRateBpsToDecimal(feeRateBps) {
    const bps = Number(feeRateBps ?? 0);
    return Number.isFinite(bps) ? (bps / 10_000) : 0;
  }

  static estimateTakerFeeUsdc({ shares, price, feeRateBps }) {
    const size = Number(shares ?? 0);
    const p = Number(price ?? 0);
    const rate = ClobClient.feeRateBpsToDecimal(feeRateBps);
    if (!Number.isFinite(size) || !Number.isFinite(p) || !Number.isFinite(rate)) return 0;
    if (size <= 0 || p <= 0 || p >= 1 || rate <= 0) return 0;

    const rawFee = size * rate * p * (1 - p);
    const rounded = Math.round(rawFee * 100_000) / 100_000;
    return rounded >= 0.00001 ? rounded : 0;
  }

  static async estimateTokenTakerFeeUsdc(tokenId, shares, price) {
    const feeRateBps = await ClobClient.getTakerFeeBps(tokenId);
    return {
      feeRateBps: Number(feeRateBps ?? 0),
      estimatedFee: ClobClient.estimateTakerFeeUsdc({ shares, price, feeRateBps }),
    };
  }

  /**
   * Session keep-alive for resting orders (GTC ladder).
   * @see https://docs.polymarket.com/api-reference/trade/send-heartbeat
   */
  static async sendHeartbeat() {
    await restCall('POST', '/heartbeats', {});
  }

  // ── Order book ──────────────────────────────────────────────────────────────

  /**
   * Fetch full order book for a token.
   * Returns:
   *   { bids, asks, tickSize, minOrderSize }
   *
   * tickSize    – minimum price increment (e.g. 0.01). Prices MUST conform or
   *               the CLOB rejects the order with INVALID_ORDER_MIN_TICK_SIZE.
   * minOrderSize – minimum order size in USDC (typically 5).
   */
  static async getBook(tokenId, { quietNotFound = false } = {}) {
    const raw = await restCall(
      'GET',
      `/book?token_id=${tokenId}`,
      null,
      false,
      quietNotFound ? { quietStatuses: [404] } : {},
    );
    return {
      bids:         (raw.bids ?? []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
      asks:         (raw.asks ?? []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
      tickSize:     parseFloat(raw.tick_size    ?? '0.01'),
      minOrderSize: parseFloat(raw.min_order_size ?? '5'),
    };
  }

  /**
   * Returns the best ask AND the market's tick size for a token.
   * { price, size, tickSize, minOrderSize } or null if no liquidity.
   */
  static async getBestAsk(tokenId) {
    const book = await ClobClient.getBook(tokenId);
    const best = book.asks.length
      ? book.asks.reduce((a, b) => (a.price <= b.price ? a : b))
      : null;
    if (!best) return null;
    return { ...best, tickSize: book.tickSize, minOrderSize: book.minOrderSize };
  }

  static estimateMarketBuyFillFromBook(book, maxPrice, amountUsdc, feeRateBps = 0) {
    const asks = Array.isArray(book?.asks) ? [...book.asks] : [];
    const max = Number(maxPrice ?? 0);
    let remainingUsdc = Number(amountUsdc ?? 0);
    if (!Number.isFinite(max) || !Number.isFinite(remainingUsdc) || max <= 0 || remainingUsdc <= 0) {
      return null;
    }

    asks.sort((a, b) => a.price - b.price);
    const eligible = asks.filter((ask) =>
      Number.isFinite(ask.price) &&
      Number.isFinite(ask.size) &&
      ask.price > 0 &&
      ask.size > 0 &&
      ask.price <= max
    );

    const bestAsk = eligible[0]?.price ?? asks[0]?.price ?? null;
    let filledShares = 0;
    let spentUsdc = 0;
    let estimatedFeeUsdc = 0;
    const fills = [];

    for (const ask of eligible) {
      if (remainingUsdc <= 0) break;
      const levelNotional = ask.price * ask.size;
      if (levelNotional <= remainingUsdc) {
        const levelFeeUsdc = ClobClient.estimateTakerFeeUsdc({
          shares: ask.size,
          price: ask.price,
          feeRateBps,
        });
        filledShares += ask.size;
        spentUsdc += levelNotional;
        estimatedFeeUsdc += levelFeeUsdc;
        fills.push({
          price: ask.price,
          shares: ask.size,
          spentUsdc: levelNotional,
          feeUsdc: levelFeeUsdc,
        });
        remainingUsdc -= levelNotional;
        continue;
      }

      const partialShares = remainingUsdc / ask.price;
      const partialSpentUsdc = partialShares * ask.price;
      const partialFeeUsdc = ClobClient.estimateTakerFeeUsdc({
        shares: partialShares,
        price: ask.price,
        feeRateBps,
      });
      filledShares += partialShares;
      spentUsdc += partialSpentUsdc;
      estimatedFeeUsdc += partialFeeUsdc;
      fills.push({
        price: ask.price,
        shares: partialShares,
        spentUsdc: partialSpentUsdc,
        feeUsdc: partialFeeUsdc,
      });
      remainingUsdc = 0;
      break;
    }

    const avgFillPrice = filledShares > 0 ? (spentUsdc / filledShares) : null;
    return {
      bestAsk,
      avgFillPrice,
      fillShares: filledShares,
      spentUsdc,
      unfilledUsdc: remainingUsdc,
      fullyFilled: remainingUsdc <= 0.000001,
      askLevelsConsidered: eligible.length,
      feeRateBps: Number(feeRateBps ?? 0),
      estimatedFeeUsdc,
      fills,
    };
  }

  static async estimateMarketBuyFill(tokenId, maxPrice, amountUsdc) {
    const [book, feeRateBps] = await Promise.all([
      ClobClient.getBook(tokenId),
      ClobClient.getTakerFeeBps(tokenId),
    ]);
    return ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, amountUsdc, feeRateBps);
  }

  // ── Order management ────────────────────────────────────────────────────────

  /**
   * Post a GTC limit BUY order to the CLOB.
   * @param {boolean} negRisk - true for Neg Risk markets, false for standard binary markets
   * Returns the orderId string, or throws on rejection.
   */
  static async postLimitBuy(wallet, tokenId, price, shares, negRisk = true) {
    const feeRateBps = await ClobClient.getTakerFeeBps(tokenId);
    const { tickSize } = await ClobClient.getBook(tokenId);
    const { orderData, signature } = await buildLimitBuyOrder(
      wallet, tokenId, price, shares, 0, negRisk, feeRateBps, tickSize,
    );
    const body = {
      order: { ...orderData, signature },
      owner:     ClobClient._creds.apiKey,  // API key UUID, not proxy wallet
      orderType: 'GTC',
    };
    const path = '/order';
    const res  = await restCall('POST', path, body);
    if (!res.success) throw new Error(`Order rejected: ${res.errorMsg ?? JSON.stringify(res)}`);
    logger.debug('CLOB: limit buy posted', { tokenId, price, shares, orderId: res.orderId });
    return res.orderId;
  }

  static async postFOKLimitBuy(wallet, tokenId, price, shares, negRisk = true) {
    const feeRateBps = await ClobClient.getTakerFeeBps(tokenId);
    const { tickSize } = await ClobClient.getBook(tokenId);
    const { orderData, signature } = await buildLimitBuyOrder(
      wallet, tokenId, price, shares, 0, negRisk, feeRateBps, tickSize,
    );
    const body = {
      order: { ...orderData, signature },
      owner: ClobClient._creds.apiKey,
      orderType: 'FOK',
    };
    const path = '/order';
    const res = await restCall('POST', path, body);
    if (res.success === false) {
      logger.warn('CLOB: FOK limit buy rejected', { tokenId, price, shares, errorMsg: res.errorMsg, status: res.status });
    } else {
      logger.debug('CLOB: FOK limit buy posted', { tokenId, price, shares, status: res.status });
    }
    return res;
  }

  static async postLimitSell(wallet, tokenId, price, shares, negRisk = true) {
    const feeRateBps = await ClobClient.getTakerFeeBps(tokenId);
    const { tickSize } = await ClobClient.getBook(tokenId);
    const { orderData, signature } = await buildMarketSellOrder(
      wallet, tokenId, price, shares, 0, negRisk, feeRateBps, tickSize,
    );
    const body = {
      order: { ...orderData, signature },
      owner: ClobClient._creds.apiKey,
      orderType: 'GTC',
    };
    const path = '/order';
    const res = await restCall('POST', path, body);
    if (!res.success) throw new Error(`Order rejected: ${res.errorMsg ?? JSON.stringify(res)}`);
    logger.debug('CLOB: limit sell posted', { tokenId, price, shares, orderId: res.orderId });
    return res.orderId;
  }

  /**
   * Post a FAK (Fill-And-Kill) BUY order.
   *
   * FAK is the correct "IOC" type on Polymarket:
   *   – Fills as many shares as available immediately at or below maxPrice.
   *   – Any unfilled remainder is cancelled (never rests on the book).
   *
   * Use this for copy-trade buys and any taker order where a partial fill
   * is acceptable.
   *
   * @param {boolean} negRisk - true for Neg Risk markets, false for standard binary markets
   */
  static async postIOCBuy(wallet, tokenId, maxPrice, amountUsdc, negRisk = true) {
    const feeRateBps = await ClobClient.getTakerFeeBps(tokenId);
    const { tickSize } = await ClobClient.getBook(tokenId);
    const { orderData, signature } = await buildMarketBuyOrder(
      wallet, tokenId, maxPrice, amountUsdc, 0, negRisk, feeRateBps, tickSize,
    );
    const body = {
      order: { ...orderData, signature },
      owner:     ClobClient._creds.apiKey,  // API key UUID, not proxy wallet
      orderType: 'FAK',
    };
    const path = '/order';
    const res  = await restCall('POST', path, body);
    if (res.success === false) {
      logger.warn('CLOB: FAK buy rejected', { tokenId, errorMsg: res.errorMsg, status: res.status });
    } else {
      logger.debug('CLOB: FAK buy posted', { tokenId, maxPrice, amountUsdc, status: res.status });
    }
    return res;
  }

  /**
   * Post a FOK (Fill-Or-Kill) BUY order.
   *
   * The entire order must fill immediately and completely, or the whole
   * thing is cancelled. Use this when an all-or-nothing fill is required
   * (e.g. arb bot needs both legs to fill equally to stay delta-neutral).
   *
   * @param {boolean} negRisk - true for Neg Risk markets, false for standard binary markets
   */
  static async postFOKBuy(wallet, tokenId, maxPrice, amountUsdc, negRisk = true) {
    const feeRateBps = await ClobClient.getTakerFeeBps(tokenId);
    const { tickSize } = await ClobClient.getBook(tokenId);
    const { orderData, signature } = await buildMarketBuyOrder(
      wallet, tokenId, maxPrice, amountUsdc, 0, negRisk, feeRateBps, tickSize,
    );
    const body = {
      order: { ...orderData, signature },
      owner:     ClobClient._creds.apiKey,  // API key UUID, not proxy wallet
      orderType: 'FOK',
    };
    const path = '/order';
    const res  = await restCall('POST', path, body);
    if (res.success === false) {
      logger.warn('CLOB: FOK buy rejected', { tokenId, errorMsg: res.errorMsg, status: res.status });
    } else {
      logger.debug('CLOB: FOK buy posted', { tokenId, maxPrice, amountUsdc, status: res.status });
    }
    return res;
  }

  static async postFOKSell(wallet, tokenId, minPrice, shares, negRisk = true) {
    const feeRateBps = await ClobClient.getTakerFeeBps(tokenId);
    const { tickSize } = await ClobClient.getBook(tokenId);
    const { orderData, signature } = await buildMarketSellOrder(
      wallet, tokenId, minPrice, shares, 0, negRisk, feeRateBps, tickSize,
    );
    const body = {
      order: { ...orderData, signature },
      owner:     ClobClient._creds.apiKey,
      orderType: 'FOK',
    };
    const path = '/order';
    const res  = await restCall('POST', path, body);
    if (res.success === false) {
      logger.warn('CLOB: FOK sell rejected', { tokenId, errorMsg: res.errorMsg, status: res.status });
    } else {
      logger.debug('CLOB: FOK sell posted', { tokenId, minPrice, shares, status: res.status });
    }
    return res;
  }

  /**
   * Cancel a single order by orderId.
   */
  static async cancelOrder(orderId) {
    const path = `/order/${orderId}`;
    const res  = await restCall('DELETE', path);
    logger.debug('CLOB: order cancelled', { orderId });
    return res;
  }

  /**
   * Cancel all open orders for this wallet.
   */
  static async cancelAll() {
    const path = '/orders';
    const res  = await restCall('DELETE', path);
    logger.info('CLOB: all orders cancelled');
    return res;
  }

  /**
   * Cancel all open orders for a specific market (conditionId).
   */
  static async cancelMarket(conditionId) {
    const path = `/orders/cancel/market`;
    const res  = await restCall('DELETE', path, { market: conditionId });
    logger.debug('CLOB: market orders cancelled', { conditionId });
    return res;
  }

  /**
   * Get all open orders for this wallet on a market.
   * Returns array of order objects with { id, tokenId, price, size, side }.
   */
  static async getOpenOrders(conditionId) {
    const path = `/orders?market=${conditionId}&maker_address=${PROXY_WALLET}`;
    const res  = await restCall('GET', path);
    return res ?? [];
  }
}

// ── WebSocket book feed ───────────────────────────────────────────────────────
/**
 * BookFeed subscribes to real-time order book updates for a pair of tokenIds.
 * Maintains an in-memory best-ask for each token. Wire format follows Polymarket
 * market channel docs (book, price_change / price_changes, best_bid_ask,
 * last_trade_price, tick_size_change).
 * Emits:
 *   'snapshot'   ({tokenId, bids, asks})  – initial full book
 *   'update'     ({tokenId, bestAsk})     – whenever best ask changes
 *   'trade'      ({tokenId, price, size}) – public trade / last_trade_price
 *   'error'      (err)
 *   'close'      ()
 */
export class BookFeed extends EventEmitter {
  constructor(tokenIds) {
    super();
    this.tokenIds = tokenIds;
    this.bestAsks = {};   // tokenId → { price, size }
    this._ws = null;
    this._reconnectDelay = 1000;
    this._closed = false;
  }

  start() {
    this._connect();
  }

  stop() {
    this._closed = true;
    this._ws?.close();
  }

  getBestAsk(tokenId) {
    return this.bestAsks[tokenId] ?? null;
  }

  _connect() {
    if (this._closed) return;
    const ws = new WebSocket(CLOB_WS_URL + 'market');
    this._ws = ws;

    ws.on('open', () => {
      logger.debug('BookFeed: WS connected, subscribing', { tokenIds: this.tokenIds });
      ws.send(JSON.stringify({
        type:                   'market',
        assets_ids:             this.tokenIds,
        custom_feature_enabled: true, // enables best_bid_ask, new_market, market_resolved events
      }));
      this._reconnectDelay = 1000; // reset backoff on successful connect
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleMessage(msg);
      } catch (e) {
        logger.warn('BookFeed: parse error', { err: e.message });
      }
    });

    ws.on('error', (err) => {
      logger.error('BookFeed: WS error', { err: err.message });
      this.emit('error', err);
    });

    ws.on('close', () => {
      if (!this._closed) {
        logger.warn(`BookFeed: WS closed, reconnecting in ${this._reconnectDelay}ms`);
        setTimeout(() => {
          this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30_000);
          this._connect();
        }, this._reconnectDelay);
      } else {
        this.emit('close');
      }
    });
  }

  _handleMessage(msg) {
    const { event_type, asset_id } = msg;
    const eventTimeMs = (() => {
      const candidates = [msg.timestamp, msg.time, msg.created_at, msg.last_updated_at];
      for (const candidate of candidates) {
        const asNumber = Number(candidate);
        if (Number.isFinite(asNumber) && asNumber > 0) {
          return asNumber > 1e12 ? asNumber : asNumber * 1000;
        }
        const parsed = Date.parse(String(candidate ?? ''));
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return Date.now();
    })();

    if (event_type === 'book') {
      const tid = asset_id ?? msg.asset_id;
      const asks = (msg.asks ?? []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));
      const bids = (msg.bids ?? []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
      this.emit('snapshot', { tokenId: tid, bids, asks });
      const best = this._bestAsk(asks);
      if (best && tid) {
        this.bestAsks[tid] = best;
        this.emit('update', { tokenId: tid, bestAsk: best });
      }
      return;
    }

    if (event_type === 'price_change') {
      // Current wire format: `price_changes[]` per asset + best_bid/best_ask hints.
      // Legacy: `changes[]` scoped to top-level `asset_id`.
      const rows = msg.price_changes ?? msg.changes ?? [];
      const legacyAssetId = asset_id;

      for (const c of rows) {
        const aid = c.asset_id ?? legacyAssetId;
        if (!aid) continue;

        const bestAskRaw = c.best_ask;
        if (
          c.side === 'SELL' &&
          bestAskRaw !== undefined &&
          bestAskRaw !== '' &&
          bestAskRaw !== '0'
        ) {
          const bestAsk = parseFloat(bestAskRaw);
          if (!isNaN(bestAsk) && bestAsk > 0) {
            const cur = this.bestAsks[aid];
            if (!cur || Math.abs(cur.price - bestAsk) > 1e-9) {
              this.bestAsks[aid] = { price: bestAsk, size: cur?.size ?? 0 };
              this.emit('update', { tokenId: aid, bestAsk: this.bestAsks[aid] });
            }
            continue;
          }
        }

        if (c.side !== 'SELL') continue;
        const price = parseFloat(c.price);
        const size = parseFloat(c.size);
        const cur = this.bestAsks[aid];

        if (size === 0 && cur && Math.abs(cur.price - price) < 1e-9) {
          this._refreshBestAsk(aid);
        } else if (!cur || price < cur.price || (Math.abs(price - cur.price) < 1e-9 && size !== cur.size)) {
          this.bestAsks[aid] = { price, size };
          this.emit('update', { tokenId: aid, bestAsk: { price, size } });
        }
      }
      return;
    }

    if (event_type === 'tick_size_change') {
      const tid = asset_id ?? msg.asset_id;
      logger.debug('BookFeed: tick_size_change', {
        tokenId: tid,
        oldTick: msg.old_tick_size,
        newTick: msg.new_tick_size,
      });
      if (tid) this._refreshBestAsk(tid);
      return;
    }

    if (event_type === 'best_bid_ask') {
      const tid = asset_id ?? msg.asset_id;
      const bestAsk = parseFloat(msg.best_ask);
      if (!tid || isNaN(bestAsk) || bestAsk <= 0) return;
      const cur = this.bestAsks[tid];
      if (!cur || Math.abs(cur.price - bestAsk) > 1e-9) {
        this.bestAsks[tid] = { price: bestAsk, size: cur?.size ?? 0 };
        this.emit('update', { tokenId: tid, bestAsk: this.bestAsks[tid] });
      }
      return;
    }

    if (event_type === 'last_trade_price') {
      const tid = asset_id ?? msg.asset_id;
      if (tid) {
        this.emit('trade', {
          tokenId: tid,
          price: parseFloat(msg.price),
          size: parseFloat(msg.size),
          side: msg.side ?? msg.taker_side ?? null,
          timeMs: eventTimeMs,
        });
      }
      return;
    }

    if (event_type === 'trade') {
      const tid = asset_id ?? msg.asset_id;
      if (tid) {
        this.emit('trade', {
          tokenId: tid,
          price: parseFloat(msg.price),
          size: parseFloat(msg.size),
          side: msg.side ?? msg.taker_side ?? null,
          timeMs: eventTimeMs,
        });
      }
    }
  }

  _bestAsk(asks) {
    if (!asks.length) return null;
    return asks.reduce((a, b) => (a.price <= b.price ? a : b));
  }

  async _refreshBestAsk(tokenId) {
    try {
      const best = await ClobClient.getBestAsk(tokenId);
      if (best) {
        this.bestAsks[tokenId] = best;
        this.emit('update', { tokenId, bestAsk: best });
      }
    } catch (e) {
      logger.warn('BookFeed: refresh best ask failed', { tokenId, err: e.message });
    }
  }
}

// ── User fill WebSocket ───────────────────────────────────────────────────────
/**
 * FillFeed subscribes to user-level fill events.
 * Emits 'fill' events: { tokenId, price, size, side, orderId, matchedAt }
 */
export class FillFeed extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._closed = false;
  }

  start() {
    this._connect();
  }

  stop() {
    this._closed = true;
    this._ws?.close();
  }

  _connect() {
    if (this._closed) return;
    const creds = ClobClient.creds;
    if (!creds) throw new Error('FillFeed: CLOB not initialised');

    const ws = new WebSocket(CLOB_WS_URL + 'user');
    this._ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        auth: {
          apiKey:     creds.apiKey,
          secret:     creds.secret,
          passphrase: creds.passphrase,
        },
        markets: [],
        type: 'user',
      }));
      logger.debug('FillFeed: user WS connected');
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.event_type === 'trade' || msg.type === 'TRADE') {
          this.emit('fill', {
            tokenId:   msg.asset_id,
            price:     parseFloat(msg.price),
            size:      parseFloat(msg.size),
            side:      msg.side,
            orderId:   msg.id ?? msg.orderId,
            matchedAt: msg.timestamp,
          });
        }
      } catch { /* ignore */ }
    });

    ws.on('error', (err) => logger.error('FillFeed: error', { err: err.message }));
    ws.on('close', () => {
      if (!this._closed) {
        setTimeout(() => this._connect(), 2000);
      }
    });
  }
}
