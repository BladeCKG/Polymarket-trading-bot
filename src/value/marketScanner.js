import axios from 'axios';
import { GAMMA_API_URL } from '../config.js';

const DURATION_SECONDS = {
  '5m': 5 * 60,
  '15m': 15 * 60,
};

function parseArrayField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeMarketRecord(market) {
  const tokens = parseArrayField(market.tokens ?? market.clobTokenIds);
  const outcomes = parseArrayField(market.outcomes);
  const normTokens = tokens.map((token, index) => {
    if (typeof token === 'string') {
      return {
        tokenId: token,
        outcome: outcomes[index] ?? (index === 0 ? 'Up' : 'Down'),
        outcomeIndex: index,
      };
    }
    return {
      tokenId: token.tokenId ?? token.token_id,
      outcome: token.outcome ?? outcomes[index] ?? (index === 0 ? 'Up' : 'Down'),
      outcomeIndex: token.outcomeIndex ?? token.outcome_index ?? index,
    };
  });

  const upToken = normTokens.find((token) => token.outcome === 'Up' || token.outcomeIndex === 0);
  const downToken = normTokens.find((token) => token.outcome === 'Down' || token.outcomeIndex === 1);
  if (!upToken || !downToken) return null;

  const slug = market.slug ?? '';
  const parts = slug.split('-');
  const duration = parts.length >= 4 ? parts[2] : '';
  const windowTs = Number(parts.at(-1));
  const durationSeconds = DURATION_SECONDS[duration] ?? null;
  if (!durationSeconds || !Number.isFinite(windowTs)) return null;

  return {
    slug,
    conditionId: String(market.conditionId ?? market.condition_id ?? '').toLowerCase(),
    question: market.question ?? market.title ?? slug,
    duration,
    durationSeconds,
    windowTs,
    closeTs: windowTs + durationSeconds,
    active: market.active ?? !market.closed,
    closed: Boolean(market.closed),
    upToken,
    downToken,
  };
}

function matchesShortDurationCryptoMarket(market, symbols, durations) {
  const slug = String(market.slug ?? '').toLowerCase();
  if (!slug) return false;
  return symbols.some((symbol) =>
    durations.some((duration) => slug.startsWith(`${symbol}-updown-${duration}-`))
  );
}

export async function fetchActiveValueMarkets({
  symbols,
  durations,
  pageSize = 200,
  maxPages = 5,
} = {}) {
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await axios.get(`${GAMMA_API_URL}/markets`, {
      timeout: 10_000,
      params: {
        limit: pageSize,
        offset: page * pageSize,
      },
    });
    const batch = Array.isArray(res.data) ? res.data : [];
    if (!batch.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }

  const nowTs = Math.floor(Date.now() / 1000);
  return rows
    .filter((market) => matchesShortDurationCryptoMarket(market, symbols, durations))
    .map(normalizeMarketRecord)
    .filter(Boolean)
    .filter((market) => market.active && !market.closed && market.closeTs > nowTs);
}
