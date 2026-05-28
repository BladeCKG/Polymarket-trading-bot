/**
 * market.js
 * Market discovery via the Polymarket Gamma API.
 *
 * btc-updown-5m / eth-updown-5m markets follow the naming scheme:
 *   slug = "<symbol>-updown-5m-<unix_ts>" where unix_ts is the window open time
 *   (multiple of 300 seconds).
 *
 * Responsibilities:
 *  - Compute the next market window timestamp.
 *  - Fetch the market's conditionId and Up/Down tokenIds from Gamma API.
 *  - Poll until the market is resolved (for redeem timing).
 */
import axios from 'axios';
import { DATA_API_URL, GAMMA_API_URL, MARKET_WINDOW_SECONDS, TARGET_WALLET } from './config.js';
import logger from './logger.js';

// ── Slug & timestamp helpers ──────────────────────────────────────────────────
/**
 * Returns the unix timestamp of the CURRENT 5-min window open.
 * e.g. if now = 06:42:30, window open = 06:40:00 (ts ending in :00 on 5-min grid).
 */
export function currentWindowTs(windowSeconds = MARKET_WINDOW_SECONDS) {
  return Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
}

/**
 * Returns the unix timestamp of the NEXT 5-min window open.
 */
export function nextWindowTs(windowSeconds = MARKET_WINDOW_SECONDS) {
  return currentWindowTs(windowSeconds) + windowSeconds;
}

/**
 * Build the slug for a given window open timestamp.
 */
export function slugFor(ts, symbol = 'BTC') {
  return `${String(symbol ?? 'BTC').toLowerCase()}-updown-5m-${ts}`;
}

/**
 * Milliseconds remaining until a target unix timestamp.
 */
export function msUntil(unixTs) {
  return unixTs * 1000 - Date.now();
}

function normaliseWalletAddress(address) {
  return typeof address === 'string' ? address.toLowerCase() : '';
}

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

function isNear(value, target, tolerance = 1e-3) {
  return Math.abs(value - target) <= tolerance;
}

export function resolvedPayoutsFromMarket(rawMarket) {
  const isClosed = Boolean(
    rawMarket?.closed ??
    rawMarket?.resolved ??
    rawMarket?.is_resolved,
  );
  if (!isClosed) return null;

  const payouts = parseArrayField(rawMarket?.outcomePrices).map(Number);
  if (!payouts.length || payouts.some((value) => !Number.isFinite(value))) return null;

  const total = payouts.reduce((sum, value) => sum + value, 0);
  const valuesLookResolutionShaped = payouts.every((value) =>
    isNear(value, 0) || isNear(value, 0.5) || isNear(value, 1),
  );

  if (!valuesLookResolutionShaped || !isNear(total, 1, 2e-3)) return null;
  return payouts;
}

// ── Gamma API ─────────────────────────────────────────────────────────────────
/**
 * Normalise a Gamma market record into the shape the rest of the bot expects.
 * Handles stringified array fields such as `clobTokenIds`, `outcomes`, and
 * `outcomePrices`.
 */
function normalizeMarketRecord(m, fallbackSlug = null) {
  const tokens = parseArrayField(m.tokens ?? m.clobTokenIds);
  const outcomePrices = parseArrayField(m.outcomePrices).map(Number);
  const outcomes = parseArrayField(m.outcomes);
  const resolvedPayouts = resolvedPayoutsFromMarket(m);

  const normTokens = tokens.map((t, i) => {
    if (typeof t === 'string') {
      return { tokenId: t, outcome: i === 0 ? 'Up' : 'Down', outcomeIndex: i };
    }
    return {
      tokenId: t.token_id ?? t.tokenId,
      outcome: t.outcome ?? (i === 0 ? 'Up' : 'Down'),
      outcomeIndex: t.outcome_index ?? i,
    };
  });

  const slug = m.slug ?? fallbackSlug;
  const upToken = normTokens.find(t => t.outcome === 'Up' || t.outcomeIndex === 0);
  const downToken = normTokens.find(t => t.outcome === 'Down' || t.outcomeIndex === 1);

  if (!upToken || !downToken) {
    throw new Error(`Cannot find Up/Down tokens for market: ${slug} -> ${JSON.stringify(tokens)}`);
  }

  const ts = slug ? parseInt(slug.split('-').at(-1), 10) : NaN;
  return {
    id: m.id ?? null,
    conditionId: m.condition_id ?? m.conditionId,
    slug,
    windowTs: Number.isFinite(ts) ? ts : null,
    tokens: normTokens,
    upToken,
    downToken,
    active: m.active ?? !m.closed,
    closed: Boolean(m.closed),
    resolved: Boolean(m.resolved ?? m.is_resolved ?? m.closed),
    question: m.question ?? m.title,
    outcomes,
    outcomePrices,
    resolvedPayouts,
  };
}

/**
 * Fetch market metadata for a given slug.
 *
 * Returns:
 * {
 *   conditionId: '0x…',
 *   slug: 'btc-updown-5m-…',
 *   windowTs: <unix_ts>,     // window open unix timestamp
 *   upToken:   { tokenId: '123…', outcome: 'Up',   outcomeIndex: 0 },
 *   downToken: { tokenId: '456…', outcome: 'Down', outcomeIndex: 1 },
 *   active: true|false,
 *   resolved: true|false,
 * }
 *
 * Throws if the market does not exist yet (not yet created by Polymarket).
 */
export async function fetchMarket(slug) {
  try {
    const pathRes = await axios.get(`${GAMMA_API_URL}/markets/slug/${encodeURIComponent(slug)}`, {
      timeout: 10_000,
    });
    return normalizeMarketRecord(pathRes.data, slug);
  } catch (err) {
    if (err.response?.status !== 404) throw err;
  }

  const queryRes = await axios.get(`${GAMMA_API_URL}/markets`, {
    timeout: 10_000,
    params: { slug },
  });
  const markets = queryRes.data;

  if (!markets || !markets.length) {
    throw new Error(`Market not found: ${slug}`);
  }

  return normalizeMarketRecord(markets[0], slug);
}

/**
 * Fetch market metadata for a given CLOB token id.
 * Useful for event-driven ingestion paths that see raw on-chain token ids
 * before they know the human-readable market slug or outcome label.
 */
export async function fetchMarketByTokenId(tokenId) {
  const target = String(tokenId ?? '');
  if (!target) throw new Error('fetchMarketByTokenId: tokenId is required');

  const res = await axios.get(`${GAMMA_API_URL}/markets`, {
    timeout: 10_000,
    params: { clob_token_ids: target },
  });
  const markets = Array.isArray(res.data) ? res.data : [];

  if (!markets.length) {
    throw new Error(`Market not found for tokenId: ${tokenId}`);
  }

  return normalizeMarketRecord(markets[0], markets[0]?.slug ?? null);
}

/**
 * Best-effort fallback lookup when Gamma cannot find a market by slug.
 * Gamma's public conditionId filtering is unreliable, so we scan the paginated
 * market list and, if we find a numeric market id, fetch the full detail record.
 */
export async function fetchMarketByConditionId(conditionId, {
  pageSize = 200,
  maxPages = 40,
} = {}) {
  const target = String(conditionId ?? '').toLowerCase();
  if (!target) throw new Error('fetchMarketByConditionId: conditionId is required');

  for (let page = 0; page < maxPages; page++) {
    const res = await axios.get(`${GAMMA_API_URL}/markets`, {
      timeout: 10_000,
      params: {
        limit: pageSize,
        offset: page * pageSize,
      },
    });
    const markets = Array.isArray(res.data) ? res.data : [];
    if (!markets.length) break;

    const match = markets.find((market) =>
      String(market.conditionId ?? market.condition_id ?? '').toLowerCase() === target,
    );
    if (match) {
      if (match.id != null) {
        const detail = await axios.get(`${GAMMA_API_URL}/markets/${match.id}`, { timeout: 10_000 });
        return normalizeMarketRecord(detail.data, match.slug ?? null);
      }
      return normalizeMarketRecord(match, match.slug ?? null);
    }

    if (markets.length < pageSize) break;
  }

  throw new Error(`Market not found for conditionId: ${conditionId}`);
}

/**
 * Fetch detailed position data for a Polymarket proxy wallet from the Data API.
 *
 * Useful for copy-trade logic that needs to inspect the target wallet's live
 * positions, sizing, average prices, and market metadata.
 */
export async function fetchWalletPositions(proxyWallet, {
  sizeThreshold = 1,
  limit = 100,
  offset = 0,
  sortBy = 'TOKENS',
  sortDirection = 'DESC',
} = {}) {
  const wallet = normaliseWalletAddress(proxyWallet);
  if (!wallet) throw new Error('fetchWalletPositions: proxyWallet is required');

  const res = await axios.get(`${DATA_API_URL}/positions`, {
    timeout: 10_000,
    params: {
      user: wallet,
      sizeThreshold,
      limit,
      offset,
      sortBy,
      sortDirection,
    },
  });

  return (res.data ?? []).map((position) => ({
    proxyWallet: normaliseWalletAddress(position.proxyWallet ?? wallet),
    asset: position.asset ?? '',
    conditionId: position.conditionId ?? '',
    size: Number(position.size ?? 0),
    avgPrice: Number(position.avgPrice ?? 0),
    initialValue: Number(position.initialValue ?? 0),
    currentValue: Number(position.currentValue ?? 0),
    cashPnl: Number(position.cashPnl ?? 0),
    percentPnl: Number(position.percentPnl ?? 0),
    totalBought: Number(position.totalBought ?? 0),
    realizedPnl: Number(position.realizedPnl ?? 0),
    percentRealizedPnl: Number(position.percentRealizedPnl ?? 0),
    curPrice: Number(position.curPrice ?? 0),
    redeemable: Boolean(position.redeemable),
    mergeable: Boolean(position.mergeable),
    title: position.title ?? '',
    slug: position.slug ?? '',
    icon: position.icon ?? '',
    eventSlug: position.eventSlug ?? '',
    outcome: position.outcome ?? '',
    outcomeIndex: Number(position.outcomeIndex ?? 0),
    oppositeOutcome: position.oppositeOutcome ?? '',
    oppositeAsset: position.oppositeAsset ?? '',
    endDate: position.endDate ?? '',
    negativeRisk: Boolean(position.negativeRisk),
  }));
}

/**
 * Fetch recent trade history for a Polymarket proxy wallet from the Data API.
 *
 * Useful when settled positions no longer appear in `/positions`, but we still
 * need to reconstruct market-level PnL from actual executed fills.
 */
export async function fetchWalletTrades(proxyWallet, {
  limit = 200,
  maxPages = 5,
  takerOnly = false,
  markets = [],
} = {}) {
  const wallet = normaliseWalletAddress(proxyWallet);
  if (!wallet) throw new Error('fetchWalletTrades: proxyWallet is required');
  const marketList = Array.isArray(markets)
    ? markets.map((market) => String(market ?? '').toLowerCase()).filter(Boolean)
    : [];
  const marketParam = marketList.join(',');

  const rows = [];
  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    const res = await axios.get(`${DATA_API_URL}/trades`, {
      timeout: 10_000,
      params: {
        user: wallet,
        limit,
        offset,
        takerOnly,
        ...(marketParam ? { market: marketParam } : {}),
      },
    });

    const batch = Array.isArray(res.data) ? res.data : [];
    if (!batch.length) break;

    rows.push(...batch.map((trade) => {
      const tsRaw = Number(trade.timestamp ?? trade.match_time ?? trade.created_at ?? 0);
      const timestamp = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : tsRaw;
      const price = Number(trade.price ?? 0);
      const size = Number(trade.size ?? 0);
      const usdc = Number(trade.usdcSize ?? trade.usdc_size ?? (price * size));
      return {
        proxyWallet: wallet,
        asset: String(trade.asset ?? trade.asset_id ?? trade.tokenId ?? ''),
        conditionId: String(trade.conditionId ?? trade.condition_id ?? '').toLowerCase(),
        side: String(trade.side ?? '').toUpperCase(),
        price,
        size,
        usdc,
        timestamp,
        txHash: String(trade.transactionHash ?? trade.transaction_hash ?? '').toLowerCase(),
        slug: trade.slug ?? trade.eventSlug ?? '',
        outcome: trade.outcome ?? '',
        title: trade.question ?? trade.title ?? '',
      };
    }));

    if (batch.length < limit) break;
    offset += batch.length;
  }

  return rows;
}

/**
 * Convenience wrapper for the configured copy-trade target wallet.
 */
export async function fetchTargetWalletPositions(options = {}) {
  if (!TARGET_WALLET) {
    throw new Error('TARGET_WALLET is not configured');
  }
  return fetchWalletPositions(TARGET_WALLET, options);
}

/**
 * Retry-wrapped fetchMarket. Retries up to `maxAttempts` times with
 * `delayMs` between attempts. Used to wait for the market to be created
 * (Polymarket creates the next market a few seconds before the window opens).
 */
export async function fetchMarketWithRetry(slug, maxAttempts = 20, delayMs = 3_000) {
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const market = await fetchMarket(slug);
      return market;
    } catch (err) {
      last = err;
      logger.debug('market.js: market not ready yet, retrying...', {
        slug, attempt, err: err.message,
      });
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Market ${slug} not found after ${maxAttempts} attempts: ${last?.message}`);
}

/**
 * Poll until the market is resolved, then return.
 * Accepts either a slug string or a lookup object with `{ slug, conditionId }`.
 * Used by Trader after the window close to know when to call redeemPositions.
 */
export async function waitForResolution(target, timeoutMs = 400_000, pollMs = 10_000) {
  const slug = typeof target === 'string' ? target : target?.slug;
  const conditionId = typeof target === 'string' ? '' : (target?.conditionId ?? '');
  const start = Date.now();
  logger.info('market.js: waiting for resolution...', { slug: slug ?? null, conditionId: conditionId || null });
  while (Date.now() - start < timeoutMs) {
    try {
      let market = null;
      if (slug) {
        try {
          market = await fetchMarket(slug);
        } catch (err) {
          if (!conditionId || !String(err.message).startsWith('Market not found:')) {
            throw err;
          }
        }
      }
      if (!market && conditionId) {
        market = await fetchMarketByConditionId(conditionId);
      }
      if (market?.resolved) {
        logger.info('market.js: market resolved', {
          slug: market.slug ?? slug ?? null,
          conditionId: market.conditionId ?? conditionId ?? null,
        });
        return market;
      }
    } catch (err) {
      const message = String(err.message ?? '');
      const isTransientTimeout =
        message.includes('timeout of') ||
        message === 'aborted' ||
        err.code === 'ECONNABORTED';
      const notFound =
        message.startsWith('Market not found:') ||
        message.startsWith('Market not found for conditionId:');
      const log = (notFound || isTransientTimeout) ? logger.debug.bind(logger) : logger.warn.bind(logger);
      log('market.js: poll error', {
        slug: slug ?? null,
        conditionId: conditionId || null,
        err: message,
      });
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`Market ${slug ?? conditionId ?? '[unknown]'} did not resolve within ${timeoutMs / 1000}s`);
}

/**
 * Fetch the current BTC implied probability from the live market mid-price.
 * Useful for an optional directional overlay (extension).
 * Returns { upMid, downMid } where upMid + downMid should ≈ 1.
 */
export async function fetchMidPrices(market, clob) {
  const [upBook, downBook] = await Promise.all([
    clob.getBook(market.upToken.tokenId),
    clob.getBook(market.downToken.tokenId),
  ]);

  const mid = (book) => {
    if (!book.bids.length || !book.asks.length) return null;
    const bestBid = Math.max(...book.bids.map(b => b.price));
    const bestAsk = Math.min(...book.asks.map(a => a.price));
    return (bestBid + bestAsk) / 2;
  };

  return { upMid: mid(upBook), downMid: mid(downBook) };
}
