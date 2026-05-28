/**
 * config.js
 * Centralised configuration: reads .env, validates required fields,
 * exports typed constants used across the entire bot.
 */
import 'dotenv/config';

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key, fallback) {
  return process.env[key] ?? fallback;
}

function parseFloat_(key, fallback) {
  const v = process.env[key];
  return v !== undefined ? parseFloat(v) : fallback;
}

function parseInt_(key, fallback) {
  const v = process.env[key];
  return v !== undefined ? parseInt(v, 10) : fallback;
}

function parseBool_(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function parseEnum_(key, allowed, fallback) {
  const raw = (process.env[key] ?? '').trim().toUpperCase();
  return allowed.includes(raw) ? raw : fallback;
}

function parseMoments_(key, fallback) {
  const v = process.env[key];
  if (v === undefined) return fallback;
  try {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) return fallback;
    // Expect compact double-array format: [[start,end,btcmoveMax,buyMax], ...]
    return parsed.map((it) => {
      if (!Array.isArray(it) || it.length < 4) throw new Error('Invalid BEAT_MOMENTS format');
      const [s, e, bm, bk] = it;
      return {
        start: Number(s ?? 0),
        end: Number(e ?? 300),
        btcmoveMax: Number(bm),
        buyMax: Number(bk),
      };
    });
  } catch (err) {
    return fallback;
  }
}

// ── Wallet ───────────────────────────────────────────────────────────────────
export const PRIVATE_KEY    = required('PRIVATE_KEY');
export const PROXY_WALLET   = required('PROXY_WALLET'); // Keep EIP-55 checksum as-is
export const TARGET_WALLET  = optional('TARGET_WALLET', '').toLowerCase();

// Signature type for EIP-712 order signing (see Polymarket auth docs).
//  0 = EOA         – standalone wallet; funder is the EOA
//  1 = POLY_PROXY  – Polymarket proxy (e.g. Magic Link / email / Google)
//  2 = GNOSIS_SAFE – Gnosis Safe wallet flow
//  3 = POLY_1271   – deposit-wallet flow for new API users (funder = deposit wallet)
// https://docs.polymarket.com/api-reference/authentication#signature-types-and-funder
export const SIGNATURE_TYPE = parseFloat_('SIGNATURE_TYPE', 2);

// ── API credentials (optional on first run; auth.js generates them) ─────────
export const API_KEY        = optional('POLY_API_KEY', '');
export const API_SECRET     = optional('POLY_API_SECRET', '');
export const API_PASSPHRASE = optional('POLY_API_PASSPHRASE', '');

// ── RPC ──────────────────────────────────────────────────────────────────────
export const POLYGON_RPC    = optional('POLYGON_RPC', 'https://polygon-rpc.com');
export const POLYGON_WS_RPC = optional('POLYGON_WS_RPC', '');
export const CHAIN_ID       = 137;

// ── Polymarket endpoints ─────────────────────────────────────────────────────
export const CLOB_API_URL   = 'https://clob.polymarket.com';
export const GAMMA_API_URL  = 'https://gamma-api.polymarket.com';
export const DATA_API_URL   = 'https://data-api.polymarket.com';
export const CLOB_WS_URL    = 'wss://ws-subscriptions-clob.polymarket.com/ws/';

// ── Polygon contract addresses ───────────────────────────────────────────────
export const USDC_ADDRESS                = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (bridged)
export const CTF_ADDRESS                 = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // ConditionalTokens
export const NEG_RISK_ADAPTER_ADDRESS    = '0xD91e80cf2C1f8038c75b4f93Fd9c28C4aa01B6F8';
export const NEG_RISK_CTF_EXCHANGE       = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
export const CTF_EXCHANGE_ADDRESS        = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
// Polymarket's current production CTF Exchange V2 deployments, published in
// the official ctf-exchange-v2 repository deployment table.
export const NEG_RISK_CTF_EXCHANGE_V2    = '0xe2222d279d744050d28e00520010520000310F59';
export const CTF_EXCHANGE_ADDRESS_V2     = '0xE111180000d2663C0091e4f400237545B87B996B';

// ── Risk parameters ──────────────────────────────────────────────────────────
export const MAX_SPEND_PER_MARKET        = parseFloat_('MAX_SPEND_PER_MARKET', 400);
export const COPY_TRADE_BUY_PERCENT      = parseFloat_('COPY_TRADE_BUY_PERCENT', 100);
export const COPY_TRADE_POLL_MS          = parseFloat_('COPY_TRADE_POLL_MS', 2_000);
export const MAX_INVENTORY_IMBALANCE     = parseFloat_('MAX_INVENTORY_IMBALANCE_USDC', 200);
export const TARGET_EDGE                 = parseFloat_('TARGET_EDGE', 0.02);
export const MERGE_THRESHOLD_USDC        = parseFloat_('MERGE_THRESHOLD_USDC', 15);
export const MAX_TAKER_FILL_USDC         = parseFloat_('MAX_TAKER_FILL_USDC', 100);
export const COMBINED_ASK_STOP           = parseFloat_('COMBINED_ASK_STOP', 1.02);
export const MAX_LOSS_PER_HOUR_USDC      = parseFloat_('MAX_LOSS_PER_HOUR_USDC', 300);

// ── Ladder ───────────────────────────────────────────────────────────────────
const rawLevels = optional(
  'LADDER_LEVELS',
  '0.02,0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45,0.48,0.50,0.52,0.55,0.60,0.65,0.70,0.75,0.80,0.85,0.90,0.95,0.98',
);
export const LADDER_LEVELS            = rawLevels.split(',').map(Number);
export const LADDER_SIZE_PER_LEVEL    = parseFloat_('LADDER_SIZE_PER_LEVEL_USDC', 20);

// ── Market timing ────────────────────────────────────────────────────────────
export const MARKET_WINDOW_SECONDS      = 300;   // each btc-updown-5m window is 5 min
export const ENTRY_DELAY_SECONDS        = 2;     // start posting after window opens
export const STOP_BUYING_BEFORE_CLOSE   = 0;   // stop buying N seconds before window close
export const REDEEM_DELAY_AFTER_CLOSE   = 60;   // start polling for resolution shortly after close

// ── Operational ─────────────────────────────────────────────────────────────
export const BOOK_POLL_MS               = 1_500;  // fallback REST polling interval
export const LOG_LEVEL                  = optional('LOG_LEVEL', 'info');
export const COPY_DRY_RUN               = parseBool_('COPY_DRY_RUN', false);
/** POST /heartbeats while GTC orders rest; server cancels all open orders if heartbeats stop. Min 10s. */
export const HEARTBEAT_INTERVAL_MS      = Math.max(
  10_000,
  parseInt(optional('HEARTBEAT_INTERVAL_MS', '30000'), 10) || 30_000,
);

// ── BTC beat strategy ────────────────────────────────────────────────────────
export const BEAT_MARKET_SYMBOL          = parseEnum_('BEAT_MARKET_SYMBOL', ['BTC', 'ETH'], 'BTC');
const PRICE_FEED_DEFAULTS = BEAT_MARKET_SYMBOL === 'ETH'
  ? {
      wsUrl: 'wss://stream.binance.com:9443/ws/ethusdt@ticker',
      productId: 'ETHUSDT',
      restUrl: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT',
    }
  : {
      wsUrl: 'wss://stream.binance.com:9443/ws/btcusdt@ticker',
      productId: 'BTCUSDT',
      restUrl: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    };
export const BTC_PRICE_WS_URL            = optional('BTC_PRICE_WS_URL', PRICE_FEED_DEFAULTS.wsUrl);
export const BTC_PRICE_PRODUCT_ID        = optional('BTC_PRICE_PRODUCT_ID', PRICE_FEED_DEFAULTS.productId);
export const BTC_PRICE_REST_URL          = optional('BTC_PRICE_REST_URL', PRICE_FEED_DEFAULTS.restUrl);
export const BTC_PRICE_MAX_AGE_MS        = parseInt_('BTC_PRICE_MAX_AGE_MS', 2_000);
export const BEAT_DRY_RUN                = parseBool_('BEAT_DRY_RUN', true);
// Entry delay is now controlled by `BEAT_MOMENTS` (per-moment starts)
export const BEAT_BOOK_POLL_MS           = parseInt_('BEAT_BOOK_POLL_MS', 1_000);
export const BEAT_BUY_COOLDOWN_MS        = parseInt_('BEAT_BUY_COOLDOWN_MS', 5_000);
export const BEAT_ORDER_MODE             = parseEnum_('BEAT_ORDER_MODE', ['USDC', 'SHARES'], 'USDC');
export const BEAT_ORDER_SIZE_USDC        = parseFloat_('BEAT_ORDER_SIZE_USDC', 25);
export const BEAT_ORDER_SIZE_SHARES      = parseFloat_('BEAT_ORDER_SIZE_SHARES', 10);
export const BEAT_MAX_SLIPPAGE           = parseFloat_('BEAT_MAX_SLIPPAGE', 0.01);
// Deprecated per-side move minimums removed (use unified thresholds instead)
// Unified move maximum (USD): supports legacy env names for fallback
// Per-moment configuration `BEAT_MOMENTS` controls move and buy thresholds.
export const BEAT_DASHBOARD_ENABLED = parseBool_('BEAT_DASHBOARD_ENABLED', false);
export const BEAT_DASHBOARD_HOST = optional('BEAT_DASHBOARD_HOST', '127.0.0.1');
export const BEAT_DASHBOARD_PORT = parseInt_('BEAT_DASHBOARD_PORT', 8798);

// Per-market time-segment configuration for directional buys.
// Env var `BEAT_MOMENTS` should be a JSON array of objects like:
// [{"start":0,"end":15,"btcmoveMax":100,"buyMax":0.1}, ...]
// Values are seconds after market open (0-300 for 5m markets).
// `BEAT_MOMENTS` accepts a compact double-array or array-of-objects JSON.
// Compact form: [[start,end,btcmoveMax,buyMax], ...]
export const BEAT_MOMENTS = parseMoments_('BEAT_MOMENTS', [
  // Default: allow reasonable moves and buy price across full window
  [0, MARKET_WINDOW_SECONDS, 120, 0.46],
]);

// ── EIP-712 domains for CLOB order signing ───────────────────────────────────
// Polymarket has TWO exchange contracts. Orders MUST be signed against the
// correct one or they will be rejected on-chain.
//
//  ORDER_DOMAIN        – Neg Risk CTF Exchange (complementary-token / multi-outcome markets)
//                        e.g. btc-updown-5m, election candidates
//  ORDER_DOMAIN_BINARY – Standard CTF Exchange (simple binary YES/NO markets)
//
// Use the `negativeRisk` field on the market/position to pick the right domain.
export const ORDER_DOMAIN = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: NEG_RISK_CTF_EXCHANGE,
};

export const ORDER_DOMAIN_BINARY = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: CTF_EXCHANGE_ADDRESS,
};

export const ORDER_TYPES = {
  Order: [
    { name: 'salt',          type: 'uint256' },
    { name: 'maker',         type: 'address' },
    { name: 'signer',        type: 'address' },
    { name: 'taker',         type: 'address' },
    { name: 'tokenId',       type: 'uint256' },
    { name: 'makerAmount',   type: 'uint256' },
    { name: 'takerAmount',   type: 'uint256' },
    { name: 'expiration',    type: 'uint256' },
    { name: 'nonce',         type: 'uint256' },
    { name: 'feeRateBps',    type: 'uint256' },
    { name: 'side',          type: 'uint8'   },
    { name: 'signatureType', type: 'uint8'   },
  ],
};

// ── EIP-712 domain for L1 CLOB auth signing ──────────────────────────────────
export const AUTH_DOMAIN = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: CHAIN_ID,
};

export const AUTH_TYPES = {
  ClobAuth: [
    { name: 'address',   type: 'address' },
    { name: 'timestamp', type: 'string'  },
    { name: 'nonce',     type: 'uint256' },
    { name: 'message',   type: 'string'  },
  ],
};

// Decimal precision for on-chain token amounts (USDC.e = 6 decimals)
export const TOKEN_DECIMALS = 6;
export const USDC_SCALE     = 10 ** TOKEN_DECIMALS; // 1_000_000
