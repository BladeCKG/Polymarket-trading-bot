import {
  BEAT_BOOK_POLL_MS,
  BEAT_BOOK_MAX_AGE_MS,
  BEAT_BUY_COOLDOWN_MS,
  BEAT_PROBABILITY_ENABLED,
  BEAT_PROBABILITY_HISTORY_MS,
  BEAT_PROBABILITY_REQUIRED_EDGE,
  BEAT_PROBABILITY_PAIR_COST_MAX,
  BEAT_PROBABILITY_VOL_LAMBDA,
  BEAT_PROBABILITY_VOL_MAX_JUMP_RATIO,
  BEAT_PROBABILITY_VOL_MIN_BPS,
  BEAT_PROBABILITY_DRIFT_SHRINK,
  BEAT_PROBABILITY_OFI_WEIGHT,
  BEAT_PROBABILITY_CONFIDENCE,
  BEAT_PROBABILITY_MIN,
  BEAT_PROBABILITY_MAX,
  BEAT_PAIR_COMPLETION_ENABLED,
  BEAT_PAIR_COMPLETION_MIN_PROBABILITY,
  BEAT_PAIR_COMPLETION_DRIFT_SHRINK,
  BEAT_ARB_PAIR_ENABLED,
  BEAT_ARB_PAIR_COST_MAX,
  BEAT_DASHBOARD_ENABLED,
  BEAT_DASHBOARD_HOST,
  BEAT_DASHBOARD_PORT,
  BEAT_DRY_RUN,
  BEAT_EXCHANGES,
  BEAT_HUB_TRADE_WINDOW_MS,
  BEAT_HUB_PRICE_HISTORY_MS,
  BEAT_HUB_MAX_TICK_AGE_MS,
  BEAT_HUB_OUTLIER_BPS,
  BEAT_MODEL_MOMENTUM_WEIGHT,
  BEAT_MODEL_OBI_WEIGHT,
  BEAT_MODEL_CVD_WEIGHT,
  BEAT_MODEL_MICROPRICE_WEIGHT,
  BEAT_MODEL_DRIFT_Z_SCALE,
  BEAT_MODEL_MARKET_PRIOR_WEIGHT,
  BEAT_ENTRY_DELAY_SECONDS,
  BEAT_STOP_BUYING_BEFORE_CLOSE_SECONDS,
  BEAT_MIN_HISTORY_MS,
  BEAT_SIDE_MAX_ASK,
  BEAT_SIDE_MIN_ASK,
  BEAT_EDGE_PERSISTENCE_SNAPSHOTS,
  BEAT_ARB_PAIR_LOSS_ESCALATION_ENABLED,
  BEAT_ARB_PAIR_ARCTAN_GAIN_MIN,
  BEAT_ARB_PAIR_ARCTAN_GAIN_MAX,
  BEAT_FILL_CONFIRM_TIMEOUT_MS,
  BEAT_SYMBOLS,
  BEAT_MAX_SLIPPAGE,
  BEAT_MAX_INVENTORY_IMBALANCE_SHARES,
  BEAT_OFI_ENABLED,
  BEAT_OFI_WINDOW_MS,
  BEAT_OFI_TOXICITY_THRESHOLD,
  BEAT_OFI_RATIO_ENTER,
  BEAT_OFI_RATIO_EXIT,
  BEAT_OFI_EXIT_RATIO,
  BEAT_ORDER_MODE,
  BEAT_MIN_BUY_SHARES,
  BEAT_MIN_BUY_USDC,
  BEAT_ORDER_SIZE_SHARES,
  BEAT_ORDER_SIZE_USDC,
  BTC_PRICE_MAX_AGE_MS,
  BTC_PRICE_STALL_RECONNECT_MS,
  MAX_SPEND_PER_MARKET,
  MARKET_WINDOW_SECONDS,
  REDEEM_DELAY_AFTER_CLOSE,
} from '../config.js';

const DEFAULTS = Object.freeze({
  BEAT_SYMBOLS,
  BTC_PRICE_MAX_AGE_MS,
  BTC_PRICE_STALL_RECONNECT_MS,
  MARKET_WINDOW_SECONDS,
  REDEEM_DELAY_AFTER_CLOSE,
  BEAT_DRY_RUN,
  BEAT_BOOK_POLL_MS,
  BEAT_BOOK_MAX_AGE_MS,
  BEAT_BUY_COOLDOWN_MS,
  BEAT_PROBABILITY_ENABLED,
  BEAT_PROBABILITY_HISTORY_MS,
  BEAT_PROBABILITY_REQUIRED_EDGE,
  BEAT_PROBABILITY_PAIR_COST_MAX,
  BEAT_PROBABILITY_VOL_LAMBDA,
  BEAT_PROBABILITY_VOL_MAX_JUMP_RATIO,
  BEAT_PROBABILITY_VOL_MIN_BPS,
  BEAT_PROBABILITY_DRIFT_SHRINK,
  BEAT_PROBABILITY_OFI_WEIGHT,
  BEAT_PROBABILITY_CONFIDENCE,
  BEAT_PROBABILITY_MIN,
  BEAT_PROBABILITY_MAX,
  BEAT_PAIR_COMPLETION_ENABLED,
  BEAT_PAIR_COMPLETION_MIN_PROBABILITY,
  BEAT_PAIR_COMPLETION_DRIFT_SHRINK,
  BEAT_ARB_PAIR_ENABLED,
  BEAT_ARB_PAIR_COST_MAX,
  BEAT_EXCHANGES,
  BEAT_HUB_TRADE_WINDOW_MS,
  BEAT_HUB_PRICE_HISTORY_MS,
  BEAT_HUB_MAX_TICK_AGE_MS,
  BEAT_HUB_OUTLIER_BPS,
  BEAT_MODEL_MOMENTUM_WEIGHT,
  BEAT_MODEL_OBI_WEIGHT,
  BEAT_MODEL_CVD_WEIGHT,
  BEAT_MODEL_MICROPRICE_WEIGHT,
  BEAT_MODEL_DRIFT_Z_SCALE,
  BEAT_MODEL_MARKET_PRIOR_WEIGHT,
  BEAT_ENTRY_DELAY_SECONDS,
  BEAT_STOP_BUYING_BEFORE_CLOSE_SECONDS,
  BEAT_MIN_HISTORY_MS,
  BEAT_SIDE_MAX_ASK,
  BEAT_SIDE_MIN_ASK,
  BEAT_ARB_PAIR_LOSS_ESCALATION_ENABLED,
  BEAT_ARB_PAIR_ARCTAN_GAIN_MIN,
  BEAT_ARB_PAIR_ARCTAN_GAIN_MAX,
  BEAT_FILL_CONFIRM_TIMEOUT_MS,
  BEAT_EDGE_PERSISTENCE_SNAPSHOTS,
  BEAT_ORDER_MODE,
  BEAT_MIN_BUY_USDC,
  BEAT_MIN_BUY_SHARES,
  BEAT_ORDER_SIZE_USDC,
  BEAT_ORDER_SIZE_SHARES,
  BEAT_MAX_SLIPPAGE,
  BEAT_MAX_INVENTORY_IMBALANCE_SHARES,
  BEAT_OFI_ENABLED,
  BEAT_OFI_WINDOW_MS,
  BEAT_OFI_TOXICITY_THRESHOLD,
  BEAT_OFI_RATIO_ENTER,
  BEAT_OFI_RATIO_EXIT,
  BEAT_OFI_EXIT_RATIO,
  MAX_SPEND_PER_MARKET,
  BEAT_DASHBOARD_ENABLED,
  BEAT_DASHBOARD_HOST,
  BEAT_DASHBOARD_PORT,
});

const SUPPORTED_BEAT_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE']);

function normalizeBeatSymbols(value, fallback) {
  const rawList = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? (() => {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // ignore JSON parse errors and fall back to split parsing
      }
      return value.split(/[,\s]+/).filter(Boolean);
    })() : []);
  const normalized = rawList
    .map((item) => String(item ?? '').trim().toUpperCase())
    .filter((item) => SUPPORTED_BEAT_SYMBOLS.has(item));
  return normalized.length ? [...new Set(normalized)] : fallback;
}

function coerceValue(key, value) {
  const fallback = DEFAULTS[key];
  if (fallback === undefined) return undefined;

  if (key === 'BEAT_SYMBOLS') {
    return normalizeBeatSymbols(value, fallback);
  }

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

  // Arrays — accept JSON string or array value
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
