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

function durationSecondsFor(duration) {
  return DURATION_SECONDS[duration] ?? null;
}

function windowStartsForDuration(durationSeconds, nowTs) {
  const currentStart = Math.floor(nowTs / durationSeconds) * durationSeconds;
  return [
    currentStart - durationSeconds,
    currentStart,
    currentStart + durationSeconds,
    currentStart + (2 * durationSeconds),
  ];
}

function unique(values) {
  return [...new Set(values)];
}

async function fetchMarketBySlug(slug) {
  try {
    const res = await axios.get(`${GAMMA_API_URL}/markets/slug/${slug}`, {
      timeout: 10_000,
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

export async function fetchActiveValueMarkets({
  symbols,
  durations,
} = {}) {
  const nowTs = Math.floor(Date.now() / 1000);
  const candidateSlugs = unique(
    symbols.flatMap((symbol) =>
      durations.flatMap((duration) => {
        const durationSeconds = durationSecondsFor(duration);
        if (!durationSeconds) return [];
        return windowStartsForDuration(durationSeconds, nowTs).map((windowTs) =>
          `${symbol}-updown-${duration}-${windowTs}`
        );
      })
    )
  );

  const markets = await Promise.all(candidateSlugs.map((slug) => fetchMarketBySlug(slug)));
  return markets
    .map(normalizeMarketRecord)
    .filter(Boolean)
    .filter((market) =>
      market.active &&
      !market.closed &&
      market.windowTs <= nowTs &&
      market.closeTs > nowTs
    );
}
