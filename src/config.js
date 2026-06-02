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

function parseArray_(key, fallback) {
  const v = process.env[key];
  if (v === undefined) return fallback;
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return fallback;

  const trimmed = v.trim();
  if (!trimmed) return fallback;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch (err) {
    // fall back to comma-separated list
  }

  return trimmed.split(/[,\s]+/).filter(Boolean);
}

const SUPPORTED_BEAT_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];

function normalizeBeatSymbol(value, fallback) {
  const raw = String(value ?? '').trim().toUpperCase();
  return SUPPORTED_BEAT_SYMBOLS.includes(raw) ? raw : fallback;
}

function parseSymbolList_(key, fallback) {
  const values = parseArray_(key, fallback);
  const symbols = values.map((value) => normalizeBeatSymbol(value, null)).filter(Boolean);
  return symbols.length ? [...new Set(symbols)] : fallback;
}

// ── Wallet ───────────────────────────────────────────────────────────────────
export const PRIVATE_KEY    = required('PRIVATE_KEY');
export const PROXY_WALLET   = optional('PROXY_WALLET', ''); // Keep EIP-55 checksum as-is when used
export const DEPOSIT_WALLET_ADDRESS = optional('DEPOSIT_WALLET_ADDRESS', ''); // Keep EIP-55 checksum as-is when used
export const TARGET_WALLET  = optional('TARGET_WALLET', '').toLowerCase();

// Signature type for EIP-712 order signing (see Polymarket auth docs).
//  0 = EOA         – standalone wallet; funder is the EOA
//  1 = POLY_PROXY  – Polymarket proxy (e.g. Magic Link / email / Google)
//  2 = GNOSIS_SAFE – Gnosis Safe wallet flow
//  3 = POLY_1271   – deposit-wallet flow for new API users (funder = deposit wallet)
// https://docs.polymarket.com/api-reference/authentication#signature-types-and-funder
export const SIGNATURE_TYPE = parseFloat_('SIGNATURE_TYPE', 2);
export const IS_DEPOSIT_WALLET_FLOW = Number(SIGNATURE_TYPE) === 3;
export const FUNDER_ADDRESS = (() => {
  if (IS_DEPOSIT_WALLET_FLOW) {
    return required('DEPOSIT_WALLET_ADDRESS');
  }
  return required('PROXY_WALLET');
})();

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
export const REDEEM_DELAY_AFTER_CLOSE   = 0;    // start polling for resolution immediately after close

// ── Operational ─────────────────────────────────────────────────────────────
export const BOOK_POLL_MS               = 1_500;  // fallback REST polling interval
export const LOG_LEVEL                  = optional('LOG_LEVEL', 'info');
export const COPY_DRY_RUN               = parseBool_('COPY_DRY_RUN', false);
/** POST /heartbeats while GTC orders rest; server cancels all open orders if heartbeats stop. Min 10s. */
export const HEARTBEAT_INTERVAL_MS      = Math.max(
  10_000,
  parseInt(optional('HEARTBEAT_INTERVAL_MS', '30000'), 10) || 30_000,
);

// ── Beat strategy symbols ───────────────────────────────────────────────────
// `BEAT_SYMBOLS` contains the assets to trade in parallel.
export const BEAT_SYMBOLS = parseSymbolList_('BEAT_SYMBOLS', ['BTC']);

export const BTC_PRICE_MAX_AGE_MS        = parseInt_('BTC_PRICE_MAX_AGE_MS', 2_000);
export const BTC_PRICE_STALL_RECONNECT_MS = parseInt_('BTC_PRICE_STALL_RECONNECT_MS', 12_000);
export const BEAT_DRY_RUN                = parseBool_('BEAT_DRY_RUN', true);
// Entry delay is controlled by `BEAT_ENTRY_DELAY_SECONDS`.
export const BEAT_BOOK_POLL_MS           = parseInt_('BEAT_BOOK_POLL_MS', 1_000);
export const BEAT_BOOK_MAX_AGE_MS        = parseInt_('BEAT_BOOK_MAX_AGE_MS', 1_500);
export const BEAT_BUY_COOLDOWN_MS        = parseInt_('BEAT_BUY_COOLDOWN_MS', 5_000);
export const BEAT_PROBABILITY_ENABLED    = parseBool_('BEAT_PROBABILITY_ENABLED', true);
export const BEAT_PROBABILITY_HISTORY_MS = parseInt_('BEAT_PROBABILITY_HISTORY_MS', 30_000);
export const BEAT_PROBABILITY_REQUIRED_EDGE = parseFloat_('BEAT_PROBABILITY_REQUIRED_EDGE', 0.03);
export const BEAT_PROBABILITY_PAIR_COST_MAX = parseFloat_('BEAT_PROBABILITY_PAIR_COST_MAX', 1.0);
export const BEAT_PROBABILITY_VOL_LAMBDA = parseFloat_('BEAT_PROBABILITY_VOL_LAMBDA', 0.97);
export const BEAT_PROBABILITY_DRIFT_SHRINK = parseFloat_('BEAT_PROBABILITY_DRIFT_SHRINK', 0.35);
export const BEAT_PROBABILITY_OFI_WEIGHT = parseFloat_('BEAT_PROBABILITY_OFI_WEIGHT', 0.20);
export const BEAT_PROBABILITY_CONFIDENCE = parseFloat_('BEAT_PROBABILITY_CONFIDENCE', 0.80);
export const BEAT_PROBABILITY_MIN = parseFloat_('BEAT_PROBABILITY_MIN', 0.05);
export const BEAT_PROBABILITY_MAX = parseFloat_('BEAT_PROBABILITY_MAX', 0.95);
export const BEAT_PAIR_COMPLETION_ENABLED = parseBool_('BEAT_PAIR_COMPLETION_ENABLED', true);
export const BEAT_PAIR_COMPLETION_MIN_PROBABILITY = parseFloat_('BEAT_PAIR_COMPLETION_MIN_PROBABILITY', 0.55);
export const BEAT_PAIR_COMPLETION_DRIFT_SHRINK = parseFloat_('BEAT_PAIR_COMPLETION_DRIFT_SHRINK', 0.25);
export const BEAT_ARB_PAIR_ENABLED       = parseBool_('BEAT_ARB_PAIR_ENABLED', true);
export const BEAT_ARB_PAIR_COST_MAX      = parseFloat_('BEAT_ARB_PAIR_COST_MAX', 0.98);
export const BEAT_ORDER_MODE             = parseEnum_('BEAT_ORDER_MODE', ['USDC', 'SHARES'], 'USDC');
export const BEAT_ORDER_SIZE_USDC        = parseFloat_('BEAT_ORDER_SIZE_USDC', 25);
export const BEAT_ORDER_SIZE_SHARES      = parseFloat_('BEAT_ORDER_SIZE_SHARES', 10);
export const BEAT_MIN_BUY_USDC          = parseFloat_('BEAT_MIN_BUY_USDC', 1);
export const BEAT_MIN_BUY_SHARES        = parseFloat_('BEAT_MIN_BUY_SHARES', 5);
export const BEAT_MAX_SLIPPAGE           = parseFloat_('BEAT_MAX_SLIPPAGE', 0.01);
export const BEAT_MAX_INVENTORY_IMBALANCE_SHARES = parseFloat_('BEAT_MAX_INVENTORY_IMBALANCE_SHARES', 200);
export const BEAT_OFI_ENABLED            = parseBool_('BEAT_OFI_ENABLED', true);
export const BEAT_OFI_WINDOW_MS          = parseInt_('BEAT_OFI_WINDOW_MS', 3_000);
export const BEAT_OFI_TOXICITY_THRESHOLD = parseFloat_('BEAT_OFI_TOXICITY_THRESHOLD', 200);
export const BEAT_OFI_RATIO_ENTER        = parseFloat_('BEAT_OFI_RATIO_ENTER', 0.70);
export const BEAT_OFI_RATIO_EXIT         = parseFloat_('BEAT_OFI_RATIO_EXIT', 0.40);
export const BEAT_OFI_EXIT_RATIO         = parseFloat_('BEAT_OFI_EXIT_RATIO', 0.85);
// Deprecated per-side move minimums removed (use unified thresholds instead)
export const BEAT_DASHBOARD_ENABLED = parseBool_('BEAT_DASHBOARD_ENABLED', false);
export const BEAT_DASHBOARD_HOST = optional('BEAT_DASHBOARD_HOST', '127.0.0.1');
export const BEAT_DASHBOARD_PORT = parseInt_('BEAT_DASHBOARD_PORT', 8798);

// ═══════════════════════════════════════════════════════════════════════════
// BEAT v2 — 다중 거래소 데이터 허브 + 근사-완벽 확률 모델 설정
// ───────────────────────────────────────────────────────────────────────────
// 전략 요약:
//   1) 여러 거래소(현물)의 체결/호가/오더북/거래량을 실시간 수집한다.
//   2) Polymarket Up/Down 토큰의 오더북·체결·미드를 함께 수집한다.
//   3) 위 신호를 융합해 "지금 시점에서 5분 종료 시 Up/Down 일 확률"을 계산한다.
//   4) 모델 공정확률(fair prob)이 해당 사이드의 ask 보다 (edge 이상) 높으면
//      그 사이드가 저평가된 것이므로 매수한다. 이후 반대편이 싸지면
//      pair(차익) 완성으로 손익을 고정한다.
// ═══════════════════════════════════════════════════════════════════════════

// 실시간 데이터를 수집할 현물 거래소 목록.
export const BEAT_EXCHANGES = parseArray_('BEAT_EXCHANGES', ['binance', 'okx', 'bybit', 'coinbase'])
  .map((value) => String(value ?? '').trim().toLowerCase())
  .filter(Boolean);

// 체결 흐름(CVD 등) 계산용 롤링 버퍼 길이.
export const BEAT_HUB_TRADE_WINDOW_MS = parseInt_('BEAT_HUB_TRADE_WINDOW_MS', 60_000);
// 통합 가격 히스토리 보관 길이(변동성/모멘텀 추정용).
export const BEAT_HUB_PRICE_HISTORY_MS = parseInt_('BEAT_HUB_PRICE_HISTORY_MS', 120_000);
// 통합 가격 틱이 이보다 오래되면 매매 판단에서 제외.
export const BEAT_HUB_MAX_TICK_AGE_MS = parseInt_('BEAT_HUB_MAX_TICK_AGE_MS', 2_500);

// ── 확률 모델 가중치(드리프트 방향 신호) ────────────────────────────────────
// 모든 신호는 [-1, 1] 로 정규화되어 가중 평균된 뒤 z-score 를 이동시킨다.
export const BEAT_MODEL_MOMENTUM_WEIGHT   = parseFloat_('BEAT_MODEL_MOMENTUM_WEIGHT', 0.40);
export const BEAT_MODEL_OBI_WEIGHT        = parseFloat_('BEAT_MODEL_OBI_WEIGHT', 0.20);
export const BEAT_MODEL_CVD_WEIGHT        = parseFloat_('BEAT_MODEL_CVD_WEIGHT', 0.25);
export const BEAT_MODEL_MICROPRICE_WEIGHT = parseFloat_('BEAT_MODEL_MICROPRICE_WEIGHT', 0.15);
// 방향 신호가 z-score 를 최대 얼마나 이동시킬지 스케일.
export const BEAT_MODEL_DRIFT_Z_SCALE     = parseFloat_('BEAT_MODEL_DRIFT_Z_SCALE', 1.0);
// Polymarket 시장 내재확률을 사전분포로 얼마나 섞을지(0=섞지 않음, edge 보존).
export const BEAT_MODEL_MARKET_PRIOR_WEIGHT = parseFloat_('BEAT_MODEL_MARKET_PRIOR_WEIGHT', 0.0);

// ── 매매 윈도우/가드 ─────────────────────────────────────────────────────────
// 시장 오픈 후 이 시간(초)이 지나야 첫 매수 시도.
export const BEAT_ENTRY_DELAY_SECONDS = parseInt_('BEAT_ENTRY_DELAY_SECONDS', 5);
// 종료 이 시간(초) 전부터는 신규 방향성 매수 중단.
export const BEAT_STOP_BUYING_BEFORE_CLOSE_SECONDS = parseInt_('BEAT_STOP_BUYING_BEFORE_CLOSE_SECONDS', 20);
// 변동성/모멘텀 추정을 신뢰하기 위한 최소 데이터 누적 시간.
export const BEAT_MIN_HISTORY_MS = parseInt_('BEAT_MIN_HISTORY_MS', 15_000);
// 방향성 매수를 허용하는 ask 가격 범위.
export const BEAT_SIDE_MAX_ASK = parseFloat_('BEAT_SIDE_MAX_ASK', 0.95);
export const BEAT_SIDE_MIN_ASK = parseFloat_('BEAT_SIDE_MIN_ASK', 0.02);

// ── 강제 페어 청산(미페어 방향성 손실 축소) ──────────────────────────────────
// 정상적인 무위험 페어(비용 < pairCostMax)가 더 이상 불가능한 미페어 방향성
// 포지션을, 모델이 "질 것 같다"고 볼 때 반대편을 사서 강제로 페어링해 손실을
// 줄인다. 완성 페어는 정산 시 정확히 $1 를 지급하므로 손실이 확정·상한된다.
//   force-pair 조건(+EV): pA + p_opp(ask) + fee <= 1 - margin
//     (A 사이드 공정 승률 + 반대편 가격이 1 미만 → 지금 잠그는 게 보유보다 유리)
export const BEAT_FORCE_PAIR_ENABLED = parseBool_('BEAT_FORCE_PAIR_ENABLED', true);
// +EV 트리거에 요구하는 최소 마진(클수록 보수적, 더 확실할 때만 강제 페어).
export const BEAT_FORCE_PAIR_EV_MARGIN = parseFloat_('BEAT_FORCE_PAIR_EV_MARGIN', 0.04);
// 강제 페어를 고려하기 시작하는, 보유 사이드 공정 승률 상한.
// (pA 가 이 값보다 낮을 때만 = 충분히 불리할 때만 청산 검토)
export const BEAT_FORCE_PAIR_MAX_WIN_PROB = parseFloat_('BEAT_FORCE_PAIR_MAX_WIN_PROB', 0.45);
// 한 주(share)당 감수할 수 있는 최대 확정 손실. 반대편이 너무 비싸(=락인 손실이
// 이보다 크면) 강제 페어 대신 보유로 둔다(망가진 호가에 손실을 못 박지 않도록).
export const BEAT_FORCE_PAIR_MAX_LOSS_PER_SHARE = parseFloat_('BEAT_FORCE_PAIR_MAX_LOSS_PER_SHARE', 0.20);
// 엔드게임 백스톱: 종료 이 시간(초) 전부터는, 보유 사이드가 불리하면(pA<0.5)
// +EV 마진을 완화해서라도 강제 페어로 손실을 상한한다(설정 손실 한도는 유지).
export const BEAT_FORCE_PAIR_ENDGAME_SECONDS = parseInt_('BEAT_FORCE_PAIR_ENDGAME_SECONDS', 30);
// 엔드게임에서 모델이 평가 불가(가격 정체/히스토리 부족)일 때의 대체 판단 기준.
// 정산 규칙(합의가 vs 기준가)으로 "지는 중"을 판정한다. 기준가 대비 이 bps 이상
// 불리한 쪽에 있으면 지는 것으로 보고 강제 페어(손실 한도 내에서)한다.
export const BEAT_FORCE_PAIR_LOSING_MARGIN_BPS = parseFloat_('BEAT_FORCE_PAIR_LOSING_MARGIN_BPS', 2);

// 라이브 매수 후, API 응답이 불확실할 때 온체인 OrderFilled 확정을 기다리는 최대 시간(ms).
export const BEAT_FILL_CONFIRM_TIMEOUT_MS = parseInt_('BEAT_FILL_CONFIRM_TIMEOUT_MS', 4_000);

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
