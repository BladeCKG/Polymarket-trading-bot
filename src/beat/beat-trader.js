/**
 * beat-trader.js  (BEAT v2 — 다중 거래소 데이터 + 근사-완벽 확률 모델)
 * ───────────────────────────────────────────────────────────────────────────
 * 한 개의 Polymarket BTC(또는 기타 심볼) 5분 Up/Down 마켓을 처음부터 끝까지
 * 처리하는 상태기계.
 *
 * 전략(사용자 요구사항):
 *   "지금 시점에서 5분 종료 시 가격이 오를/내릴 확률"을 가능한 한 정확히 계산한다.
 *   모델 공정확률(fair prob)이 해당 사이드의 ask 보다 (요구 엣지 이상) 높으면,
 *   그 사이드가 시장에서 저평가된 것이므로 지금 매수한다. 이후 반대편이 충분히
 *   싸지면 pair(Up+Down) 를 완성해 무위험 차익을 고정한다.
 *
 * 데이터:
 *   - ExchangeHub        : 다중 현물 거래소 체결/호가/오더북/거래량 → 합의가·OBI·CVD·마이크로프라이스
 *   - PolymarketMarketFeed: PM Up/Down 오더북·BBO·체결흐름(OFI)·내재확률
 *   - BtcPriceFeed       : 윈도우 오픈 시점 기준가(beat price) 정확 포착(과거 캔들)
 *
 * 모델: computeFairProbability (drift-diffusion + 미시구조 신호 융합)
 */
import { BEAT_LIFECYCLE } from './lifecycle.js';
import { createBeatRuntimeConfig } from './runtime-config.js';
import { computeFairProbability } from './probability-model.js';
import { ClobClient } from '../clob.js';
import { getTokenBalances, sleep } from '../onchain.js';
import { msUntil, waitForResolution } from '../market.js';
import { getMarketLogFilePath, marketFileLogger, marketLogger } from '../logger.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function positiveFiniteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function traderSymbol(market, config) {
  const marketSymbol = String(market?.marketSymbol ?? '').trim().toUpperCase();
  if (marketSymbol) return marketSymbol;
  const symbols = Array.isArray(config?.BEAT_SYMBOLS) ? config.BEAT_SYMBOLS : [];
  return String(symbols[0] ?? 'BTC').trim().toUpperCase();
}

/**
 * 책(book)에서 maxPrice 이하로 targetShares 만큼 살 때의 체결 추정.
 */
function estimateSharesFromBook(book, maxPrice, targetShares) {
  const asks = Array.isArray(book?.asks) ? [...book.asks] : [];
  const eligible = asks
    .filter((row) => Number.isFinite(row.price) && Number.isFinite(row.size) && row.price > 0 && row.size > 0 && row.price <= maxPrice)
    .sort((a, b) => a.price - b.price);
  let remaining = Number(targetShares ?? 0);
  let fillShares = 0;
  let spentUsdc = 0;
  const fills = [];
  for (const ask of eligible) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, ask.size);
    fillShares += take;
    spentUsdc += take * ask.price;
    fills.push({ price: ask.price, shares: take, spentUsdc: take * ask.price });
    remaining -= take;
  }
  return {
    fillShares,
    spentUsdc,
    avgFillPrice: fillShares > 0 ? spentUsdc / fillShares : null,
    fills,
    fullyFilled: remaining <= 1e-6,
  };
}

export class BeatTrader {
  constructor(
    market,
    wallet,
    pnl,
    { dashboard = null, hub = null, beatPriceFeed = null, pmFeed = null, fillFeed = null, config = null, onSettled = null } = {},
  ) {
    this.market = market;
    this.wallet = wallet;
    this.pnl = pnl;
    this.dashboard = dashboard;
    this.hub = hub;
    this.beatPriceFeed = beatPriceFeed;
    this.pmFeed = pmFeed;
    this._ownsPmFeed = !pmFeed;
    this._fillFeed = fillFeed;
    this.onSettled = typeof onSettled === 'function' ? onSettled : null;
    this.config = config ?? createBeatRuntimeConfig();
    this.log = marketLogger(market.slug);
    this.auditLog = marketFileLogger(market.slug);

    this.lifecycle = BEAT_LIFECYCLE.UPCOMING;
    this.halted = false;
    this.beatPrice = null;
    this.totalSpent = 0;
    this.settledPayoutUsdc = 0;
    this.lastBuyAt = 0;
    this.lastOutcome = null;
    this.lastSettledAt = null;

    // 로트/페어 회계.
    this.openLots = { Up: [], Down: [] };   // { id, shares, avgPrice, costUsdc }
    this.pairedLots = [];                    // { shares, costUsdc }  (cost < 1 → 고정 이익)
    this._nextLotId = 1;

    // 대시보드 요약.
    this.tradeSummary = {
      chosenSide: null,
      buyShares: 0,
      buyUsdc: 0,
      buyPrice: null,
      buyCount: 0,
      buyEvents: [],
      pairEvents: [],
      pairedShares: 0,
      pairedCostUsdc: 0,
      pairedFeeUsdc: 0,
      averagePairedCost: null,
      unpairedUpShares: 0,
      unpairedDownShares: 0,
      lockedProfitUsdc: 0,
      moveAtBuyUsd: null,
      moveAtBuyPct: null,
      btcPriceAtBuy: null,
    };

    this.walletBalanceUp = 0;
    this.walletBalanceDown = 0;
    this._tokenFeeInfo = new Map();
    this._loopCount = 0;
    // 엣지 지속성(연속 스냅샷 동안 임계 이상 유지된 횟수). 단발 outlier 진입 방지.
    this._edgeStreak = { Up: 0, Down: 0 };
  }

  // ── 메인 라이프사이클 ────────────────────────────────────────────────────────
  async run() {
    const cfg = this.config;
    const { windowTs, conditionId, upToken, downToken } = this.market;
    const windowClose = windowTs + cfg.MARKET_WINDOW_SECONDS;

    this.log.info('BeatTrader v2: starting', {
      conditionId,
      symbol: traderSymbol(this.market, cfg),
      dryRun: cfg.BEAT_DRY_RUN,
      windowOpen: new Date(windowTs * 1000).toISOString(),
      windowClose: new Date(windowClose * 1000).toISOString(),
      exchanges: cfg.BEAT_EXCHANGES,
    });
    this._recordAudit('market_start', {
      conditionId,
      upTokenId: upToken.tokenId,
      downTokenId: downToken.tokenId,
      windowTs,
      windowClose,
      auditLogPath: getMarketLogFilePath(this.market.slug),
      config: {
        dryRun: cfg.BEAT_DRY_RUN,
        exchanges: cfg.BEAT_EXCHANGES,
        requiredEdge: cfg.BEAT_PROBABILITY_REQUIRED_EDGE,
        pairCostMax: cfg.BEAT_ARB_PAIR_COST_MAX,
        orderMode: cfg.BEAT_ORDER_MODE,
        orderSizeUsdc: cfg.BEAT_ORDER_SIZE_USDC,
        maxSpendPerMarket: cfg.MAX_SPEND_PER_MARKET,
        modelWeights: {
          momentum: cfg.BEAT_MODEL_MOMENTUM_WEIGHT,
          obi: cfg.BEAT_MODEL_OBI_WEIGHT,
          cvd: cfg.BEAT_MODEL_CVD_WEIGHT,
          microprice: cfg.BEAT_MODEL_MICROPRICE_WEIGHT,
        },
      },
    });

    // Polymarket 마켓 피드 시작.
    if (!this.pmFeed) {
      const { PolymarketMarketFeed } = await import('./polymarket-feed.js');
      this.pmFeed = new PolymarketMarketFeed({
        upTokenId: upToken.tokenId,
        downTokenId: downToken.tokenId,
        ofiConfig: {
          enabled: cfg.BEAT_OFI_ENABLED,
          windowMs: cfg.BEAT_OFI_WINDOW_MS,
          toxicityThreshold: cfg.BEAT_OFI_TOXICITY_THRESHOLD,
          ratioEnter: cfg.BEAT_OFI_RATIO_ENTER,
          ratioExit: cfg.BEAT_OFI_RATIO_EXIT,
          exitRatio: cfg.BEAT_OFI_EXIT_RATIO,
        },
      });
    }
    if (this._ownsPmFeed) this.pmFeed.start();

    // 토큰별 테이커 수수료(bps)를 1회 조회해 캐싱(윈도우 내 변동 거의 없음).
    await this._primeTokenFees();

    // 온체인 체결 피드에 이 마켓의 토큰을 등록(라이브 모드에서 실제 체결 확정용).
    if (this._fillFeed) {
      this._fillFeed.trackTokens([upToken.tokenId, downToken.tokenId]);
    }

    try {
      // 1) 오픈 대기.
      const waitMs = msUntil(windowTs);
      if (waitMs > 0) {
        this._recordAudit('wait_for_market_open', { waitMs: Math.round(waitMs) });
        await sleep(waitMs);
      }

      // 2) 기준가(beat price) 포착 — 윈도우 오픈 시점의 정확한 과거 가격.
      try {
        this.beatPrice = await this._captureBeatPrice(windowTs);
      } catch (err) {
        this.lifecycle = BEAT_LIFECYCLE.HALTED;
        this.halted = true;
        this.log.warn('BeatTrader v2: beat price capture failed, halting', { err: err.message });
        this._recordAudit('beat_price_capture_failed', { err: err.message, windowTs });
        this._publishMarket({ lifecycle: BEAT_LIFECYCLE.HALTED, tradeStatus: BEAT_LIFECYCLE.HALTED });
        return;
      }

      // 3) 엔트리 지연.
      const firstAllowedMs = (windowTs + Number(cfg.BEAT_ENTRY_DELAY_SECONDS || 0)) * 1000;
      const skipMs = firstAllowedMs - Date.now();
      if (skipMs > 0) {
        this.lifecycle = BEAT_LIFECYCLE.WAITING_SKIP;
        this._publishMarket({ lifecycle: BEAT_LIFECYCLE.WAITING_SKIP, tradeStatus: BEAT_LIFECYCLE.WAITING_SKIP });
        this._recordAudit('wait_for_entry', { skipMs: Math.round(skipMs), beatPrice: this.beatPrice });
        await sleep(skipMs);
      }

      // 4) 모니터링/매매 루프.
      this.lifecycle = BEAT_LIFECYCLE.MONITORING;
      this._publishMarket({ lifecycle: BEAT_LIFECYCLE.MONITORING, tradeStatus: BEAT_LIFECYCLE.MONITORING });
      await this._syncBalances();
      await this._monitorLoop(windowClose);

      this.lifecycle = BEAT_LIFECYCLE.RESOLVING;
      this._publishMarket({ lifecycle: BEAT_LIFECYCLE.RESOLVING, tradeStatus: BEAT_LIFECYCLE.RESOLVING });
    } finally {
      if (this._ownsPmFeed) this.pmFeed?.stop();
    }

    // 5) 정산/리딤.
    const settled = await this._redeemPhase(conditionId, windowClose);
    if (!settled) {
      this._recordAudit('market_resolution_pending', {
        beatPrice: this.beatPrice,
        totalSpent: this.totalSpent,
        settledPayoutUsdc: this.settledPayoutUsdc,
      });
      return;
    }

    this.lifecycle = BEAT_LIFECYCLE.SETTLED;
    this.log.info('BeatTrader v2: complete', {
      beatPrice: this.beatPrice,
      totalSpent: this.totalSpent.toFixed(4),
      settledPayoutUsdc: this.settledPayoutUsdc.toFixed(4),
      netPnl: (this.settledPayoutUsdc - this.totalSpent).toFixed(4),
    });
    this._recordAudit('market_complete', {
      beatPrice: this.beatPrice,
      totalSpent: this.totalSpent,
      settledPayoutUsdc: this.settledPayoutUsdc,
      netPnl: this.settledPayoutUsdc - this.totalSpent,
      tradeSummary: this.tradeSummary,
      outcome: this.lastOutcome,
    });
  }

  // ── 기준가 포착 ───────────────────────────────────────────────────────────────
  async _captureBeatPrice(windowTs) {
    const windowOpenMs = windowTs * 1000;
    const deadline = Date.now() + 20_000;
    let tick = null;
    let lastErr = null;
    while (Date.now() <= deadline) {
      try {
        tick = await this.beatPriceFeed.fetchHistoricalTickAt(windowOpenMs);
        break;
      } catch (err) {
        lastErr = err;
        await sleep(500);
      }
    }
    if (!tick || !Number.isFinite(Number(tick.price))) {
      throw new Error(`Historical beat price unavailable for ${new Date(windowOpenMs).toISOString()}${lastErr ? `: ${lastErr.message}` : ''}`);
    }
    if (!tick.historical || Number(tick.timeMs) !== windowOpenMs) {
      throw new Error(`Beat tick not aligned to window open ${new Date(windowOpenMs).toISOString()}`);
    }
    this.log.info('BeatTrader v2: captured beat price', { beatPrice: tick.price, source: tick.source, btcTime: tick.isoTime });
    this._publishMarket({ lifecycle: BEAT_LIFECYCLE.WAITING_SKIP, beatPrice: tick.price });
    this._recordAudit('beat_price_captured', { beatPrice: tick.price, source: tick.source, btcTime: tick.isoTime });
    return tick.price;
  }

  // ── 모니터링 루프 ──────────────────────────────────────────────────────────────
  async _monitorLoop(windowClose) {
    const cfg = this.config;
    const stopBuyingTs = windowClose - Number(cfg.BEAT_STOP_BUYING_BEFORE_CLOSE_SECONDS || 0);
    while (true) {
      const nowSec = Math.floor(Date.now() / 1000);
      this._loopCount += 1;
      if (nowSec >= windowClose) {
        this._recordAudit('monitor_window_closed', { loop: this._loopCount });
        break;
      }
      if (this.halted) break;

      try {
        const snapshot = this._buildSnapshot();
        const model = this._evaluateModel(snapshot);
        this._recordSnapshotAudit(snapshot, model);
        this._publishSnapshot(snapshot, model);

        // 엣지 지속성 갱신(매 스냅샷). 단발 outlier 면 streak 가 리셋된다.
        this._updateEdgeStreak(snapshot, model);

        const allowNewBuys = nowSec < stopBuyingTs;
        // 1) 무위험 페어 완성(반대편 저가) 시도.
        await this._maybeCompletePairs(snapshot, model);
        // 2) 정상 페어가 불가능한 미페어 포지션은 강제 페어로 손실 축소(항상 평가).
        await this._maybeForcePairExit(snapshot, model);
        // 3) 신규 방향성 매수.
        if (allowNewBuys) {
          await this._maybeDirectionalBuy(snapshot, model);
        }
      } catch (err) {
        this.log.warn('BeatTrader v2: monitor iteration failed', { err: err.message });
        this._recordAudit('monitor_iteration_failed', { loop: this._loopCount, err: err.message, stack: err.stack ?? null });
      }

      if (this._loopCount % 30 === 0) await this._syncBalances();
      await sleep(Math.max(100, Number(cfg.BEAT_BOOK_POLL_MS) || 1_000));
    }
  }

  // ── 스냅샷 구성 ────────────────────────────────────────────────────────────────
  _buildSnapshot() {
    const ref = Date.now();
    const hub = this.hub ? this.hub.snapshot(ref) : null;
    const pm = this.pmFeed ? this.pmFeed.snapshot(ref) : null;
    const secondsLeft = ((this.market.windowTs + this.config.MARKET_WINDOW_SECONDS) * 1000 - ref) / 1000;
    const secondsAfterOpen = (ref - this.market.windowTs * 1000) / 1000;
    return { ref, hub, pm, secondsLeft, secondsAfterOpen };
  }

  // ── 모델 평가 ───────────────────────────────────────────────────────────────────
  _evaluateModel(snapshot) {
    const cfg = this.config;
    if (!cfg.BEAT_PROBABILITY_ENABLED) return { ok: false, reason: 'probability-disabled' };
    if (!Number.isFinite(Number(this.beatPrice))) return { ok: false, reason: 'no-beat-price' };

    const hub = snapshot.hub;
    if (!hub || !Number.isFinite(Number(hub.consensusPrice))) return { ok: false, reason: 'no-consensus-price' };
    if (Number(hub.bboAgeMs) > Number(cfg.BEAT_HUB_MAX_TICK_AGE_MS)) {
      return { ok: false, reason: 'stale-consensus-price', bboAgeMs: hub.bboAgeMs };
    }

    const priceHistory = this.hub ? this.hub.priceHistory() : [];
    if (priceHistory.length < 2) return { ok: false, reason: 'insufficient-history' };
    const span = Number(priceHistory[priceHistory.length - 1].timeMs) - Number(priceHistory[0].timeMs);
    if (span < Number(cfg.BEAT_MIN_HISTORY_MS)) {
      return { ok: false, reason: 'history-too-short', spanMs: span, requiredMs: cfg.BEAT_MIN_HISTORY_MS };
    }

    const result = computeFairProbability({
      consensusPrice: hub.consensusPrice,
      beatPrice: this.beatPrice,
      secondsLeft: snapshot.secondsLeft,
      priceHistory,
      hub,
      config: cfg,
      marketImpliedUp: snapshot.pm?.impliedUp ?? null,
    });
    if (!result) return { ok: false, reason: 'model-returned-null' };
    return { ok: true, ...result };
  }

  /**
   * 매 스냅샷마다 각 사이드의 "방향성 진입 자격 엣지"가 유지되는 연속 횟수를 갱신한다.
   * 자격 = 모델 정상 + ask 범위 내 + 신선한 북 + edge(fairProb-ask) >= requiredEdge.
   * 한 번이라도 자격을 잃으면(단발 outlier 포함) 해당 사이드 streak 는 0 으로 리셋.
   */
  _updateEdgeStreak(snapshot, model) {
    const cfg = this.config;
    const pm = snapshot?.pm;
    if (!model?.ok || !pm) {
      this._edgeStreak.Up = 0;
      this._edgeStreak.Down = 0;
      return;
    }
    const requiredEdge = Number(cfg.BEAT_PROBABILITY_REQUIRED_EDGE);
    const maxAsk = Number(cfg.BEAT_SIDE_MAX_ASK);
    const minAsk = Number(cfg.BEAT_SIDE_MIN_ASK);
    const maxAge = Number(cfg.BEAT_BOOK_MAX_AGE_MS);
    for (const [side, fairProb, leg] of [['Up', model.pUp, pm.up], ['Down', model.pDown, pm.down]]) {
      const ask = positiveFiniteOrNull(leg?.bestAsk);
      const edge = (ask != null && Number.isFinite(fairProb)) ? fairProb - ask : null;
      const qualifies = ask != null
        && Number(leg.ageMs) <= maxAge
        && ask <= maxAsk
        && ask >= minAsk
        && edge != null
        && edge >= requiredEdge;
      this._edgeStreak[side] = qualifies ? this._edgeStreak[side] + 1 : 0;
    }
  }

  // ── 방향성 매수 ────────────────────────────────────────────────────────────────
  async _maybeDirectionalBuy(snapshot, model) {
    const cfg = this.config;
    if (!model?.ok) {
      this._recordAudit('decision_skip', { reason: model?.reason ?? 'model-not-ready', secondsAfterOpen: snapshot.secondsAfterOpen });
      return;
    }
    if (Date.now() - this.lastBuyAt < Number(cfg.BEAT_BUY_COOLDOWN_MS)) {
      return;
    }
    const remainingBudget = Number(cfg.MAX_SPEND_PER_MARKET) - this.totalSpent;
    if (remainingBudget <= 1e-6) {
      this._recordAudit('decision_skip', { reason: 'budget-exhausted', totalSpent: this.totalSpent });
      return;
    }

    const pm = snapshot.pm;
    if (!pm) {
      this._recordAudit('decision_skip', { reason: 'no-pm-snapshot' });
      return;
    }

    const requiredEdge = Number(cfg.BEAT_PROBABILITY_REQUIRED_EDGE);
    const sides = [
      { side: 'Up', fairProb: model.pUp, leg: pm.up },
      { side: 'Down', fairProb: model.pDown, leg: pm.down },
    ];

    // 각 사이드의 엣지 = fairProb - ask. 양수면 저평가(ask 가 공정확률보다 쌈).
    const candidates = sides.map(({ side, fairProb, leg }) => {
      const ask = positiveFiniteOrNull(leg?.bestAsk);
      const edge = (ask != null && Number.isFinite(fairProb)) ? fairProb - ask : null;
      let reason = null;
      if (ask == null) reason = 'no-ask';
      else if (Number(leg.ageMs) > Number(cfg.BEAT_BOOK_MAX_AGE_MS)) reason = 'stale-book';
      else if (ask > Number(cfg.BEAT_SIDE_MAX_ASK)) reason = 'ask-too-high';
      else if (ask < Number(cfg.BEAT_SIDE_MIN_ASK)) reason = 'ask-too-low';
      else if (edge == null || edge < requiredEdge) reason = 'edge-too-small';
      return { side, fairProb, ask, edge, leg, eligible: reason == null, reason };
    });

    const eligible = candidates.filter((c) => c.eligible).sort((a, b) => b.edge - a.edge);
    if (!eligible.length) {
      this._recordAudit('decision_skip', {
        reason: 'no-eligible-side',
        secondsAfterOpen: snapshot.secondsAfterOpen,
        fairUp: model.pUp,
        fairDown: model.pDown,
        requiredEdge,
        candidates: candidates.map((c) => ({ side: c.side, ask: c.ask, edge: c.edge, reason: c.reason })),
      });
      return;
    }

    const best = eligible[0];
    // OFI 토식성 가드: 해당 사이드 체결흐름이 과열/독성이면 매수 보류.
    const ofi = best.side === 'Up' ? pm.up?.ofi : pm.down?.ofi;
    if (ofi?.isToxic && ofi?.saturated) {
      this._recordAudit('decision_skip', { reason: 'ofi-toxic-saturated', side: best.side, ofi });
      return;
    }

    // 엣지 지속성 가드: 선택된 사이드의 엣지가 연속 N 스냅샷 동안 유지됐을 때만 매수.
    // 단발성 가격 outlier 로 스파이크한 엣지(예: 한 거래소 stale 호가)는 차단된다.
    const requiredStreak = Math.max(1, Number(cfg.BEAT_EDGE_PERSISTENCE_SNAPSHOTS) || 1);
    const streak = Number(this._edgeStreak[best.side] ?? 0);
    if (streak < requiredStreak) {
      this._recordAudit('decision_skip', {
        reason: 'edge-not-persistent',
        side: best.side,
        edge: best.edge,
        streak,
        requiredStreak,
      });
      return;
    }

    // 방향성 재고 불균형 가드: 같은 사이드를 한도 이상으로 쌓지 않는다.
    // (반대편이 싸지면 _maybeCompletePairs 가 페어를 완성해 위험을 상계한다.)
    const cap = Number(cfg.BEAT_MAX_INVENTORY_IMBALANCE_SHARES);
    if (Number.isFinite(cap) && cap > 0) {
      const unpairedSame = this._unpairedShares(best.side);
      const unpairedOpp = this._unpairedShares(best.side === 'Up' ? 'Down' : 'Up');
      const projectedImbalance = (unpairedSame - unpairedOpp);
      if (projectedImbalance >= cap) {
        this._recordAudit('decision_skip', {
          reason: 'inventory-imbalance-cap',
          side: best.side,
          unpairedSame,
          unpairedOpp,
          cap,
        });
        return;
      }
    }

    await this._executeBuy({
      side: best.side,
      leg: best.leg,
      fairProb: best.fairProb,
      edge: best.edge,
      snapshot,
      model,
      reasonTag: 'directional',
    });
  }

  // ── 무위험 페어 완성(반대편이 싸지면 잠그기) ──────────────────────────────────
  // 핵심: lot 단위로 "지금 페어 가능한" 만큼 즉시 페어한다(전량 일괄이 아님).
  // 비싼 lot 때문에 평균비용이 올라가 싼 lot 의 페어 기회를 막던 버그를 제거한다.
  async _maybeCompletePairs(snapshot, model) {
    const cfg = this.config;
    if (!cfg.BEAT_ARB_PAIR_ENABLED) return;
    const pm = snapshot.pm;
    if (!pm) return;

    const pairCostMax = Number(cfg.BEAT_ARB_PAIR_COST_MAX);
    for (const heldSide of ['Up', 'Down']) {
      const oppSide = this._oppositeSide(heldSide);
      if (this._unpairedShares(heldSide) <= 1e-6) continue;

      const oppLeg = oppSide === 'Up' ? pm.up : pm.down;
      const oppAsk = positiveFiniteOrNull(oppLeg?.bestAsk);
      if (oppAsk == null) continue;
      if (Number(oppLeg.ageMs) > Number(cfg.BEAT_BOOK_MAX_AGE_MS)) continue;

      const oppUnitFee = this._unitFeeUsdc(oppSide, oppAsk);
      // lot 별로 (수수료 포함) 페어 총비용이 cap 이하인 lot 만 "지금 페어 가능"으로 본다.
      //   heldPrice + heldFee(heldPrice) + oppAsk + oppFee <= cap
      // 싼 lot 은 비싼 lot 과 무관하게 즉시 페어된다(블렌디드 평균 게이트 제거).
      let pairableShares = 0;
      let cheapestPairableCost = null;
      for (const lot of this.openLots[heldSide]) {
        const lp = Number(lot.avgPrice);
        const heldUnitFee = this._unitFeeUsdc(heldSide, lp);
        const totalUnitCost = lp + heldUnitFee + oppAsk + oppUnitFee;
        if (totalUnitCost <= pairCostMax + 1e-9) {
          pairableShares += Number(lot.shares ?? 0);
          if (cheapestPairableCost == null || totalUnitCost < cheapestPairableCost) {
            cheapestPairableCost = totalUnitCost;
          }
        }
      }
      if (pairableShares <= 1e-6) continue;

      // dust 방지: 지금 페어 가능한 양이 최소 주문 단위 미만이면 주문하지 않는다.
      // (남은 미세 잔량은 다음 기회/강제 페어/정산으로 처리 → 0.01 micro-order 방지)
      if (cfg.BEAT_ORDER_MODE === 'SHARES') {
        if (pairableShares + 1e-9 < Number(cfg.BEAT_MIN_BUY_SHARES)) continue;
      } else if (pairableShares * oppAsk + 1e-9 < Number(cfg.BEAT_MIN_BUY_USDC)) {
        continue;
      }

      // 페어 완성은 위험을 줄이는 거래이므로 MAX_SPEND_PER_MARKET / BEAT_ORDER_SIZE 한도를 무시.
      // 지금 페어 가능한 만큼(pairableShares)만 반대편을 매수한다. 부분 체결이면 다음 루프에서 이어짐.
      await this._executeBuy({
        side: oppSide,
        leg: oppLeg,
        fairProb: oppSide === 'Up' ? model?.pUp ?? null : model?.pDown ?? null,
        edge: null,
        snapshot,
        model,
        reasonTag: 'pair-completion',
        targetShares: pairableShares,
        pairContext: { heldSide, oppAsk, oppUnitFee, pairableShares, cheapestPairableCost, pairCostMax },
      });
    }
  }

  // ── 강제 페어 청산(미페어 방향성 손실 축소) ──────────────────────────────────
  // 정상 무위험 페어가 불가능한 미페어 방향성 포지션을, "질 것 같다"고 볼 때
  // 반대편을 사서 강제로 페어링한다. 완성 페어는 정산 시 정확히 $1 를 지급하므로
  // 손실이 확정·상한된다.
  //
  // 비교(보유 사이드 A, 1주 기준, 보유비용은 양쪽 모두 매몰):
  //   보유 → 정산:   기대값 = pA (불확실: 0 또는 1)
  //   지금 강제 페어: 가치 = 1 - p_opp(ask) - fee (확정)
  // ⇒ pA + p_opp + fee < 1 이면 강제 페어가 보유보다 유리(+EV 손실 축소).
  //
  // "시간이 지나도 이길 수 없는" 판단은 두 경로로 한다:
  //   (1) 모델이 정상이면 pA 가 시간(secondsLeft) 감소와 불리한 가격으로 0 에 수렴.
  //   (2) 모델이 평가 불가(가격 정체/히스토리 부족)여도, 엔드게임에서는 정산 규칙
  //       (합의가 vs 기준가)으로 "지는 중"을 직접 판정해 손실을 상한한다.
  async _maybeForcePairExit(snapshot, model) {
    const cfg = this.config;
    if (!cfg.BEAT_FORCE_PAIR_ENABLED) return;
    const pm = snapshot?.pm;
    if (!pm) return;

    const secondsLeft = Number(snapshot.secondsLeft);
    const endgame = Number.isFinite(secondsLeft) && secondsLeft <= Number(cfg.BEAT_FORCE_PAIR_ENDGAME_SECONDS);
    const modelOk = Boolean(model?.ok);
    // 모델이 없고 엔드게임도 아니면(=시간 여유 + 신호 불가) 보수적으로 대기.
    if (!modelOk && !endgame) {
      return;
    }

    const evMargin = Number(cfg.BEAT_FORCE_PAIR_EV_MARGIN);
    const maxWinProb = Number(cfg.BEAT_FORCE_PAIR_MAX_WIN_PROB);
    const maxLossPerShare = Number(cfg.BEAT_FORCE_PAIR_MAX_LOSS_PER_SHARE);
    const pairCostMax = Number(cfg.BEAT_ARB_PAIR_COST_MAX);

    // 모델 부재 시 정산 규칙으로 "지는 중" 판정에 쓸 합의가/기준가.
    const consensusPrice = Number(snapshot?.hub?.consensusPrice);
    const beatPrice = Number(this.beatPrice);
    const losingMargin = beatPrice * (Number(cfg.BEAT_FORCE_PAIR_LOSING_MARGIN_BPS) / 10_000);

    for (const heldSide of ['Up', 'Down']) {
      const unpairedShares = this._unpairedShares(heldSide);
      if (unpairedShares <= 1e-6) continue;

      const oppSide = this._oppositeSide(heldSide);
      const oppLeg = oppSide === 'Up' ? pm.up : pm.down;
      const oppAsk = positiveFiniteOrNull(oppLeg?.bestAsk);
      if (oppAsk == null) continue;
      if (Number(oppLeg.ageMs) > Number(cfg.BEAT_BOOK_MAX_AGE_MS)) continue;

      const heldAvgCost = this._unpairedAvgCost(heldSide);
      const oppUnitFee = this._unitFeeUsdc(oppSide, oppAsk);

      // 이미 정상(이익) 페어가 가능한 구간이면 _maybeCompletePairs 가 처리하므로 건너뜀.
      const profitablePairCost = heldAvgCost + this._unitFeeUsdc(heldSide, heldAvgCost) + oppAsk + oppUnitFee;
      if (profitablePairCost <= pairCostMax) continue;

      // 강제 페어로 확정되는 1주당 손익.
      const heldUnitFee = this._unitFeeUsdc(heldSide, heldAvgCost);
      const lockedValuePerShare = 1 - oppAsk - oppUnitFee;        // 페어 완성 시 1주 가치
      const lockedPnlPerShare = lockedValuePerShare - heldAvgCost - heldUnitFee;
      const lockedLossPerShare = Math.max(0, -lockedPnlPerShare);

      // 락인 손실이 허용치를 넘으면(반대편이 너무 비쌈) 강제 페어하지 않는다.
      if (lockedLossPerShare > maxLossPerShare + 1e-9) {
        this._recordAudit('force_pair_skip', {
          reason: 'locked-loss-too-large',
          heldSide, oppSide, heldAvgCost, oppAsk, lockedLossPerShare, maxLossPerShare,
          secondsLeft, modelOk,
        });
        continue;
      }

      // ── 청산 판단 ──────────────────────────────────────────────────────────
      let shouldExit = false;
      let decisionReason = null;
      let pA = null;

      if (modelOk) {
        // (1) 모델 경로: +EV 트리거 + 불리(adverse).
        pA = heldSide === 'Up' ? Number(model.pUp) : Number(model.pDown);
        if (Number.isFinite(pA)) {
          const effectiveMargin = endgame ? 0 : evMargin;
          const evTrigger = (pA + oppAsk + oppUnitFee) <= (1 - effectiveMargin);
          const adverse = endgame ? (pA < 0.5) : (pA <= maxWinProb);
          shouldExit = evTrigger && adverse;
          decisionReason = shouldExit
            ? (endgame ? 'model-endgame' : 'model-ev')
            : (!evTrigger ? 'ev-trigger-not-met' : 'held-side-not-adverse');
        } else {
          decisionReason = 'model-pA-not-finite';
        }
      } else if (endgame) {
        // (2) 모델 부재 + 엔드게임: 정산 규칙으로 "지는 중"이면 손실 상한.
        //     Up 은 consensus < beat - margin, Down 은 consensus > beat + margin 이면 패배 중.
        if (Number.isFinite(consensusPrice) && Number.isFinite(beatPrice)) {
          const losing = heldSide === 'Up'
            ? consensusPrice < (beatPrice - losingMargin)
            : consensusPrice > (beatPrice + losingMargin);
          shouldExit = losing;
          decisionReason = losing ? 'price-vs-beat-losing-endgame' : 'price-vs-beat-not-losing';
        } else {
          decisionReason = 'no-consensus-or-beat-price';
        }
      }

      if (!shouldExit) {
        this._recordAudit('force_pair_skip', {
          reason: decisionReason ?? 'no-decision',
          heldSide, oppSide, pA, oppAsk, oppUnitFee,
          consensusPrice: Number.isFinite(consensusPrice) ? consensusPrice : null,
          beatPrice: Number.isFinite(beatPrice) ? beatPrice : null,
          endgame, modelOk, secondsLeft,
        });
        continue;
      }

      this.log.info('BeatTrader v2: force-pair exit', {
        heldSide, oppSide, unpairedShares: unpairedShares.toFixed(4),
        reason: decisionReason, pA: Number.isFinite(pA) ? pA.toFixed(4) : null,
        oppAsk: oppAsk.toFixed(4), lockedPnlPerShare: lockedPnlPerShare.toFixed(4),
        endgame, modelOk, secondsLeft: Math.round(secondsLeft),
      });
      this._recordAudit('force_pair_trigger', {
        heldSide, oppSide, unpairedShares, reason: decisionReason, pA,
        oppAsk, oppUnitFee, heldAvgCost, lockedValuePerShare, lockedPnlPerShare, lockedLossPerShare,
        consensusPrice: Number.isFinite(consensusPrice) ? consensusPrice : null,
        beatPrice: Number.isFinite(beatPrice) ? beatPrice : null,
        endgame, modelOk, secondsLeft,
      });

      // 미페어 보유 전량을 반대편으로 매수해 강제 페어링(예산/주문크기 한도 무시).
      await this._executeBuy({
        side: oppSide,
        leg: oppLeg,
        fairProb: modelOk ? (oppSide === 'Up' ? model.pUp : model.pDown) : null,
        edge: null,
        snapshot,
        model,
        reasonTag: 'force-pair',
        targetShares: unpairedShares,
        pairContext: {
          heldSide, heldAvgCost, oppAsk, oppUnitFee,
          pA, lockedPnlPerShare, endgame, modelOk, reason: decisionReason, mode: 'force-pair',
        },
      });
    }
  }

  // ── 매수 실행(드라이런=시뮬레이션, 라이브=IOC) ──────────────────────────────────
  async _executeBuy({ side, leg, fairProb, edge, snapshot, model, reasonTag, targetShares = null, pairContext = null }) {
    const cfg = this.config;
    const tokenId = side === 'Up' ? this.market.upToken.tokenId : this.market.downToken.tokenId;
    const ask = positiveFiniteOrNull(leg?.bestAsk);
    if (ask == null) return;

    const maxPrice = clamp(ask + Number(cfg.BEAT_MAX_SLIPPAGE), 0.01, 0.999);
    // 페어 완성/강제 페어는 위험을 줄이는 거래라 MAX_SPEND_PER_MARKET 한도를 무시한다.
    // 신규 방향성 매수만 잔여 예산으로 제한한다.
    const isPairCompletion = reasonTag === 'pair-completion' || reasonTag === 'force-pair';
    const remainingBudget = isPairCompletion
      ? Infinity
      : Number(cfg.MAX_SPEND_PER_MARKET) - this.totalSpent;
    const book = leg?.book ?? null;
    if (!book) {
      this._recordAudit('decision_skip', { reason: 'no-book-for-execution', side, reasonTag });
      return;
    }

    // 주문 수량/금액 계획.
    let plan = null;
    let amountUsdc = null;
    const hasTargetShares = targetShares != null && Number.isFinite(Number(targetShares));

    if (isPairCompletion && hasTargetShares) {
      // 페어 완성: 미페어 방향성 보유 전량(targetShares)을 한 번에 매수해 완전히 페어링한다.
      // BEAT_ORDER_SIZE_USDC / BEAT_ORDER_SIZE_SHARES 한도를 무시한다(예산 한도도 무시).
      const pairShares = Number(targetShares);
      if (cfg.BEAT_ORDER_MODE === 'SHARES') {
        plan = estimateSharesFromBook(book, maxPrice, pairShares);
      } else {
        // 라이브 IOC 초과 체결 방지를 위해 현재 ask 기준으로 금액을 잡는다.
        amountUsdc = pairShares * ask;
        plan = ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, amountUsdc, 0);
      }
    } else if (cfg.BEAT_ORDER_MODE === 'SHARES') {
      let reqShares = Number(cfg.BEAT_ORDER_SIZE_SHARES);
      if (hasTargetShares) reqShares = Math.min(reqShares, Number(targetShares));
      const budgetShares = remainingBudget / maxPrice;
      reqShares = Math.min(reqShares, budgetShares);
      if (reqShares < Number(cfg.BEAT_MIN_BUY_SHARES)) {
        this._recordAudit('decision_skip', { reason: 'shares-below-min', side, reqShares, reasonTag });
        return;
      }
      plan = estimateSharesFromBook(book, maxPrice, reqShares);
    } else {
      amountUsdc = Math.min(Number(cfg.BEAT_ORDER_SIZE_USDC), remainingBudget);
      if (hasTargetShares) {
        // 라이브 IOC 가 targetShares 를 초과 체결하지 않도록, 슬리피지 포함
        // maxPrice 가 아니라 현재 ask 기준으로 금액을 잡는다(실제 체결은 ask 근처).
        amountUsdc = Math.min(amountUsdc, Number(targetShares) * ask);
      }
      if (amountUsdc < Number(cfg.BEAT_MIN_BUY_USDC)) {
        this._recordAudit('decision_skip', { reason: 'usdc-below-min', side, amountUsdc, reasonTag });
        return;
      }
      plan = ClobClient.estimateMarketBuyFillFromBook(book, maxPrice, amountUsdc, 0);
    }

    if (!plan || !(plan.fillShares > 1e-9) || !(plan.spentUsdc > 1e-9)) {
      this._recordAudit('decision_skip', { reason: 'plan-not-fillable', side, reasonTag, maxPrice, amountUsdc });
      return;
    }

    // targetShares 가 지정된 경우(페어 완성 등) 초과 체결을 방지한다.
    // 주문 금액은 targetShares*maxPrice 로 잡지만 실제 체결은 더 낮은 ask 에서
    // 일어나 수량이 초과될 수 있다. 초과분은 반대편 미페어 잔량을 만들어
    // 단일-포지션 가드와 충돌하므로, 회계상 정확히 targetShares 로 잘라낸다.
    if (hasTargetShares && plan.fillShares > Number(targetShares) + 1e-9) {
      const cappedShares = Number(targetShares);
      const cappedSpent = plan.avgFillPrice != null
        ? cappedShares * plan.avgFillPrice
        : (plan.spentUsdc * (cappedShares / plan.fillShares));
      plan = {
        ...plan,
        fillShares: cappedShares,
        spentUsdc: cappedSpent,
        avgFillPrice: cappedShares > 0 ? cappedSpent / cappedShares : plan.avgFillPrice,
      };
    }

    // 방향성 매수 전: "나중에 반대편으로 이 포지션을 페어 완성할 수 있는가?" 검증.
    // 완성 매수가 BEAT_MIN_BUY_USDC/SHARES 미만이라 거부될 규모라면, 페어를 못 닫고
    // 방향성 위험만 떠안게 되므로 애초에 진입하지 않는다. (페어 완성 매수 자체는 제외)
    if (reasonTag === 'directional') {
      const viability = this._directionalFuturePairTradeViability({
        side,
        shares: plan.fillShares,
        avgPrice: plan.avgFillPrice ?? (plan.spentUsdc / plan.fillShares),
      });
      if (!viability.viable) {
        this._recordAudit('decision_skip', { reason: viability.reason, side, reasonTag, viability });
        return;
      }
    }

    this._recordAudit('order_plan', {
      side, reasonTag, orderMode: cfg.BEAT_ORDER_MODE,
      ask, maxPrice, fairProb, edge,
      planShares: plan.fillShares, planSpentUsdc: plan.spentUsdc, planAvgPrice: plan.avgFillPrice,
      pairContext,
    });

    let filledShares = plan.fillShares;
    let spentUsdc = plan.spentUsdc;
    let avgPrice = plan.avgFillPrice ?? (spentUsdc / filledShares);

    if (cfg.BEAT_DRY_RUN) {
      this.log.info('BeatTrader v2: [DRY] buy', {
        side, reasonTag, shares: filledShares.toFixed(4), avgPrice: avgPrice.toFixed(4), spent: spentUsdc.toFixed(4), edge,
      });
    } else {
      // 온체인 확정 체결의 기준선(누적값)을 주문 직전에 스냅샷.
      const feed = this._fillFeed;
      const baseShares = feed?.active ? feed.cumulativeShares(tokenId) : 0;
      const baseUsdc = feed?.active ? feed.cumulativeUsdc(tokenId) : 0;

      let resp;
      try {
        resp = cfg.BEAT_ORDER_MODE === 'SHARES'
          ? await ClobClient.postFOKLimitBuy(this.wallet, tokenId, maxPrice, filledShares, true)
          : await ClobClient.postIOCBuy(this.wallet, tokenId, maxPrice, amountUsdc, true);
      } catch (err) {
        this.log.warn('BeatTrader v2: order failed', { side, reasonTag, err: err.message });
        this._recordAudit('order_failed', { side, reasonTag, err: err.message });
        return;
      }

      // 실제 체결 결과 확보: (API 응답 파싱) vs (온체인 OrderFilled) 중 먼저 도착한 확정값 사용.
      const resolved = await this._resolveActualFill({
        resp, tokenId, baseShares, baseUsdc, reasonTag, side,
      });

      if (resolved.kind === 'zero') {
        // 체결 없음(미체결/취소/거부) → 포지션 변화 없음.
        this.log.info('BeatTrader v2: order not filled', { side, reasonTag, source: resolved.source, status: resolved.status });
        this._recordAudit('order_unfilled', {
          side, reasonTag, tokenId, source: resolved.source, status: resolved.status,
          response: this._safeResp(resp),
        });
        return;
      }

      filledShares = resolved.shares;
      spentUsdc = resolved.spentUsdc;
      avgPrice = spentUsdc / filledShares;
      this._recordAudit('order_submitted', {
        side, reasonTag, tokenId, maxPrice,
        fillSource: resolved.source, status: resolved.status,
        response: this._safeResp(resp), filledShares, spentUsdc, avgPrice,
      });
    }

    this._registerFill({ side, shares: filledShares, avgPrice, spentUsdc, reasonTag, fairProb, edge, snapshot });
    this.lastBuyAt = Date.now();
  }

  /**
   * 라이브 매수의 실제 체결 결과를 확정한다.
   *   - API 응답(_extractFill) 과 온체인 OrderFilled(waitForIncrease) 를 동시에 기다려
   *     "먼저 도착한 확정값"을 사용한다(요구사항: whatever first arrives).
   *   - API 가 즉시 0/미체결을 명시하면 그대로 채택.
   *   - 둘 다 확정 못하면 plan(예상값)으로 폴백하되 audit 에 불확실로 남긴다.
   * 반환: { kind:'filled'|'zero', shares, spentUsdc, source, status }
   */
  async _resolveActualFill({ resp, tokenId, baseShares, baseUsdc, reasonTag, side }) {
    const api = this._extractFill(resp);
    const status = api?.status ?? null;

    // 1) API 가 명확한 양수 체결을 즉시 반환 → 채택(가장 빠름).
    if (api && Number.isFinite(api.shares) && api.shares > 1e-9 && Number.isFinite(api.spentUsdc) && api.spentUsdc > 1e-9) {
      return { kind: 'filled', shares: api.shares, spentUsdc: api.spentUsdc, source: 'api', status };
    }
    // 2) API 가 명확한 0 체결(미체결/취소) → 채택.
    if (api && api.filledKind === 'zero') {
      return { kind: 'zero', shares: 0, spentUsdc: 0, source: 'api', status };
    }

    // 3) API 가 불확실(unknown/null) → 온체인 확정 체결을 대기(먼저 도착하면 채택).
    const feed = this._fillFeed;
    if (feed?.active) {
      const timeoutMs = Math.max(1_000, Number(this.config.BEAT_FILL_CONFIRM_TIMEOUT_MS) || 4_000);
      const onchain = await feed.waitForIncrease(tokenId, baseShares, baseUsdc, timeoutMs);
      if (onchain && onchain.shares > 1e-9 && onchain.spentUsdc > 1e-9) {
        return { kind: 'filled', shares: onchain.shares, spentUsdc: onchain.spentUsdc, source: 'chain', status };
      }
    }

    // 4) 온체인도 확인 못함. API 가 양수였다면(부분이라도) 사용, 아니면 plan 폴백.
    if (api && Number.isFinite(api.shares) && api.shares > 1e-9 && Number.isFinite(api.spentUsdc) && api.spentUsdc > 1e-9) {
      return { kind: 'filled', shares: api.shares, spentUsdc: api.spentUsdc, source: 'api-late', status };
    }
    this._recordAudit('fill_unconfirmed_fallback', {
      side, reasonTag, tokenId, status,
      note: 'api-and-chain-unconfirmed; using estimated plan',
    });
    return { kind: 'zero', shares: 0, spentUsdc: 0, source: 'unconfirmed', status };
  }

  _registerFill({ side, shares, avgPrice, spentUsdc, reasonTag, fairProb, edge, snapshot }) {
    this.totalSpent += spentUsdc;
    const lotId = `buy-${this._nextLotId++}`;
    this.openLots[side].push({ id: lotId, side, shares, avgPrice, costUsdc: spentUsdc });
    this.pnl.recordBuy(this.market.slug, side, avgPrice, shares);

    const consensus = Number(snapshot?.hub?.consensusPrice);
    const move = (Number.isFinite(consensus) && Number.isFinite(this.beatPrice)) ? consensus - this.beatPrice : null;
    const movePct = (move != null && Number.isFinite(this.beatPrice) && this.beatPrice > 0) ? (move / this.beatPrice) * 100 : null;
    // 대시보드 호환 필드(id/usdc/price/intent/recordedAt) + 분석 필드.
    const event = {
      id: lotId,
      ts: Date.now(),
      recordedAt: Date.now(),
      side,
      intent: reasonTag === 'force-pair'
        ? 'force-pair'
        : (reasonTag === 'pair-completion' ? 'pair-buy' : 'directional'),
      reasonTag,
      shares,
      price: avgPrice,
      avgPrice,
      usdc: spentUsdc,
      spentUsdc,
      fairProb: Number.isFinite(fairProb) ? fairProb : null,
      edge: Number.isFinite(edge) ? edge : null,
      moveAtBuyUsd: move,
      moveAtBuyPct: movePct,
      consensusPriceAtBuy: Number.isFinite(consensus) ? consensus : null,
    };
    this.tradeSummary.buyEvents.push(event);
    this.tradeSummary.buyCount += 1;
    this.tradeSummary.buyShares += shares;
    this.tradeSummary.buyUsdc += spentUsdc;
    this.tradeSummary.buyPrice = avgPrice;
    this.tradeSummary.chosenSide = side;
    this.tradeSummary.moveAtBuyUsd = move;
    this.tradeSummary.moveAtBuyPct = movePct;
    this.tradeSummary.btcPriceAtBuy = Number.isFinite(consensus) ? consensus : null;

    // 페어 매칭(반대편 미페어 로트와 즉시 상계 → 잠금 이익 기록).
    this._reconcilePairs();
    this._recordAudit('buy_registered', { event, lotState: this._lotState() });
    this._publishMarket({
      tradeStatus: reasonTag === 'force-pair'
        ? 'force paired'
        : (reasonTag === 'pair-completion' ? 'pair locked' : 'buy placed'),
    });
  }

  /**
   * 보유한 Up/Down 미페어 로트를 최대한 상계해 완성 페어로 옮긴다.
   * 완성 페어는 정산 시 정확히 $1 를 지급하므로, 비용<$1 이면 그 차이가 잠금 이익.
   *
   * lot 소비 순서는 "싼 것부터(cheapest-first)". _maybeCompletePairs 가 싼 lot 만
   * 골라 페어 가능하다고 판단했으므로, 매칭도 싼 lot 부터 소비해야 일관된다.
   */
  _reconcilePairs() {
    const matchable = Math.min(this._unpairedShares('Up'), this._unpairedShares('Down'));
    if (matchable <= 1e-9) {
      this._refreshUnpairedSummary();
      return;
    }
    // 싼 lot 부터 matchable 만큼 차감하며 페어 비용 누적.
    // 한 번의 페어가 여러 directional 로트를 소비할 수 있으므로, 소비한 모든
    // 로트 id 와 각 로트에서 페어된 수량을 기록한다(UI 가 전부 paired 로 표시하도록).
    const consume = (side, qty) => {
      let need = qty;
      let cost = 0;
      const lotIds = [];
      const lotShares = [];
      // avgPrice 오름차순으로 정렬해 싼 lot 부터 소비(원본 배열을 재정렬).
      this.openLots[side].sort((a, b) => Number(a.avgPrice) - Number(b.avgPrice));
      const lots = this.openLots[side];
      while (need > 1e-12 && lots.length) {
        const lot = lots[0];
        const take = Math.min(need, lot.shares);
        cost += take * lot.avgPrice;
        lot.shares -= take;
        lot.costUsdc -= take * lot.avgPrice;
        need -= take;
        lotIds.push(lot.id);
        lotShares.push({ id: lot.id, shares: take });
        if (lot.shares <= 1e-9) lots.shift();
      }
      return { cost, lotIds, lotShares, avgPrice: qty > 0 ? cost / qty : null };
    };
    const up = consume('Up', matchable);
    const down = consume('Down', matchable);
    const pairedShares = matchable;
    const pairedCost = up.cost + down.cost;
    const unitPairCost = pairedShares > 0 ? pairedCost / pairedShares : null;
    // 양쪽 다리의 테이커 수수료를 차감한 순(net) 잠금 이익.
    const upFee = this._feeUsdc('Up', up.avgPrice ?? 0, pairedShares);
    const downFee = this._feeUsdc('Down', down.avgPrice ?? 0, pairedShares);
    const pairedFeeUsdc = upFee + downFee;
    const grossLockedProfit = pairedShares - pairedCost;       // $1/페어 - 가격비용
    const lockedProfit = grossLockedProfit - pairedFeeUsdc;    // 수수료 차감 순이익

    this.pairedLots.push({ shares: pairedShares, costUsdc: pairedCost, feeUsdc: pairedFeeUsdc, unitPairCost });
    this.tradeSummary.pairedShares += pairedShares;
    this.tradeSummary.pairedCostUsdc += pairedCost;
    this.tradeSummary.pairedFeeUsdc = (this.tradeSummary.pairedFeeUsdc ?? 0) + pairedFeeUsdc;
    this.tradeSummary.lockedProfitUsdc += lockedProfit;
    this.tradeSummary.averagePairedCost = this.tradeSummary.pairedShares > 0
      ? this.tradeSummary.pairedCostUsdc / this.tradeSummary.pairedShares
      : null;
    // 대시보드 호환 페어 이벤트.
    const pairEvent = {
      id: `pair-${this.tradeSummary.pairEvents.length + 1}`,
      ts: Date.now(),
      pairedAt: Date.now(),
      shares: pairedShares,
      costUsdc: pairedCost,
      feeUsdc: pairedFeeUsdc,
      averagePairCost: unitPairCost,
      upPrice: up.avgPrice,
      downPrice: down.avgPrice,
      upLotId: up.lotIds[0] ?? null,
      downLotId: down.lotIds[0] ?? null,
      // 이 페어가 소비한 모든 로트(여러 directional 매수가 한 페어로 닫힐 수 있음).
      upLotIds: up.lotIds,
      downLotIds: down.lotIds,
      upLotShares: up.lotShares,
      downLotShares: down.lotShares,
      grossLockedProfit,
      lockedProfit,
    };
    this.tradeSummary.pairEvents.push(pairEvent);
    this._recordAudit('pair_locked', pairEvent);
    this._refreshUnpairedSummary();
  }

  _refreshUnpairedSummary() {
    this.tradeSummary.unpairedUpShares = this._unpairedShares('Up');
    this.tradeSummary.unpairedDownShares = this._unpairedShares('Down');
  }

  _unpairedShares(side) {
    return this.openLots[side].reduce((sum, lot) => sum + Number(lot.shares ?? 0), 0);
  }

  _unpairedAvgCost(side) {
    const lots = this.openLots[side];
    const shares = lots.reduce((s, l) => s + Number(l.shares ?? 0), 0);
    const cost = lots.reduce((s, l) => s + Number(l.costUsdc ?? 0), 0);
    return shares > 0 ? cost / shares : 0;
  }

  _oppositeSide(side) {
    return side === 'Up' ? 'Down' : 'Up';
  }

  // ── 수수료 ────────────────────────────────────────────────────────────────────
  /** 두 토큰의 실제 수수료 파라미터({rate,exponent})를 1회 조회해 캐싱한다. */
  async _primeTokenFees() {
    const ids = [this.market.upToken.tokenId, this.market.downToken.tokenId];
    await Promise.all(ids.map(async (id) => {
      const key = String(id);
      try {
        const info = await ClobClient.getFeeInfo(key);
        this._tokenFeeInfo.set(key, info);
      } catch (err) {
        this._tokenFeeInfo.set(key, { rate: 0, exponent: 1 });
        this._recordAudit('token_fee_lookup_failed', { tokenId: key, err: err.message });
      }
    }));
    this._recordAudit('token_fees_primed', {
      up: this._tokenFeeInfo.get(String(this.market.upToken.tokenId)) ?? null,
      down: this._tokenFeeInfo.get(String(this.market.downToken.tokenId)) ?? null,
    });
  }

  _feeInfoForSide(side) {
    const tokenId = side === 'Up' ? this.market.upToken.tokenId : this.market.downToken.tokenId;
    return this._tokenFeeInfo.get(String(tokenId)) ?? { rate: 0, exponent: 1 };
  }

  /** 단위(1주) 당 테이커 수수료(USDC). perShare = rate · (price·(1-price))^exponent. */
  _unitFeeUsdc(side, price) {
    const { rate, exponent } = this._feeInfoForSide(side);
    return ClobClient.estimateTakerFeeUsdcWithInfo({ shares: 1, price, rate, exponent });
  }

  /** shares 만큼 매수 시 총 테이커 수수료(USDC). */
  _feeUsdc(side, price, shares) {
    const { rate, exponent } = this._feeInfoForSide(side);
    return ClobClient.estimateTakerFeeUsdcWithInfo({ shares, price, rate, exponent });
  }

  /**
   * 방향성 매수가 "나중에 반대편으로 페어를 완성할 수 있는가" 검증.
   *
   * 페어를 닫으려면 반대편을 ask <= (pairCostMax - 이 사이드 평균비용) 에 사야
   * 무위험 이익이 남는다. 그 가격으로 동일 수량(shares)을 살 때의 완성 매수 규모가
   * 최소 주문 단위(USDC 모드: BEAT_MIN_BUY_USDC, SHARES 모드: BEAT_MIN_BUY_SHARES)
   * 미만이면, 완성 매수가 거부되어 방향성 다리만 묶인다. 그런 진입은 막는다.
   */
  _directionalFuturePairTradeViability({ side, shares, avgPrice }) {
    const cfg = this.config;
    if (!cfg.BEAT_ARB_PAIR_ENABLED) {
      // 페어 완성 기능이 꺼져 있으면 방향성만으로 운용 → 검증 불필요.
      return { viable: true, reason: 'arb-pair-disabled' };
    }

    const sh = Number(shares);
    const px = Number(avgPrice);
    if (!Number.isFinite(sh) || sh <= 0 || !Number.isFinite(px) || px <= 0) {
      return { viable: false, reason: 'missing-directional-fill-shares-or-price', shares: sh, avgPrice: px };
    }

    const pairCostMax = Number(cfg.BEAT_ARB_PAIR_COST_MAX);
    // 이 사이드 전체(기존 미페어 + 이번 체결)의 가중 평균비용으로 목표 반대편가 산출.
    const existingShares = this._unpairedShares(side);
    const existingCost = existingShares * this._unpairedAvgCost(side);
    const blendedShares = existingShares + sh;
    const blendedAvg = blendedShares > 0 ? (existingCost + (sh * px)) / blendedShares : px;

    // 수수료 포함 목표 반대편가: blendedAvg + 보유 수수료 + oppAsk + opp 수수료 <= cap.
    // opp 수수료는 가격에 의존하므로, 목표가에서 평가해 안전여유로 차감한다.
    const oppSide = this._oppositeSide(side);
    const heldUnitFee = this._unitFeeUsdc(side, blendedAvg);
    const room = pairCostMax - blendedAvg - heldUnitFee;
    // opp 수수료를 고려한 목표가: targetAsk + fee(targetAsk) = room → 근사로 fee 를 한 번 빼준다.
    const targetOppositeAskRaw = room;
    const targetOppositeAsk = targetOppositeAskRaw > 0
      ? targetOppositeAskRaw - this._unitFeeUsdc(oppSide, targetOppositeAskRaw)
      : targetOppositeAskRaw;
    if (!Number.isFinite(targetOppositeAsk) || targetOppositeAsk <= 0) {
      return {
        viable: false,
        reason: 'future-pair-target-unavailable',
        oppositeSide: this._oppositeSide(side),
        shares: sh,
        avgPrice: px,
        blendedAvg,
        heldUnitFee,
        targetOppositeAsk,
        pairCostMax,
      };
    }

    // 완성 매수는 미페어 전량(blendedShares)을 반대편 목표가로 사는 것.
    if (cfg.BEAT_ORDER_MODE === 'SHARES') {
      const requiredMinShares = Number(cfg.BEAT_MIN_BUY_SHARES);
      const viable = blendedShares + 1e-9 >= requiredMinShares;
      return {
        viable,
        reason: viable ? 'future-pair-trade-meets-min-size' : 'future-pair-trade-below-min-size',
        oppositeSide: this._oppositeSide(side),
        shares: sh,
        avgPrice: px,
        blendedAvg,
        heldUnitFee,
        blendedShares,
        targetOppositeAsk,
        projectedPairShares: blendedShares,
        requiredMinShares,
        pairCostMax,
      };
    }

    const projectedPairSpentUsdc = blendedShares * targetOppositeAsk;
    const requiredMinUsdc = Number(cfg.BEAT_MIN_BUY_USDC);
    const viable = projectedPairSpentUsdc + 1e-9 >= requiredMinUsdc;
    return {
      viable,
      reason: viable ? 'future-pair-trade-meets-min-size' : 'future-pair-trade-below-min-size',
      oppositeSide: this._oppositeSide(side),
      shares: sh,
      avgPrice: px,
      blendedAvg,
      heldUnitFee,
      blendedShares,
      targetOppositeAsk,
      projectedPairSpentUsdc,
      requiredMinUsdc,
      pairCostMax,
    };
  }

  _lotState() {
    return {
      unpairedUpShares: this._unpairedShares('Up'),
      unpairedDownShares: this._unpairedShares('Down'),
      pairedShares: this.tradeSummary.pairedShares,
      pairedCostUsdc: this.tradeSummary.pairedCostUsdc,
      lockedProfitUsdc: this.tradeSummary.lockedProfitUsdc,
      totalSpent: this.totalSpent,
    };
  }

  /**
   * clob-client-v2 의 OrderResponse 를 안전하게 파싱한다.
   *   OrderResponse { success, errorMsg, orderID, status,
   *                   takingAmount, makingAmount, transactionsHashes?, tradeIDs? }
   * BUY(테이커 마켓) 기준:
   *   - takingAmount = 받은 shares
   *   - makingAmount = 지불한 USDC
   * 반환: { shares, spentUsdc, status, success, filledKind } 또는 null(파싱 불가).
   *   filledKind: 'full' | 'partial' | 'zero'  (가능하면 추정)
   */
  _extractFill(resp) {
    if (!resp || typeof resp !== 'object') return null;

    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const status = typeof resp.status === 'string' ? resp.status.toLowerCase() : null;
    const success = resp.success !== false; // 명시적 false 만 실패로 간주

    // BUY: takingAmount = shares 수령, makingAmount = USDC 지불.
    // 다양한 SDK/HTTP 표기를 폭넓게 허용.
    const shares = num(resp.takingAmount ?? resp.taking_amount ?? resp.sizeMatched ?? resp.size_matched ?? resp.filledSize ?? resp.matchedSize);
    const spent = num(resp.makingAmount ?? resp.making_amount ?? resp.spentUsdc ?? resp.spent);

    // 명시적 실패/미체결.
    if (resp.success === false) {
      return { shares: 0, spentUsdc: 0, status, success: false, filledKind: 'zero', errorMsg: resp.errorMsg ?? null };
    }
    if (status && /unmatched|cancel|reject|fail/.test(status)) {
      return { shares: 0, spentUsdc: 0, status, success, filledKind: 'zero' };
    }

    if (Number.isFinite(shares) && shares > 0 && Number.isFinite(spent) && spent > 0) {
      return { shares, spentUsdc: spent, status, success, filledKind: status === 'matched' ? 'full' : 'partial' };
    }

    // 금액 필드가 없지만 체결된 상태로 보이는 경우(예: matched 인데 amount 누락) → 불확실.
    if (status === 'matched' && (!Number.isFinite(shares) || !Number.isFinite(spent))) {
      return { shares: null, spentUsdc: null, status, success, filledKind: 'unknown' };
    }

    // GTC 처럼 즉시 체결이 없을 수 있는 상태(live/delayed)는 0 체결로 처리.
    if (status && /live|delayed|matched_pending|new/.test(status)) {
      return { shares: 0, spentUsdc: 0, status, success, filledKind: 'zero' };
    }

    return null;
  }

  _safeResp(resp) {
    try {
      return JSON.parse(JSON.stringify(resp));
    } catch {
      return String(resp);
    }
  }

  async _syncBalances() {
    try {
      const balances = await getTokenBalances([this.market.upToken.tokenId, this.market.downToken.tokenId]);
      this.walletBalanceUp = balances[this.market.upToken.tokenId] ?? this.walletBalanceUp;
      this.walletBalanceDown = balances[this.market.downToken.tokenId] ?? this.walletBalanceDown;
    } catch (err) {
      this._recordAudit('balance_sync_error', { err: err.message });
    }
  }

  // ── 정산/리딤 ─────────────────────────────────────────────────────────────────
  async _redeemPhase(conditionId, windowClose) {
    const cfg = this.config;
    const redeemNotBeforeMs = (windowClose + Number(cfg.REDEEM_DELAY_AFTER_CLOSE || 0)) * 1000;
    const waitMs = redeemNotBeforeMs - Date.now();
    if (waitMs > 0) {
      this._recordAudit('wait_for_resolution', { waitMs });
      await sleep(waitMs);
    }

    let resolvedMarket = null;
    let attempt = 0;
    while (!resolvedMarket) {
      attempt += 1;
      try {
        resolvedMarket = await waitForResolution(this.market, 400_000, 10_000);
      } catch (err) {
        this._recordAudit('resolution_timeout', { attempt, err: err.message });
        this._publishMarket({ lifecycle: BEAT_LIFECYCLE.RESOLVING, tradeStatus: `resolution pending (retry ${attempt})` });
      }
    }

    const outcome = this._resolveOutcome(resolvedMarket);
    this.lastOutcome = outcome;
    const estimatedPayout = this._estimateSettlementPayout(resolvedMarket);
    if (!outcome || !Number.isFinite(estimatedPayout)) {
      this._recordAudit('settlement_pending', { outcome, estimatedPayout, resolvedPayouts: resolvedMarket?.resolvedPayouts ?? null });
      this._publishMarket({ lifecycle: BEAT_LIFECYCLE.RESOLVING, settled: false, tradeStatus: 'resolution pending' });
      return false;
    }

    this.lastSettledAt = Date.now();
    this.settledPayoutUsdc += estimatedPayout;
    const marketPnl = this.settledPayoutUsdc - this.totalSpent;
    this.pnl.recordRedeem(this.market.slug, estimatedPayout, 'external-auto-redeem');

    this._recordAudit('settlement_evaluated', {
      outcome, estimatedPayout, marketPnl,
      resolvedPayouts: resolvedMarket?.resolvedPayouts ?? null,
      tradeSummary: this.tradeSummary, lotState: this._lotState(),
    });
    this._publishMarket({
      lifecycle: BEAT_LIFECYCLE.SETTLED,
      settled: true,
      settledAt: this.lastSettledAt,
      outcome,
      pnl: marketPnl,
      tradeStatus: this.tradeSummary.buyShares > 0 ? 'settled' : 'settled without trade',
      settledPayoutUsdc: this.settledPayoutUsdc,
    });
    this.onSettled?.({
      slug: this.market.slug,
      settledAt: this.lastSettledAt,
      outcome,
      pnl: marketPnl,
      tradeOccurred: Boolean(this.tradeSummary.buyShares > 0),
    });
    return true;
  }

  _resolveOutcome(resolvedMarket) {
    const payouts = resolvedMarket?.resolvedPayouts;
    if (Array.isArray(payouts) && payouts.length >= 2) {
      const up = Number(payouts[0] ?? 0);
      const down = Number(payouts[1] ?? 0);
      if (up > down) return 'Up';
      if (down > up) return 'Down';
    }
    return null;
  }

  _buyShareCounts() {
    return this.tradeSummary.buyEvents.reduce((counts, b) => {
      if (b.side === 'Up') counts.up += Number(b.shares ?? 0);
      if (b.side === 'Down') counts.down += Number(b.shares ?? 0);
      return counts;
    }, { up: 0, down: 0 });
  }

  _estimateSettlementPayout(resolvedMarket) {
    const payouts = resolvedMarket?.resolvedPayouts;
    if (!Array.isArray(payouts) || payouts.length < 2) return null;
    const { up, down } = this._buyShareCounts();
    if (up > 0 || down > 0) {
      return (up * Number(payouts[0] ?? 0)) + (down * Number(payouts[1] ?? 0));
    }
    return (this.walletBalanceUp * Number(payouts[0] ?? 0)) + (this.walletBalanceDown * Number(payouts[1] ?? 0));
  }

  // ── 감사 로그 / 대시보드 ───────────────────────────────────────────────────────
  _recordAudit(eventType, payload = {}) {
    this.auditLog.write(eventType, {
      slug: this.market.slug,
      marketSymbol: traderSymbol(this.market, this.config),
      lifecycle: this.lifecycle,
      totalSpent: this.totalSpent,
      settledPayoutUsdc: this.settledPayoutUsdc,
      beatPrice: this.beatPrice,
      ...payload,
    });
  }

  _recordSnapshotAudit(snapshot, model) {
    this._recordAudit('market_snapshot', {
      loop: this._loopCount,
      secondsAfterOpen: snapshot.secondsAfterOpen,
      secondsLeft: snapshot.secondsLeft,
      hub: snapshot.hub,
      pm: snapshot.pm ? {
        impliedUp: snapshot.pm.impliedUp,
        pairAskCost: snapshot.pm.pairAskCost,
        up: { bestAsk: snapshot.pm.up.bestAsk, bestBid: snapshot.pm.up.bestBid, mid: snapshot.pm.up.mid, ageMs: snapshot.pm.up.ageMs },
        down: { bestAsk: snapshot.pm.down.bestAsk, bestBid: snapshot.pm.down.bestBid, mid: snapshot.pm.down.mid, ageMs: snapshot.pm.down.ageMs },
      } : null,
      model: model?.ok ? {
        pUp: model.pUp, pDown: model.pDown,
        sigmaPerSqrtSecond: model.sigmaPerSqrtSecond,
        driftSignal: model.driftSignal, z: model.z, zBase: model.zBase, zDrift: model.zDrift,
        features: model.features,
      } : { ok: false, reason: model?.reason ?? null },
      lotState: this._lotState(),
    });
  }

  _publishSnapshot(snapshot, model) {
    const pm = snapshot.pm;
    const upAsk = positiveFiniteOrNull(pm?.up?.bestAsk);
    const downAsk = positiveFiniteOrNull(pm?.down?.bestAsk);
    const consensusPrice = Number(snapshot.hub?.consensusPrice);
    const move = (Number.isFinite(consensusPrice) && Number.isFinite(this.beatPrice)) ? consensusPrice - this.beatPrice : null;
    const chartPoint = {
      second: clamp(snapshot.secondsAfterOpen, 0, this.config.MARKET_WINDOW_SECONDS),
      move,
      upAsk,
      downAsk,
    };
    this._publishMarket({
      btcPrice: Number.isFinite(consensusPrice) ? consensusPrice : null,
      upBestAsk: upAsk,
      upBestBid: positiveFiniteOrNull(pm?.up?.bestBid),
      downBestAsk: downAsk,
      downBestBid: positiveFiniteOrNull(pm?.down?.bestBid),
      chartPoint,
      fairProbUp: model?.ok ? model.pUp : null,
      fairProbDown: model?.ok ? model.pDown : null,
      edgeUp: (model?.ok && upAsk != null) ? model.pUp - upAsk : null,
      edgeDown: (model?.ok && downAsk != null) ? model.pDown - downAsk : null,
      driftSignal: model?.ok ? model.driftSignal : null,
      impliedUp: pm?.impliedUp ?? null,
      pairAskCost: pm?.pairAskCost ?? null,
      tradeStatus: this._defaultTradeStatus(),
    });
  }

  _defaultTradeStatus() {
    if (this.lifecycle === BEAT_LIFECYCLE.MONITORING) return this.tradeSummary.buyShares > 0 ? 'buy placed' : BEAT_LIFECYCLE.MONITORING;
    return this.lifecycle;
  }

  _publishMarket(patch = {}) {
    if (!this.dashboard) return;
    const cfg = this.config;
    const lifecycle = patch.lifecycle ?? this.lifecycle;
    const settled = patch.settled ?? (lifecycle === BEAT_LIFECYCLE.SETTLED);
    this.dashboard.recordMarket({
      slug: this.market.slug,
      marketSymbol: traderSymbol(this.market, cfg),
      windowTs: this.market.windowTs,
      windowOpenAt: this.market.windowTs * 1000,
      windowCloseAt: (this.market.windowTs + cfg.MARKET_WINDOW_SECONDS) * 1000,
      conditionId: this.market.conditionId,
      lifecycle,
      settled: Boolean(settled),
      beatPrice: patch.beatPrice ?? this.beatPrice,
      btcPrice: patch.btcPrice ?? null,
      upBestBid: patch.upBestBid ?? null,
      upBestAsk: patch.upBestAsk ?? null,
      downBestBid: patch.downBestBid ?? null,
      downBestAsk: patch.downBestAsk ?? null,
      chartPoint: patch.chartPoint ?? null,
      fairProbUp: patch.fairProbUp ?? null,
      fairProbDown: patch.fairProbDown ?? null,
      edgeUp: patch.edgeUp ?? null,
      edgeDown: patch.edgeDown ?? null,
      driftSignal: patch.driftSignal ?? null,
      impliedUp: patch.impliedUp ?? null,
      pairAskCost: patch.pairAskCost ?? null,
      tradeStatus: patch.tradeStatus ?? this._defaultTradeStatus(),
      chosenSide: patch.chosenSide ?? this.tradeSummary.chosenSide,
      buyShares: patch.buyShares ?? this.tradeSummary.buyShares,
      buyUsdc: patch.buyUsdc ?? this.tradeSummary.buyUsdc,
      buyPrice: patch.buyPrice ?? this.tradeSummary.buyPrice,
      buyCount: patch.buyCount ?? this.tradeSummary.buyCount,
      buyEvents: patch.buyEvents ?? this.tradeSummary.buyEvents,
      pairEvents: patch.pairEvents ?? this.tradeSummary.pairEvents,
      pairedShares: patch.pairedShares ?? this.tradeSummary.pairedShares,
      pairedCostUsdc: patch.pairedCostUsdc ?? this.tradeSummary.pairedCostUsdc,
      averagePairedCost: patch.averagePairedCost ?? this.tradeSummary.averagePairedCost,
      lockedProfitUsdc: patch.lockedProfitUsdc ?? this.tradeSummary.lockedProfitUsdc,
      unpairedUpShares: patch.unpairedUpShares ?? this.tradeSummary.unpairedUpShares,
      unpairedDownShares: patch.unpairedDownShares ?? this.tradeSummary.unpairedDownShares,
      moveAtBuyUsd: patch.moveAtBuyUsd ?? this.tradeSummary.moveAtBuyUsd,
      moveAtBuyPct: patch.moveAtBuyPct ?? this.tradeSummary.moveAtBuyPct,
      btcPriceAtBuy: patch.btcPriceAtBuy ?? this.tradeSummary.btcPriceAtBuy,
      tradeOccurred: patch.tradeOccurred ?? Boolean(this.tradeSummary.buyShares > 0),
      outcome: patch.outcome ?? this.lastOutcome,
      pnl: patch.pnl ?? (this.settledPayoutUsdc - this.totalSpent),
      settledPayoutUsdc: patch.settledPayoutUsdc ?? this.settledPayoutUsdc,
      settledAt: patch.settledAt ?? null,
      updatedAt: Date.now(),
    });
  }
}
