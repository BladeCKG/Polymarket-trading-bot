import logger from '../logger.js';
import { waitForResolution } from '../market.js';
import { PnlTracker } from '../pnl.js';

function normalizeOutcomeKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export class DryRunPnlTracker {
  constructor() {
    this.pnl = new PnlTracker();
    this._markets = new Map();
    this._settlementTasks = new Map();
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

  _getMarket(slug, meta = {}) {
    if (!this._markets.has(slug)) {
      this._markets.set(slug, {
        conditionId: meta.conditionId ?? '',
        question: meta.question ?? '',
        copies: [],
        redeemed: 0,
        settled: false,
        settledAt: null,
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
        this._settleMarket(slug, market);
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

  _settleMarket(slug, resolvedMarket) {
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
    this.pnl.recordRedeem(slug, redeemed, 'dry-run');

    logger.info('copy.dryRun: simulated market settled', {
      slug,
      question: market.question || resolvedMarket.question || null,
      copies: market.copies.length,
      redeemed: redeemed.toFixed(2),
      pnl: this.pnl.marketPnl(slug).toFixed(2),
      payouts,
      outcomes,
    });
  }
}
