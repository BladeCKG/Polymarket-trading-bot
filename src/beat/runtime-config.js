import {
  BEAT_BOOK_POLL_MS,
  BEAT_BUY_COOLDOWN_MS,
  BEAT_DASHBOARD_ENABLED,
  BEAT_DASHBOARD_HOST,
  BEAT_DASHBOARD_PORT,
  BEAT_DRY_RUN,
  BEAT_MOMENTS,
  BEAT_MAX_SLIPPAGE,
  BEAT_MARKET_SYMBOL,
  BEAT_ORDER_MODE,
  BEAT_ORDER_SIZE_SHARES,
  BEAT_ORDER_SIZE_USDC,
  BTC_PRICE_MAX_AGE_MS,
  BTC_PRICE_PRODUCT_ID,
  BTC_PRICE_REST_URL,
  BTC_PRICE_WS_URL,
  MAX_INVENTORY_IMBALANCE,
  MAX_SPEND_PER_MARKET,
  MARKET_WINDOW_SECONDS,
  REDEEM_DELAY_AFTER_CLOSE,
} from '../config.js';

const DEFAULTS = Object.freeze({
  BEAT_MARKET_SYMBOL,
  BTC_PRICE_WS_URL,
  BTC_PRICE_PRODUCT_ID,
  BTC_PRICE_REST_URL,
  BTC_PRICE_MAX_AGE_MS,
  MARKET_WINDOW_SECONDS,
  REDEEM_DELAY_AFTER_CLOSE,
  BEAT_DRY_RUN,
  BEAT_BOOK_POLL_MS,
  BEAT_BUY_COOLDOWN_MS,
  BEAT_ORDER_MODE,
  BEAT_ORDER_SIZE_USDC,
  BEAT_ORDER_SIZE_SHARES,
  BEAT_MAX_SLIPPAGE,
  BEAT_MOMENTS,
  MAX_INVENTORY_IMBALANCE,
  MAX_SPEND_PER_MARKET,
  BEAT_DASHBOARD_ENABLED,
  BEAT_DASHBOARD_HOST,
  BEAT_DASHBOARD_PORT,
});

function coerceValue(key, value) {
  const fallback = DEFAULTS[key];
  if (fallback === undefined) return undefined;

  if (typeof fallback === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return /^(1|true|yes|on)$/i.test(value);
    }
    return Boolean(value);
  }

  if (typeof fallback === 'number') {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  // Arrays (e.g., BEAT_MOMENTS) — accept JSON string or array value
  if (Array.isArray(fallback)) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch (err) {
        return fallback;
      }
    }
    return fallback;
  }

  if (key === 'BEAT_ORDER_MODE') {
    const text = String(value ?? '').trim().toUpperCase();
    return text === 'SHARES' ? 'SHARES' : 'USDC';
  }

  if (key === 'BEAT_MARKET_SYMBOL') {
    const text = String(value ?? '').trim().toUpperCase();
    return text === 'ETH' ? 'ETH' : 'BTC';
  }

  return String(value ?? fallback);
}

function priceFeedDefaultsFor(symbol) {
  return String(symbol ?? '').trim().toUpperCase() === 'ETH'
    ? {
        BTC_PRICE_WS_URL: 'wss://stream.binance.com:9443/ws/ethusdt@ticker',
        BTC_PRICE_PRODUCT_ID: 'ETHUSDT',
        BTC_PRICE_REST_URL: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT',
      }
    : {
        BTC_PRICE_WS_URL: 'wss://stream.binance.com:9443/ws/btcusdt@ticker',
        BTC_PRICE_PRODUCT_ID: 'BTCUSDT',
        BTC_PRICE_REST_URL: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
      };
}

export function createBeatRuntimeConfig(overrides = {}) {
  const next = {
    ...DEFAULTS,
    ...Object.fromEntries(
      Object.entries(overrides)
        .filter(([key]) => key in DEFAULTS)
        .map(([key, value]) => [key, coerceValue(key, value)]),
    ),
  };

  const feedDefaults = priceFeedDefaultsFor(next.BEAT_MARKET_SYMBOL);
  for (const [key, value] of Object.entries(feedDefaults)) {
    if (!(key in overrides)) {
      next[key] = value;
    }
  }

  return next;
}

export function applyBeatRuntimeConfigPatch(target, patch = {}) {
  if (!target || typeof target !== 'object') return target;
  const marketSymbolChanged = Object.prototype.hasOwnProperty.call(patch, 'BEAT_MARKET_SYMBOL');
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    target[key] = coerceValue(key, value);
  }
  if (marketSymbolChanged) {
    const feedDefaults = priceFeedDefaultsFor(target.BEAT_MARKET_SYMBOL);
    for (const [key, value] of Object.entries(feedDefaults)) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) {
        target[key] = value;
      }
    }
  }
  return target;
}

export function getBeatRuntimeConfigDefaults() {
  return { ...DEFAULTS };
}
