import { EventEmitter } from 'events';
import logger from '../logger.js';
import { fetchWalletPositions, fetchWalletTrades, waitForResolution } from '../market.js';
import { PnlTracker } from '../pnl.js';
import { PROXY_WALLET } from '../config.js';

function normalizeOutcomeKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export class CopyMarketTracker extends EventEmitter {
  constructor({ traderPnlSource = 'API' } = {}) {
    super();
    this.pnl = new PnlTracker();
    this._markets = new Map();
    this._settlementTasks = new Map();
    this._traderPnlSource = String(traderPnlSource ?? 'API').toUpperCase();
  }

  recordSimulatedCopy({ ev, shares, maxPrice, executionPrice, assumedSpent, ourUsdc, estimatedFee, feeRateBps, executionEstimate }) {
    const slug = ev.slug ?? ev.conditionId ?? ev.tokenId;
    const outcome = ev.outcome ?? ev.tokenId;
    const price = Number.isFinite(Number(executionPrice)) ? Number(executionPrice) : maxPrice;
    const spent = Number.isFinite(Number(assumedSpent)) ? Number(assumedSpent) : (shares * price);
    const market = this._getMarket(slug, {
      conditionId: ev.conditionId,
      question: ev.question,
    });

    market.copies.push({
      target: ev.target ?? null,
      outcome,
      shares,
      spent,
      feeEstimate: Number(estimatedFee ?? 0),
      feeRateBps: Number(feeRateBps ?? 0),
      executionEstimate: executionEstimate ?? null,
      executionPrice: price,
      maxPrice,
      targetPrice: ev.price,
      requestedUsdc: ourUsdc,
      recordedAt: Date.now(),
    });

    this.pnl.recordBuy(slug, outcome, price, shares);
    this._ensureSettlementWatch(slug, market);

    logger.info('copy.dryRun: simulated buy recorded', {
      slug,
      outcome,
      shares: shares.toFixed(4),
      maxPrice: maxPrice.toFixed(4),
      spent: spent.toFixed(2),
    });
    this.emit('recorded', {
      slug,
      conditionId: market.conditionId,
      question: market.question,
      outcome,
      shares,
      executionPrice: price,
      maxPrice,
      spent,
      requestedUsdc: ourUsdc,
      targetPrice: ev.price,
      timestamp: Date.now(),
    });
  }

  recordExecutedCopy({ ev, shares, maxPrice, assumedSpent, estimatedFee, feeRateBps }) {
    const slug = ev?.slug ?? ev?.conditionId ?? ev?.tokenId;
    if (!slug) return;

    const market = this._getMarket(slug, {
      conditionId: ev.conditionId,
      question: ev.question,
    });
    const dedupeKey = [
      ev.txHash ?? '',
      ev.tokenId ?? '',
      ev.outcome ?? '',
      Number(maxPrice ?? 0).toFixed(12),
      Number(shares ?? 0).toFixed(12),
      Number(assumedSpent ?? 0).toFixed(12),
    ].join(':');

    if (market.ownTradeKeys.has(dedupeKey)) return;
    market.ownTradeKeys.add(dedupeKey);
    market.ownTrades.push({
      target: PROXY_WALLET?.toLowerCase?.() ?? '',
      tokenId: ev.tokenId ?? null,
      conditionId: ev.conditionId?.toLowerCase?.() ?? '',
      side: 'BUY',
      outcome: ev.outcome ?? null,
      price: Number(maxPrice ?? 0),
      size: Number(shares ?? 0),
      usdc: Number(assumedSpent ?? 0),
      feeEstimate: Number(estimatedFee ?? 0),
      feeRateBps: Number(feeRateBps ?? 0),
      timestamp: Date.now(),
      txHash: ev.txHash?.toLowerCase?.() ?? '',
      slug: ev.slug ?? null,
    });
    this._ensureSettlementWatch(slug, market);
  }

  recordObservedTargetTrade(ev) {
    const slug = ev?.slug ?? ev?.conditionId ?? ev?.tokenId;
    if (!slug) return;

    const market = this._getMarket(slug, {
      conditionId: ev.conditionId,
      question: ev.question,
    });
    const dedupeKey = [
      ev.txHash ?? '',
      ev.tokenId ?? '',
      ev.outcome ?? '',
      ev.side ?? '',
      Number(ev.price ?? 0).toFixed(12),
      Number(ev.size ?? 0).toFixed(12),
      Number(ev.usdc ?? 0).toFixed(12),
      ev.target ?? '',
    ].join(':');

    if (market.targetTradeKeys.has(dedupeKey)) return;
    market.targetTradeKeys.add(dedupeKey);
    market.targetTrades.push({
      target: ev.target ?? null,
      tokenId: ev.tokenId ?? null,
      conditionId: ev.conditionId?.toLowerCase?.() ?? '',
      side: String(ev.side ?? 'BUY').toUpperCase(),
      outcome: ev.outcome ?? null,
      price: Number(ev.price ?? 0),
      size: Number(ev.size ?? 0),
      usdc: Number(ev.usdc ?? 0),
      timestamp: Number(ev.timestamp ?? 0),
      txHash: ev.txHash?.toLowerCase?.() ?? '',
      slug: ev.slug ?? null,
    });
    this._ensureSettlementWatch(slug, market);
  }

  recordSkippedTrade({ ev, reason, phase, hypothetical }) {
    const slug = ev?.slug ?? ev?.conditionId ?? ev?.tokenId;
    if (!slug) return;

    const market = this._getMarket(slug, {
      conditionId: ev.conditionId,
      question: ev.question,
    });
    const dedupeKey = [
      ev.txHash ?? '',
      ev.tokenId ?? '',
      ev.outcome ?? '',
      reason ?? '',
      phase ?? '',
      Number(hypothetical?.maxPrice ?? 0).toFixed(12),
      Number(hypothetical?.shares ?? 0).toFixed(12),
    ].join(':');

    if (market.skippedTradeKeys.has(dedupeKey)) return;
    market.skippedTradeKeys.add(dedupeKey);
    market.skippedTrades.push({
      reason: reason ?? '',
      phase: phase ?? '',
      outcome: ev.outcome ?? null,
      target: ev.target ?? null,
      tokenId: ev.tokenId ?? null,
      conditionId: ev.conditionId?.toLowerCase?.() ?? '',
      price: Number(ev.price ?? 0),
      maxPrice: Number(hypothetical?.maxPrice ?? 0),
      shares: Number(hypothetical?.shares ?? 0),
      spent: Number(hypothetical?.hypotheticalSpent ?? 0),
      desiredUsdc: Number(hypothetical?.desiredUsdc ?? 0),
      timestamp: Date.now(),
      txHash: ev.txHash?.toLowerCase?.() ?? '',
      slug: ev.slug ?? null,
    });
    this._ensureSettlementWatch(slug, market);
  }

  stats() {
    let openMarkets = 0;
    let settledMarkets = 0;
    let openCost = 0;
    let settledSpent = 0;
    let settledRedeemed = 0;
    let targetSettledMarkets = 0;
    let targetSettledSpent = 0;
    let targetSettledRedeemed = 0;
    let targetSettledPnl = 0;
    let ownSettledMarkets = 0;
    let ownSettledSpent = 0;
    let ownSettledRedeemed = 0;
    let ownSettledPnl = 0;
    let skippedSettledTrades = 0;
    let skippedSettledSpent = 0;
    let skippedSettledRedeemed = 0;
    let skippedSettledPnl = 0;

    for (const [slug, market] of this._markets) {
      const marketSpent = market.copies.reduce((sum, copy) => sum + copy.spent, 0);
      if (market.settled) {
        settledMarkets++;
        settledSpent += marketSpent;
        settledRedeemed += market.redeemed ?? 0;
        if (Number.isFinite(market.actualTraderPnl)) {
          targetSettledMarkets++;
          targetSettledPnl += market.actualTraderPnl;
        }
        if (Number.isFinite(market.actualTraderSpent)) {
          targetSettledSpent += market.actualTraderSpent;
        }
        if (Number.isFinite(market.actualTraderRedeemed)) {
          targetSettledRedeemed += market.actualTraderRedeemed;
        }
        if (Number.isFinite(market.ownTraderPnl)) {
          ownSettledMarkets++;
          ownSettledPnl += market.ownTraderPnl;
        }
        if (Number.isFinite(market.ownTraderSpent)) {
          ownSettledSpent += market.ownTraderSpent;
        }
        if (Number.isFinite(market.ownTraderRedeemed)) {
          ownSettledRedeemed += market.ownTraderRedeemed;
        }
        skippedSettledTrades += Number(market.skippedTradeCount ?? 0);
        if (Number.isFinite(market.skippedSpent)) {
          skippedSettledSpent += market.skippedSpent;
        }
        if (Number.isFinite(market.skippedRedeemed)) {
          skippedSettledRedeemed += market.skippedRedeemed;
        }
        if (Number.isFinite(market.skippedPnl)) {
          skippedSettledPnl += market.skippedPnl;
        }
      } else {
        openMarkets++;
        openCost += marketSpent;
      }
    }

    return {
      dryRunMarketsOpen: openMarkets,
      dryRunMarketsSettled: settledMarkets,
      dryRunOpenCost: openCost.toFixed(2),
      dryRunSettledSpent: settledSpent.toFixed(2),
      dryRunSettledRedeemed: settledRedeemed.toFixed(2),
      dryRunSettledPnl: (settledRedeemed - settledSpent).toFixed(2),
      targetSettledMarkets,
      targetSettledSpent: targetSettledSpent.toFixed(2),
      targetSettledRedeemed: targetSettledRedeemed.toFixed(2),
      targetSettledPnl: targetSettledPnl.toFixed(2),
      ownSettledMarkets,
      ownSettledSpent: ownSettledSpent.toFixed(2),
      ownSettledRedeemed: ownSettledRedeemed.toFixed(2),
      ownSettledPnl: ownSettledPnl.toFixed(2),
      skippedSettledTrades,
      skippedSettledSpent: skippedSettledSpent.toFixed(2),
      skippedSettledRedeemed: skippedSettledRedeemed.toFixed(2),
      skippedSettledPnl: skippedSettledPnl.toFixed(2),
    };
  }

  printSummary() {
    logger.info('copy.dryRun: session summary', this.stats());
    this.pnl.printSessionSummary();
  }

  snapshot() {
    return {
      stats: this.stats(),
      markets: [...this._markets.entries()].map(([slug, market]) => ({
        slug,
        conditionId: market.conditionId,
        question: market.question,
        actualTraderPnl: market.actualTraderPnl ?? null,
        actualTraderPnlSource: market.actualTraderPnlSource ?? null,
        actualTraderTradeCount: market.actualTraderTradeCount ?? 0,
        actualTraderSpent: market.actualTraderSpent ?? null,
        actualTraderRedeemed: market.actualTraderRedeemed ?? null,
        ownTraderPnl: market.ownTraderPnl ?? null,
        ownTraderPnlSource: market.ownTraderPnlSource ?? null,
        ownTraderTradeCount: market.ownTraderTradeCount ?? 0,
        ownTraderSpent: market.ownTraderSpent ?? null,
        ownTraderRedeemed: market.ownTraderRedeemed ?? null,
        skippedTradeCount: market.skippedTradeCount ?? 0,
        skippedSpent: market.skippedSpent ?? null,
        skippedRedeemed: market.skippedRedeemed ?? null,
        skippedPnl: market.skippedPnl ?? null,
        redeemed: market.redeemed,
        settled: market.settled,
        settledAt: market.settledAt,
        copies: market.copies.map((copy) => ({ ...copy })),
      })),
    };
  }

  _getMarket(slug, meta = {}) {
    if (!this._markets.has(slug)) {
      this._markets.set(slug, {
        slug,
        conditionId: meta.conditionId ?? '',
        question: meta.question ?? '',
        copies: [],
        actualTraderPnl: null,
        actualTraderPnlSource: null,
        actualTraderTradeCount: 0,
        actualTraderSpent: null,
        actualTraderRedeemed: null,
        ownTraderPnl: null,
        ownTraderPnlSource: null,
        ownTraderTradeCount: 0,
        ownTraderSpent: null,
        ownTraderRedeemed: null,
        skippedTradeCount: 0,
        skippedSpent: null,
        skippedRedeemed: null,
        skippedPnl: null,
        redeemed: 0,
        settled: false,
        settledAt: null,
        targetTrades: [],
        targetTradeKeys: new Set(),
        ownTrades: [],
        ownTradeKeys: new Set(),
        skippedTrades: [],
        skippedTradeKeys: new Set(),
      });
    }
    const market = this._markets.get(slug);
    if (!market.conditionId && meta.conditionId) market.conditionId = meta.conditionId;
    if (!market.question && meta.question) market.question = meta.question;
    return market;
  }

  _ensureSettlementWatch(slug, marketMeta = null) {
    if (this._settlementTasks.has(slug)) return;

    const task = (async () => {
      try {
        const market = await waitForResolution({
          slug,
          conditionId: marketMeta?.conditionId ?? this._markets.get(slug)?.conditionId ?? '',
        }, 12 * 60 * 60 * 1000, 10_000);
        await this._settleMarket(slug, market);
      } catch (err) {
        logger.warn('copy.dryRun: failed to settle simulated market', {
          slug,
          err: err.message,
        });
      } finally {
        this._settlementTasks.delete(slug);
      }
    })();

    this._settlementTasks.set(slug, task);
  }

  async _settleMarket(slug, resolvedMarket) {
    const market = this._markets.get(slug);
    if (!market || market.settled) return;

    const payouts = resolvedMarket.resolvedPayouts ?? [];
    const outcomes = resolvedMarket.outcomes ?? [];
    const payoutByOutcome = new Map(
      outcomes.map((outcome, index) => [normalizeOutcomeKey(outcome), Number(payouts[index] ?? 0)]),
    );

    let redeemed = 0;
    for (const copy of market.copies) {
      const payoutPerShare = payoutByOutcome.get(normalizeOutcomeKey(copy.outcome)) ?? 0;
      redeemed += copy.shares * payoutPerShare;
    }

    market.settled = true;
    market.redeemed = redeemed;
    market.settledAt = Date.now();
    market.outcomes = outcomes;
    market.resolvedPayouts = payouts;
    const actualTraderPnl = await this._fetchActualTraderPnl(market);
    market.actualTraderPnl = actualTraderPnl?.pnl ?? null;
    market.actualTraderPnlSource = actualTraderPnl?.source ?? null;
    market.actualTraderTradeCount = actualTraderPnl?.tradeCount ?? 0;
    market.actualTraderSpent = actualTraderPnl?.spent ?? null;
    market.actualTraderRedeemed = actualTraderPnl?.redeemed ?? null;
    const ownTraderPnl = await this._fetchOwnTraderPnl(market);
    market.ownTraderPnl = ownTraderPnl?.pnl ?? null;
    market.ownTraderPnlSource = ownTraderPnl?.source ?? null;
    market.ownTraderTradeCount = ownTraderPnl?.tradeCount ?? 0;
    market.ownTraderSpent = ownTraderPnl?.spent ?? null;
    market.ownTraderRedeemed = ownTraderPnl?.redeemed ?? null;
    const skippedSummary = this._summarizeSkippedTrades(market);
    market.skippedTradeCount = skippedSummary?.tradeCount ?? 0;
    market.skippedSpent = skippedSummary?.spent ?? null;
    market.skippedRedeemed = skippedSummary?.redeemed ?? null;
    market.skippedPnl = skippedSummary?.pnl ?? null;
    this.pnl.recordRedeem(slug, redeemed, 'dry-run');

    logger.info('copy.dryRun: simulated market settled', {
      slug,
      question: market.question || resolvedMarket.question || null,
      copies: market.copies.length,
      redeemed: redeemed.toFixed(2),
      pnl: this.pnl.marketPnl(slug).toFixed(2),
      actualTraderPnl: market.actualTraderPnl,
      actualTraderPnlSource: market.actualTraderPnlSource,
      ownTraderPnl: market.ownTraderPnl,
      ownTraderPnlSource: market.ownTraderPnlSource,
      skippedPnl: market.skippedPnl,
      skippedTradeCount: market.skippedTradeCount,
      payouts,
      outcomes,
    });
    this.emit('settled', {
      slug,
      question: market.question || resolvedMarket.question || null,
      redeemed,
      pnl: this.pnl.marketPnl(slug),
      actualTraderPnl: market.actualTraderPnl,
      actualTraderPnlSource: market.actualTraderPnlSource,
      ownTraderPnl: market.ownTraderPnl,
      ownTraderPnlSource: market.ownTraderPnlSource,
      skippedPnl: market.skippedPnl,
      skippedTradeCount: market.skippedTradeCount,
      payouts,
      outcomes,
      settledAt: market.settledAt,
      copies: market.copies.map((copy) => ({ ...copy })),
    });
  }

  async _fetchActualTraderPnl(market) {
    const targets = [...new Set([
      ...market.copies.map((copy) => copy.target),
      ...market.targetTrades.map((trade) => trade.target),
    ].filter(Boolean))];
    if (!targets.length) return null;

    if (this._traderPnlSource === 'OBSERVED') {
      return this._fetchActualTraderPnlFromObservedTrades(market, targets);
    }

    if (this._traderPnlSource === 'AUTO') {
      const observedPnl = this._fetchActualTraderPnlFromObservedTrades(market, targets);
      if (observedPnl) return observedPnl;
    }

    const historyPnl = await this._fetchActualTraderPnlFromTradeHistory(market, targets);
    if (historyPnl) return historyPnl;

    if (this._traderPnlSource === 'API') return null;

    let realizedTotal = 0;
    let cashTotal = 0;
    let foundAny = false;

    for (const target of targets) {
      try {
        const positions = await fetchWalletPositions(target, {
          sizeThreshold: 0,
          limit: 500,
        });
        const matches = positions.filter((position) =>
          (market.conditionId && position.conditionId?.toLowerCase() === market.conditionId.toLowerCase()) ||
          (market.slug && position.slug === market.slug)
        );
        if (!matches.length) continue;

        foundAny = true;
        realizedTotal += matches.reduce((sum, position) => sum + Number(position.realizedPnl ?? 0), 0);
        cashTotal += matches.reduce((sum, position) => sum + Number(position.cashPnl ?? 0), 0);
      } catch (err) {
        logger.debug('copy.dryRun: unable to fetch target trader pnl', {
          target,
          conditionId: market.conditionId,
          err: err.message,
        });
      }
    }

    if (!foundAny) return null;
    if (Math.abs(realizedTotal) > 1e-9) {
      return { pnl: realizedTotal, source: 'realizedPnl', tradeCount: 0, spent: null, redeemed: null };
    }
    return { pnl: cashTotal, source: 'cashPnl', tradeCount: 0, spent: null, redeemed: null };
  }

  async _fetchOwnTraderPnl(market) {
    const wallet = PROXY_WALLET?.toLowerCase?.();
    if (!wallet) return null;

    if (this._traderPnlSource === 'OBSERVED') {
      return this._fetchOwnTraderPnlFromObservedTrades(market);
    }

    if (this._traderPnlSource === 'AUTO') {
      const observedPnl = this._fetchOwnTraderPnlFromObservedTrades(market);
      if (observedPnl) return observedPnl;
    }

    const trades = await fetchWalletTrades(wallet, {
      limit: 10_000,
      maxPages: 2,
      takerOnly: false,
      markets: market.conditionId ? [market.conditionId] : [],
    });
    const matches = trades.filter((trade) =>
      (market.conditionId && trade.conditionId === market.conditionId.toLowerCase()) ||
      (market.slug && trade.slug === market.slug)
    );
    if (matches.length) {
      const summary = this._marketTradeSummary(market, matches);
      if (summary) {
        return {
          pnl: summary.pnl,
          source: 'tradeHistory',
          tradeCount: matches.length,
          spent: summary.spent,
          redeemed: summary.redemption,
        };
      }
    }

    if (this._traderPnlSource === 'API') return null;
    return this._fetchOwnTraderPnlFromObservedTrades(market);
  }

  _fetchActualTraderPnlFromObservedTrades(market, targets) {
    const targetSet = new Set(targets.map((target) => target.toLowerCase()));
    const matches = market.targetTrades.filter((trade) => targetSet.has((trade.target ?? '').toLowerCase()));
    if (!matches.length) return null;

    const summary = this._marketTradeSummary(market, matches);
    if (!summary) return null;
    return {
      pnl: summary.pnl,
      source: 'observedTargetTrades',
      tradeCount: matches.length,
      spent: summary.spent,
      redeemed: summary.redemption,
    };
  }

  _fetchOwnTraderPnlFromObservedTrades(market) {
    if (!market.ownTrades.length) return null;
    const summary = this._marketTradeSummary(market, market.ownTrades);
    if (!summary) return null;
    return {
      pnl: summary.pnl,
      source: 'observedOwnTrades',
      tradeCount: market.ownTrades.length,
      spent: summary.spent,
      redeemed: summary.redemption,
    };
  }

  async _fetchActualTraderPnlFromTradeHistory(market, targets) {
    let pnlTotal = 0;
    let foundAny = false;
    let tradeCount = 0;
    let spentTotal = 0;
    let redeemedTotal = 0;

    for (const target of targets) {
      try {
        const trades = await fetchWalletTrades(target, {
          limit: 10_000,
          maxPages: 2,
          takerOnly: false,
          markets: market.conditionId ? [market.conditionId] : [],
        });
        const matches = trades.filter((trade) =>
          (market.conditionId && trade.conditionId === market.conditionId.toLowerCase()) ||
          (market.slug && trade.slug === market.slug)
        );
        if (!matches.length) continue;

        const summary = this._marketTradeSummary(market, matches);
        if (!summary) continue;

        foundAny = true;
        pnlTotal += summary.pnl;
        tradeCount += matches.length;
        spentTotal += summary.spent;
        redeemedTotal += summary.redemption;
      } catch (err) {
        logger.debug('copy.dryRun: unable to rebuild target trader pnl from trade history', {
          target,
          slug: market.slug,
          conditionId: market.conditionId,
          err: err.message,
        });
      }
    }

    if (!foundAny) return null;
    return {
      pnl: pnlTotal,
      source: 'tradeHistory',
      tradeCount,
      spent: spentTotal,
      redeemed: redeemedTotal,
    };
  }

  _marketPnlFromTradeHistory(market, trades) {
    const summary = this._marketTradeSummary(market, trades);
    return summary?.pnl ?? null;
  }

  _marketTradeSummary(market, trades) {
    const payoutByOutcome = this._resolvedPayoutMap(market);
    if (!payoutByOutcome.size) return null;

    let spent = 0;
    let proceeds = 0;
    const netSharesByOutcome = new Map();

    for (const trade of trades) {
      if (!Number.isFinite(trade.price) || !Number.isFinite(trade.size) || trade.size <= 0) continue;

      const outcomeKey = normalizeOutcomeKey(trade.outcome);
      const currentShares = netSharesByOutcome.get(outcomeKey) ?? 0;
      const notional = Number.isFinite(trade.usdc) && trade.usdc > 0
        ? trade.usdc
        : trade.price * trade.size;

      if (trade.side === 'BUY') {
        spent += notional;
        netSharesByOutcome.set(outcomeKey, currentShares + trade.size);
      } else if (trade.side === 'SELL') {
        proceeds += notional;
        netSharesByOutcome.set(outcomeKey, currentShares - trade.size);
      }
    }

    let redemption = 0;
    for (const [outcomeKey, shares] of netSharesByOutcome) {
      if (shares <= 0) continue;
      redemption += shares * (payoutByOutcome.get(outcomeKey) ?? 0);
    }

    return {
      spent,
      proceeds,
      redemption,
      pnl: proceeds + redemption - spent,
    };
  }

  _summarizeSkippedTrades(market) {
    const payoutByOutcome = this._resolvedPayoutMap(market);
    if (!payoutByOutcome.size || !market.skippedTrades.length) return null;

    let spent = 0;
    let redeemed = 0;
    for (const trade of market.skippedTrades) {
      if (!Number.isFinite(trade.shares) || trade.shares <= 0) continue;
      spent += Number(trade.spent ?? 0);
      redeemed += trade.shares * (payoutByOutcome.get(normalizeOutcomeKey(trade.outcome)) ?? 0);
    }

    return {
      tradeCount: market.skippedTrades.length,
      spent,
      redeemed,
      pnl: redeemed - spent,
    };
  }

  _resolvedPayoutMap(market) {
    const payouts = market.resolvedPayouts ?? [];
    const outcomes = market.outcomes ?? [];
    return new Map(
      outcomes.map((outcome, index) => [normalizeOutcomeKey(outcome), Number(payouts[index] ?? 0)]),
    );
  }
}
