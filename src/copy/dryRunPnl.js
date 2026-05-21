import { EventEmitter } from 'events';
import logger from '../logger.js';
import { fetchWalletPositions, fetchWalletTrades, waitForResolution } from '../market.js';
import { PnlTracker } from '../pnl.js';

function normalizeOutcomeKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export class DryRunPnlTracker extends EventEmitter {
  constructor({ traderPnlSource = 'API' } = {}) {
    super();
    this.pnl = new PnlTracker();
    this._markets = new Map();
    this._settlementTasks = new Map();
    this._traderPnlSource = String(traderPnlSource ?? 'API').toUpperCase();
  }

  recordSimulatedCopy({ ev, shares, maxPrice, ourUsdc }) {
    const slug = ev.slug ?? ev.conditionId ?? ev.tokenId;
    const outcome = ev.outcome ?? ev.tokenId;
    const spent = shares * maxPrice;
    const market = this._getMarket(slug, {
      conditionId: ev.conditionId,
      question: ev.question,
    });

    market.copies.push({
      target: ev.target ?? null,
      outcome,
      shares,
      spent,
      maxPrice,
      targetPrice: ev.price,
      requestedUsdc: ourUsdc,
      recordedAt: Date.now(),
    });

    this.pnl.recordBuy(slug, outcome, maxPrice, shares);
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
      maxPrice,
      spent,
      requestedUsdc: ourUsdc,
      targetPrice: ev.price,
      timestamp: Date.now(),
    });
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
  }

  stats() {
    let openMarkets = 0;
    let settledMarkets = 0;
    let openCost = 0;
    let settledSpent = 0;
    let settledRedeemed = 0;

    for (const [slug, market] of this._markets) {
      const marketSpent = market.copies.reduce((sum, copy) => sum + copy.spent, 0);
      if (market.settled) {
        settledMarkets++;
        settledSpent += marketSpent;
        settledRedeemed += market.redeemed ?? 0;
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
        redeemed: 0,
        settled: false,
        settledAt: null,
        targetTrades: [],
        targetTradeKeys: new Set(),
      });
    }
    return this._markets.get(slug);
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
    this.pnl.recordRedeem(slug, redeemed, 'dry-run');

    logger.info('copy.dryRun: simulated market settled', {
      slug,
      question: market.question || resolvedMarket.question || null,
      copies: market.copies.length,
      redeemed: redeemed.toFixed(2),
      pnl: this.pnl.marketPnl(slug).toFixed(2),
      actualTraderPnl: market.actualTraderPnl,
      actualTraderPnlSource: market.actualTraderPnlSource,
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
      payouts,
      outcomes,
      settledAt: market.settledAt,
      copies: market.copies.map((copy) => ({ ...copy })),
    });
  }

  async _fetchActualTraderPnl(market) {
    const targets = [...new Set(market.copies.map((copy) => copy.target).filter(Boolean))];
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
      return { pnl: realizedTotal, source: 'realizedPnl', tradeCount: 0 };
    }
    return { pnl: cashTotal, source: 'cashPnl', tradeCount: 0 };
  }

  _fetchActualTraderPnlFromObservedTrades(market, targets) {
    const targetSet = new Set(targets.map((target) => target.toLowerCase()));
    const matches = market.targetTrades.filter((trade) => targetSet.has((trade.target ?? '').toLowerCase()));
    if (!matches.length) return null;

    const pnl = this._marketPnlFromTradeHistory(market, matches);
    if (pnl == null) return null;
    return {
      pnl,
      source: 'observedTargetTrades',
      tradeCount: matches.length,
    };
  }

  async _fetchActualTraderPnlFromTradeHistory(market, targets) {
    let pnlTotal = 0;
    let foundAny = false;
    let tradeCount = 0;

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

        const pnl = this._marketPnlFromTradeHistory(market, matches);
        if (pnl == null) continue;

        foundAny = true;
        pnlTotal += pnl;
        tradeCount += matches.length;
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
    return { pnl: pnlTotal, source: 'tradeHistory', tradeCount };
  }

  _marketPnlFromTradeHistory(market, trades) {
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

    return proceeds + redemption - spent;
  }

  _resolvedPayoutMap(market) {
    const payouts = market.resolvedPayouts ?? [];
    const outcomes = market.outcomes ?? [];
    return new Map(
      outcomes.map((outcome, index) => [normalizeOutcomeKey(outcome), Number(payouts[index] ?? 0)]),
    );
  }
}
