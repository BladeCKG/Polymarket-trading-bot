import {
  BEAT_BOOK_POLL_MS,
  BEAT_BUY_COOLDOWN_MS,
  BEAT_DASHBOARD_ENABLED,
  BEAT_DASHBOARD_HOST,
  BEAT_DASHBOARD_PORT,
  BEAT_DRY_RUN,
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
  BTC_PRICE_PRODUCT_ID,
  BTC_PRICE_REST_URL,
  BTC_PRICE_WS_URL,
  MAX_INVENTORY_IMBALANCE,
  MAX_SPEND_PER_MARKET,
  MARKET_WINDOW_SECONDS,
  REDEEM_DELAY_AFTER_CLOSE,
  STOP_BUYING_BEFORE_CLOSE,
} from '../config.js';

const DEFAULTS = Object.freeze({
  BTC_PRICE_WS_URL,
  BTC_PRICE_PRODUCT_ID,
  BTC_PRICE_REST_URL,
  BTC_PRICE_MAX_AGE_MS,
  MARKET_WINDOW_SECONDS,
  REDEEM_DELAY_AFTER_CLOSE,
  STOP_BUYING_BEFORE_CLOSE,
  BEAT_DRY_RUN,
  BEAT_ENTRY_DELAY_SECONDS,
  BEAT_BOOK_POLL_MS,
  BEAT_BUY_COOLDOWN_MS,
  BEAT_ORDER_MODE,
  BEAT_ORDER_SIZE_USDC,
  BEAT_ORDER_SIZE_SHARES,
  BEAT_MAX_SLIPPAGE,
  BEAT_UP_MOVE_MIN_USD,
  BEAT_UP_MOVE_MAX_USD,
  BEAT_DOWN_MOVE_MIN_USD,
  BEAT_DOWN_MOVE_MAX_USD,
  BEAT_UP_MAX_BUY_PRICE,
  BEAT_DOWN_MAX_BUY_PRICE,
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

  if (key === 'BEAT_ORDER_MODE') {
    const text = String(value ?? '').trim().toUpperCase();
    return text === 'SHARES' ? 'SHARES' : 'USDC';
  }

  return String(value ?? fallback);
}

export function createBeatRuntimeConfig(overrides = {}) {
  return {
    ...DEFAULTS,
    ...Object.fromEntries(
      Object.entries(overrides)
        .filter(([key]) => key in DEFAULTS)
        .map(([key, value]) => [key, coerceValue(key, value)]),
    ),
  };
}

export function applyBeatRuntimeConfigPatch(target, patch = {}) {
  if (!target || typeof target !== 'object') return target;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    target[key] = coerceValue(key, value);
  }
  return target;
}

export function getBeatRuntimeConfigDefaults() {
  return { ...DEFAULTS };
}
