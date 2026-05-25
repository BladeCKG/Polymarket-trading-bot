import 'dotenv/config';

function opt(key, fallback) {
  return process.env[key] ?? fallback;
}

function num(key, fallback) {
  const value = process.env[key];
  return value !== undefined && value !== '' ? Number(value) : fallback;
}

function bool(key, fallback) {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function csv(key, fallback) {
  return opt(key, fallback)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export const VALUE_DRY_RUN = bool('VALUE_DRY_RUN', true);
export const VALUE_POLL_MS = num('VALUE_POLL_MS', 1_000);
export const VALUE_MARKET_REFRESH_MS = num('VALUE_MARKET_REFRESH_MS', 15_000);
export const VALUE_SYMBOLS = csv('VALUE_SYMBOLS', 'btc,eth,sol,xrp');
export const VALUE_DURATIONS = csv('VALUE_DURATIONS', '5m,15m');
export const VALUE_ENTRY_MIN_PRICE = num('VALUE_ENTRY_MIN_PRICE', 0.40);
export const VALUE_ENTRY_MAX_PRICE = num('VALUE_ENTRY_MAX_PRICE', 0.45);
export const VALUE_MAX_SLIPPAGE = num('VALUE_MAX_SLIPPAGE', 0.03);
export const VALUE_ORDER_MODE = opt('VALUE_ORDER_MODE', 'USDC').toUpperCase();
export const VALUE_LEG_USDC = num('VALUE_LEG_USDC', 1);
export const VALUE_TARGET_SHARES = num('VALUE_TARGET_SHARES', 5);
export const VALUE_FIRST_LEG_CUTOFF_SECONDS = num('VALUE_FIRST_LEG_CUTOFF_SECONDS', 60);
export const VALUE_SECOND_LEG_CUTOFF_SECONDS = num('VALUE_SECOND_LEG_CUTOFF_SECONDS', 15);
export const VALUE_MAX_OPEN_MARKETS = num('VALUE_MAX_OPEN_MARKETS', 20);
export const VALUE_MAX_STRANDED_LEGS = num('VALUE_MAX_STRANDED_LEGS', 10);
export const VALUE_DASHBOARD_ENABLED = bool('VALUE_DASHBOARD_ENABLED', true);
export const VALUE_DASHBOARD_HOST = opt('VALUE_DASHBOARD_HOST', '127.0.0.1');
export const VALUE_DASHBOARD_PORT = num('VALUE_DASHBOARD_PORT', 8797);
