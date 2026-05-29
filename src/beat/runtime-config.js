import {
  BEAT_BOOK_POLL_MS,
  BEAT_BOOK_MAX_AGE_MS,
  BEAT_BUY_COOLDOWN_MS,
  BEAT_PROBABILITY_ENABLED,
  BEAT_PROBABILITY_HISTORY_MS,
  BEAT_PROBABILITY_REQUIRED_EDGE,
  BEAT_PROBABILITY_PAIR_COST_MAX,
  BEAT_ARB_PAIR_ENABLED,
  BEAT_ARB_PAIR_COST_MAX,
  BEAT_ARB_PAIR_REQUIRED_EDGE,
  BEAT_TREND_MIN_PROBABILITY,
  BEAT_TREND_MIN_SIGNAL_SCORE,
  BEAT_DASHBOARD_ENABLED,
  BEAT_DASHBOARD_HOST,
  BEAT_DASHBOARD_PORT,
  BEAT_DRY_RUN,
  BEAT_MOMENTS_BNB,
  BEAT_MOMENTS_BTC,
  BEAT_MOMENTS_DOGE,
  BEAT_MOMENTS_ETH,
  BEAT_MOMENTS_HYPE,
  BEAT_MOMENTS_SOL,
  BEAT_MOMENTS_XRP,
  BEAT_TREND_MOMENTS_BNB,
  BEAT_TREND_MOMENTS_BTC,
  BEAT_TREND_MOMENTS_DOGE,
  BEAT_TREND_MOMENTS_ETH,
  BEAT_TREND_MOMENTS_HYPE,
  BEAT_TREND_MOMENTS_SOL,
  BEAT_TREND_MOMENTS_XRP,
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
  BEAT_ARB_PAIR_ENABLED,
  BEAT_ARB_PAIR_COST_MAX,
  BEAT_ARB_PAIR_REQUIRED_EDGE,
  BEAT_TREND_MIN_PROBABILITY,
  BEAT_TREND_MIN_SIGNAL_SCORE,
  BEAT_ORDER_MODE,
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
  BEAT_MOMENTS_BTC,
  BEAT_MOMENTS_ETH,
  BEAT_MOMENTS_SOL,
  BEAT_MOMENTS_XRP,
  BEAT_MOMENTS_BNB,
  BEAT_MOMENTS_DOGE,
  BEAT_MOMENTS_HYPE,
  BEAT_TREND_MOMENTS_BTC,
  BEAT_TREND_MOMENTS_ETH,
  BEAT_TREND_MOMENTS_SOL,
  BEAT_TREND_MOMENTS_XRP,
  BEAT_TREND_MOMENTS_BNB,
  BEAT_TREND_MOMENTS_DOGE,
  BEAT_TREND_MOMENTS_HYPE,
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

function normalizeMoments(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const next = [];
  for (const item of value) {
    let candidate = null;
    if (Array.isArray(item)) {
      if (item.length < 4) return fallback;
      const [start, end, btcmoveMax, buyMax] = item;
      candidate = { start, end, btcmoveMax, buyMax };
    } else if (item && typeof item === 'object') {
      candidate = item;
    } else {
      return fallback;
    }
    const normalized = {
      start: Number(candidate.start ?? 0),
      end: Number(candidate.end ?? DEFAULTS.MARKET_WINDOW_SECONDS),
      btcmoveMax: Number(candidate.btcmoveMax),
      buyMax: Number(candidate.buyMax),
    };
    if (
      !Number.isFinite(normalized.start) ||
      !Number.isFinite(normalized.end) ||
      !Number.isFinite(normalized.btcmoveMax) ||
      !Number.isFinite(normalized.buyMax)
    ) return fallback;
    next.push(normalized);
  }
  return next.length ? next : fallback;
}

function normalizeTrendMoments(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const next = [];
  for (const item of value) {
    let candidate = null;
    if (Array.isArray(item)) {
      if (item.length < 5) return fallback;
      const [start, end, btcmoveMin, askMin, askMax] = item;
      candidate = { start, end, btcmoveMin, askMin, askMax };
    } else if (item && typeof item === 'object') {
      candidate = item;
    } else {
      return fallback;
    }
    const normalized = {
      start: Number(candidate.start ?? 0),
      end: Number(candidate.end ?? DEFAULTS.MARKET_WINDOW_SECONDS),
      btcmoveMin: Number(candidate.btcmoveMin),
      askMin: Number(candidate.askMin),
      askMax: Number(candidate.askMax),
    };
    if (
      !Number.isFinite(normalized.start) ||
      !Number.isFinite(normalized.end) ||
      !Number.isFinite(normalized.btcmoveMin) ||
      !Number.isFinite(normalized.askMin) ||
      !Number.isFinite(normalized.askMax)
    ) return fallback;
    next.push(normalized);
  }
  return next.length ? next : fallback;
}

function coerceValue(key, value) {
  const fallback = DEFAULTS[key];
  if (fallback === undefined) return undefined;

  if (key === 'BEAT_SYMBOLS') {
    return normalizeBeatSymbols(value, fallback);
  }

  if (key.startsWith('BEAT_MOMENTS')) {
    const parsed = Array.isArray(value)
      ? value
      : (typeof value === 'string' ? (() => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })() : null);
    return normalizeMoments(parsed, fallback);
  }

  if (key.startsWith('BEAT_TREND_MOMENTS')) {
    const parsed = Array.isArray(value)
      ? value
      : (typeof value === 'string' ? (() => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })() : null);
    return normalizeTrendMoments(parsed, fallback);
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
