/**
 * beat/replay-sim.js
 * ───────────────────────────────────────────────────────────────────────────
 * tape(매 순간 시장 상태) + 파라미터 → 진입·페어 로직을 처음부터 재시뮬레이션해
 * 한 마켓의 net PnL(수수료 차감)을 계산한다. beat-trader 의 핵심 의사결정과
 * 동일한 규칙을 순수 함수로 재현한다(라이브와 drift 방지 위해 동일 수식 사용).
 *
 * 단순화(현실 근사):
 *  - 체결은 해당 틱의 best ask 에 즉시·전량 된다고 가정(드라이런과 동일 가정).
 *  - 주문 크기는 USDC 모드 1주문 = BEAT_ORDER_SIZE_USDC, 예산 MAX_SPEND_PER_MARKET.
 *  - 페어 완성은 보유 미페어 전량을 반대편 ask 로 즉시 매수.
 *  - 수수료는 perShare = rate·(p(1-p))^exp (tape 의 feeRate/feeExp 사용).
 */

import { computeFairProbability, escalatedPairCapFromParams } from './probability-model.js';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function unitFee(price, rate, exp) {
  const p = Number(price), r = Number(rate), e = Number(exp);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  if (!Number.isFinite(r) || r <= 0) return 0;
  return r * Math.pow(p * (1 - p), Number.isFinite(e) && e >= 0 ? e : 1);
}

// ── 모델 확률 재계산(raw 합의가격 시계열 재구성) ────────────────────────────────
// tape 의 매 스냅샷 consensusPrice + t(개장후 초)는 그 자체로 합의가격 시계열이다.
// 이를 누적 재구성해 라이브와 "동일한" computeFairProbability 를 호출하면, σ(VOL_*),
// 모멘텀 시간대 가중치, zBase, drift, calibration 이 전부 새 파라미터로 재계산된다.
// (obi/cvd/microBias 는 호가창 즉시값이라 재계산 불가 → tape 저장값을 그대로 hub 로 전달.
//  단 그 가중치는 학습된다.)
//
// 성능: 모델에 영향 주는 파라미터가 같으면 확률은 불변이므로, model-signature 로
// 캐싱한다(좌표하강이 페어/진입 파라미터를 훑는 동안 확률 재계산을 건너뜀).
const _probCache = new WeakMap(); // snaps(배열 참조) -> Map<modelSig, pUp[]>

function modelSignature(p) {
  return [
    p.BEAT_PROBABILITY_VOL_LAMBDA, p.BEAT_PROBABILITY_VOL_MIN_BPS, p.BEAT_PROBABILITY_VOL_MAX_JUMP_RATIO,
    p.BEAT_MODEL_MOMENTUM_WEIGHT, p.BEAT_MODEL_OBI_WEIGHT, p.BEAT_MODEL_CVD_WEIGHT, p.BEAT_MODEL_MICROPRICE_WEIGHT,
    p.BEAT_MODEL_DRIFT_Z_SCALE, p.BEAT_PROBABILITY_CONFIDENCE, p.BEAT_PROBABILITY_MIN, p.BEAT_PROBABILITY_MAX,
    p.BEAT_PROBABILITY_CALIB_GAIN_BASE, p.BEAT_PROBABILITY_CALIB_GAIN_ENDGAME, p.BEAT_PROBABILITY_CALIB_REF_SECONDS,
    p.BEAT_MODEL_MOMENTUM_H1_WEIGHT, p.BEAT_MODEL_MOMENTUM_H2_WEIGHT, p.BEAT_MODEL_MOMENTUM_H3_WEIGHT, p.BEAT_MODEL_MOMENTUM_H4_WEIGHT,
    p.BEAT_MODEL_MARKET_PRIOR_WEIGHT, p.BEAT_HUB_PRICE_HISTORY_MS, p.BEAT_MIN_HISTORY_MS, p.MARKET_WINDOW_SECONDS,
  ].join(':');
}

/**
 * 한 마켓의 시간순 snaps 에 대해 각 시점 pUp 을 재구성된 raw 시계열로 재계산.
 * @returns (pUp|null)[]  (modelOk 면 pUp, 아니면 null)
 */
export function computeMarketProbabilities(snaps, params) {
  const retentionMs = num(params.BEAT_HUB_PRICE_HISTORY_MS, 120_000);
  const minHistMs = num(params.BEAT_MIN_HISTORY_MS, 15_000);
  const out = new Array(snaps.length);
  const hist = []; // { timeMs, price } — 라이브 hub.priceHistory() 와 동일 형태
  // 개장 전 워밍업 시드(첫 스냅샷의 priceSeed). 라이브 hub 는 윈도우를 넘어 히스토리를
  // 유지하므로 개장 직후에도 모델 평가가 됐지만, replay 는 tape 만 봐서 cold-start 였다.
  // 시드를 깔면 개장 직후(t<min-history)부터 라이브와 동일하게 σ/모멘텀이 재구성된다.
  // priceSeed: [[tRel(개장후 초, 음수 가능), price], ...]. timeMs(=tRel*1000) 로 환산해 선적재.
  const seed = snaps.find((s) => Array.isArray(s?.priceSeed) && s.priceSeed.length >= 2)?.priceSeed;
  if (seed) {
    for (const row of seed) {
      const tRel = Number(row?.[0]);
      const price = Number(row?.[1]);
      if (!Number.isFinite(tRel) || !Number.isFinite(price) || price <= 0) continue;
      const tMs = tRel * 1000;
      const last = hist[hist.length - 1];
      if (!last || tMs > last.timeMs) hist.push({ timeMs: tMs, price });
    }
  }
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    const secondsLeft = Number(s.secondsLeft);
    const cp = Number(s.consensusPrice);
    const tMs = Number(s.t) * 1000;
    if (Number.isFinite(cp) && cp > 0 && Number.isFinite(tMs)) {
      const last = hist[hist.length - 1];
      if (!last || tMs > last.timeMs) hist.push({ timeMs: tMs, price: cp });
    }
    // 보관 윈도우 적용(라이브 _evictPriceHistory 와 동일).
    const cutoff = tMs - retentionMs;
    while (hist.length && hist[0].timeMs < cutoff) hist.shift();
    // 최소 히스토리 게이트(라이브 _evaluateModel 패리티).
    const span = hist.length >= 2 ? hist[hist.length - 1].timeMs - hist[0].timeMs : 0;
    if (hist.length < 2 || span < minHistMs) { out[i] = null; continue; }
    const res = computeFairProbability({
      consensusPrice: cp,
      beatPrice: Number(s.beatPrice),
      secondsLeft,
      priceHistory: hist,
      hub: { timeMs: tMs, obi: s.obi, cvdRatio: s.cvd, micropriceBias: s.microBias },
      config: params,
    });
    out[i] = res ? res.pUp : null;
  }
  return out;
}

function getProbabilities(snaps, params) {
  let perSnaps = _probCache.get(snaps);
  if (!perSnaps) { perSnaps = new Map(); _probCache.set(snaps, perSnaps); }
  const sig = modelSignature(params);
  let pUps = perSnaps.get(sig);
  if (!pUps) { pUps = computeMarketProbabilities(snaps, params); perSnaps.set(sig, pUps); }
  return pUps;
}

/**
 * @param snaps  한 마켓의 시간순 snap 배열(up 라벨 포함)
 * @param params 평가할 파라미터(runtime-config 키 + 모델 파라미터)
 * @returns { net, gross, fees, spent, payout, buys, pairs }
 */
export function simulateMarket(snaps, params) {
  if (!Array.isArray(snaps) || !snaps.length) return null;
  const up = Number(snaps[0].up);
  if (up !== 0 && up !== 1) return null;

  const windowSeconds = num(params.MARKET_WINDOW_SECONDS, 300);
  const entryDelay = num(params.BEAT_ENTRY_DELAY_SECONDS, 5);
  const stopBefore = num(params.BEAT_STOP_BUYING_BEFORE_CLOSE_SECONDS, 20);
  const reqEdgeBase = num(params.BEAT_PROBABILITY_REQUIRED_EDGE, 0.1);
  const maxAsk = num(params.BEAT_SIDE_MAX_ASK, 0.9);
  const minAsk = num(params.BEAT_SIDE_MIN_ASK, 0.02);
  const maxAgeMs = num(params.BEAT_BOOK_MAX_AGE_MS, 1500);
  const reqStreak = Math.max(1, num(params.BEAT_EDGE_PERSISTENCE_SNAPSHOTS, 3));
  const cooldownMs = num(params.BEAT_BUY_COOLDOWN_MS, 2000);
  const orderUsdc = num(params.BEAT_ORDER_SIZE_USDC, 1);
  const minBuyUsdc = num(params.BEAT_MIN_BUY_USDC, 1);
  const maxSpend = num(params.MAX_SPEND_PER_MARKET, 6);
  const imbalanceCap = num(params.BEAT_MAX_INVENTORY_IMBALANCE_SHARES, 0);
  const baseCap = num(params.BEAT_ARB_PAIR_COST_MAX, 0.97);
  const arbPairEnabled = params.BEAT_ARB_PAIR_ENABLED !== false;
  const escalationOn = params.BEAT_ARB_PAIR_LOSS_ESCALATION_ENABLED !== false;
  const timeFloor = num(params.BEAT_ARB_PAIR_TIME_FLOOR, 0.5);
  const timeExp = num(params.BEAT_ARB_PAIR_TIME_EXPONENT, 1.5);

  // 상태
  const openLots = { Up: [], Down: [] };  // { shares, price, oppAskAtBuy }
  let pairedUpShares = 0, pairedDownShares = 0; // (정산엔 미사용; 페어는 즉시 상계)
  let totalSpent = 0;
  let totalFees = 0;
  let pairedPayout = 0; // 완성 페어가 받는 확정 $1/페어
  let buys = 0, pairs = 0;
  let lastBuyAtSec = -1e9; // 마지막 매수의 개장후 경과초(쿨다운은 실시간 기준).
  const streak = { Up: 0, Down: 0 };

  // ── 실패모드 진단 카운터(주: PnL, 보조: 두 critical 이슈 측정) ──────────────
  // critical#1 완전손실: 미페어로 정산까지 보유 + 그 사이드 패배(항상 회피 가능했음).
  // critical#2 조기 손실페어: 손실(pairCost>1)에 페어했는데, (a) 이후 그 사이드가 결국
  //   이겼거나 (b) 이후 무손실(arb, cost<=1) 페어 기회가 있었음 → 더 나은 결정이 있었음.
  // 올바른 손실페어: 손실 페어 + 그 사이드 패배 + 이후 더 나은 기회 없음.
  let completeLossShares = 0, completeLossUsd = 0;   // critical#1
  let earlyLossPairs = 0, earlyLossShares = 0, earlyLossRegretUsd = 0; // critical#2
  let correctLossPairs = 0, correctLossShares = 0;
  let profitPairs = 0; // 무손실(이익) 페어 건수

  // 쿨다운은 tape 의 t(개장후 경과초) 기준 실시간으로 판정한다(틱 수 환산 금지:
  // BEAT_BOOK_POLL_MS=0 등으로 틱 환산이 깨지면 재매수가 영원히 막혀 실거래와 괴리).
  const cooldownSec = Math.max(0, cooldownMs / 1000);

  // 모델 확률을 raw 시계열 재구성으로 일괄 재계산(σ/모멘텀/calibration 전부 반영).
  const pUps = getProbabilities(snaps, params);

  function unpaired(side) { return openLots[side].reduce((s, l) => s + l.shares, 0); }
  function unpairedAvgCost(side) {
    const lots = openLots[side];
    let sh = 0, cost = 0;
    for (const l of lots) { sh += l.shares; cost += l.shares * l.price; }
    return sh > 0 ? cost / sh : 0;
  }

  // 라이브 _directionalFuturePairTradeViability 와 동일 규칙.
  // 방향성 매수 후 반대편으로 페어를 닫을 때, 목표 반대편가(무위험 cap 기준)로 미페어
  // 전량을 사는 완성 매수 규모가 최소 주문(BEAT_MIN_BUY_USDC) 미만이면 진입을 막는다.
  // (그렇지 않으면 방향성 다리만 묶여 위험을 떠안게 됨.) USDC 모드 기준.
  function futurePairViable(side, addShares, addPrice, rate, exp) {
    if (!arbPairEnabled) return true;
    const existingShares = unpaired(side);
    const existingCost = existingShares * unpairedAvgCost(side);
    const blendedShares = existingShares + addShares;
    const blendedAvg = blendedShares > 0 ? (existingCost + addShares * addPrice) / blendedShares : addPrice;
    const heldUnitFee = unitFee(blendedAvg, rate, exp);
    const room = baseCap - blendedAvg - heldUnitFee;
    const targetOppositeAsk = room > 0 ? room - unitFee(room, rate, exp) : room;
    if (!Number.isFinite(targetOppositeAsk) || targetOppositeAsk <= 0) return false;
    const projectedPairSpentUsdc = blendedShares * targetOppositeAsk;
    return projectedPairSpentUsdc + 1e-9 >= minBuyUsdc;
  }

  // 시점 idx 이후, heldSide 를 무손실(arb, 페어비용<=1)로 닫을 수 있는 더 나은 기회가
  // 있었는지(반대편 ask 가 충분히 싸진 적이 있는지) 검사. (조기 손실페어 판정용)
  function futureArbChance(fromIdx, heldSide, heldPrice, heldFee) {
    const oppKey = heldSide === 'Up' ? 'downAsk' : 'upAsk';
    for (let j = fromIdx + 1; j < snaps.length; j++) {
      const oa = Number(snaps[j][oppKey]);
      if (!Number.isFinite(oa) || oa <= 0) continue;
      const oppF = unitFee(oa, num(snaps[j].feeRate, 0.07), num(snaps[j].feeExp, 1));
      if (heldPrice + heldFee + oa + oppF <= 1 + 1e-9) return true; // 무손실 페어 가능했음
    }
    return false;
  }

  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    const secondsLeft = Number(s.secondsLeft);
    const tAfter = windowSeconds - secondsLeft;

    // 모델 확률(raw 시계열 재구성 기반). null 이면 모델 평가 불가 시점.
    const pUp = pUps[i];
    const modelOk = pUp != null && Number.isFinite(pUp);

    const rate = num(s.feeRate, 0.07), exp = num(s.feeExp, 1);

    // ── 1) 페어 완성(반대편 매수로 미페어 닫기) ──────────────────────────────
    for (const heldSide of ['Up', 'Down']) {
      if (unpaired(heldSide) <= 1e-6) continue;
      const oppSide = heldSide === 'Up' ? 'Down' : 'Up';
      const oppAsk = oppSide === 'Up' ? s.upAsk : s.downAsk;
      const oppAge = oppSide === 'Up' ? s.upAgeMs : s.downAgeMs;
      if (!posFinite(oppAsk)) continue;
      if (oppAge != null && oppAge > maxAgeMs) continue;
      const oppFee = unitFee(oppAsk, rate, exp);

      let pairable = 0;
      let pairCostAcc = 0;   // 페어된 lot 들의 (heldPrice+heldFee+oppAsk+oppFee) 누적(가중)
      const lossPairLots = []; // 손실 페어로 닫히는 lot 들(분류용)
      for (const lot of openLots[heldSide]) {
        const heldFee = unitFee(lot.price, rate, exp);
        const total = lot.price + heldFee + oppAsk + oppFee; // 1주당 페어 총비용
        const cap = escalatedPairCapFromParams({ p: lot.price, a: oppAsk, b0: lot.oppAskAtBuy, heldFee, baseCap, enabled: escalationOn, tau: secondsLeft, windowSeconds, timeFloor, timeExp });
        if (total <= cap + 1e-9) {
          pairable += lot.shares;
          pairCostAcc += total * lot.shares;
          if (total > 1 + 1e-9) {
            lossPairLots.push({ shares: lot.shares, heldPrice: lot.price, heldFee, total });
          }
        }
      }
      if (pairable <= 1e-6) continue;
      if (pairable * oppAsk + 1e-9 < minBuyUsdc) continue; // dust 가드

      // 반대편 pairable 만큼 매수 → 즉시 상계(완성 페어는 정산 $1/페어 지급).
      const cost = pairable * oppAsk;
      totalSpent += cost;
      totalFees += pairable * oppFee;
      pairedPayout += pairable; // 페어 1주당 $1
      pairs += 1;

      // 손실/이익 페어 분류 + critical#2(조기 손실페어) 판정.
      const heldWonFinal = (heldSide === (up === 1 ? 'Up' : 'Down'));
      if (lossPairLots.length === 0) {
        profitPairs += 1;
      } else {
        for (const lp of lossPairLots) {
          const lockedLoss = (lp.total - 1) * lp.shares; // 이 손실페어로 확정된 손실(USD)
          // (a) 이 사이드가 결국 이겼으면 보유가 나았음 → 조기. (b) 이후 무손실 페어 기회 있었으면 조기.
          const betterLater = heldWonFinal || futureArbChance(i, heldSide, lp.heldPrice, lp.heldFee);
          if (betterLater) {
            earlyLossPairs += 1;
            earlyLossShares += lp.shares;
            // regret: 보유했다면 얻었을 최선(이기면 1-heldPrice-heldFee, 아니면 0 회피분)과의 차.
            // 보수적으로 "확정 손실액"을 regret 으로 집계(이 손실을 피할 수 있었으므로).
            earlyLossRegretUsd += lockedLoss;
          } else {
            correctLossPairs += 1;
            correctLossShares += lp.shares;
          }
        }
      }
      // 보유측 lot 소비(싼 것부터 — total 기준 근사: 그냥 pairable 만큼 차감)
      openLots[heldSide] = consume(openLots[heldSide], pairable);
    }

    // ── 2) 신규 방향성 매수 ──────────────────────────────────────────────────
    // 엔트리 윈도우/모델/쿨다운/예산 가드.
    const allowNew = tAfter >= entryDelay && secondsLeft > stopBefore;
    // 스트릭 갱신(라이브 _updateEdgeStreak 과 동일 규칙).
    if (modelOk) {
      for (const side of ['Up', 'Down']) {
        const ask = side === 'Up' ? s.upAsk : s.downAsk;
        const age = side === 'Up' ? s.upAgeMs : s.downAgeMs;
        const fp = side === 'Up' ? pUp : (1 - pUp);
        const reqEdge = reqEdgeBase + unitFee(ask, rate, exp);
        const edge = posFinite(ask) ? fp - ask : null;
        const ok = posFinite(ask) && (age == null || age <= maxAgeMs)
          && ask <= maxAsk && ask >= minAsk && edge != null && edge >= reqEdge;
        streak[side] = ok ? streak[side] + 1 : 0;
      }
    } else { streak.Up = 0; streak.Down = 0; }

    if (allowNew && modelOk && (tAfter - lastBuyAtSec) >= cooldownSec - 1e-9 && totalSpent < maxSpend - 1e-6) {
      // 후보 평가.
      let best = null;
      for (const side of ['Up', 'Down']) {
        const ask = side === 'Up' ? s.upAsk : s.downAsk;
        const age = side === 'Up' ? s.upAgeMs : s.downAgeMs;
        const fp = side === 'Up' ? pUp : (1 - pUp);
        if (!posFinite(ask)) continue;
        if (age != null && age > maxAgeMs) continue;
        if (ask > maxAsk || ask < minAsk) continue;
        const reqEdge = reqEdgeBase + unitFee(ask, rate, exp);
        const edge = fp - ask;
        if (edge < reqEdge) continue;
        if (streak[side] < reqStreak) continue;
        if (!best || edge > best.edge) best = { side, ask, edge };
      }
      if (best) {
        // 재고 불균형 가드.
        let blocked = false;
        if (imbalanceCap > 0) {
          const same = unpaired(best.side), opp = unpaired(best.side === 'Up' ? 'Down' : 'Up');
          if (same - opp >= imbalanceCap) blocked = true;
        }
        if (!blocked) {
          const spend = Math.min(orderUsdc, maxSpend - totalSpent);
          if (spend >= minBuyUsdc - 1e-9) {
            const shares = spend / best.ask;
            // 라이브 가드: 이 진입이 나중에 최소 규모로 페어를 닫을 수 있어야 함.
            if (futurePairViable(best.side, shares, best.ask, rate, exp)) {
              const oppAsk = best.side === 'Up' ? s.downAsk : s.upAsk;
              openLots[best.side].push({ shares, price: best.ask, oppAskAtBuy: posFinite(oppAsk) ? oppAsk : (1 - best.ask) });
              totalSpent += spend;
              totalFees += shares * unitFee(best.ask, rate, exp);
              buys += 1;
              lastBuyAtSec = tAfter;
            }
          }
        }
      }
    }
  }

  // ── 정산 ────────────────────────────────────────────────────────────────────
  // 완성 페어 payout(pairedPayout) + 미페어 보유분 중 이긴 사이드만 $1/주.
  const winSide = up === 1 ? 'Up' : 'Down';
  const loseSide = winSide === 'Up' ? 'Down' : 'Up';
  const unpairedWin = unpaired(winSide); // 이긴 사이드 미페어 보유 주식
  // critical#1 완전손실: 진 사이드를 미페어로 정산까지 보유 → 매몰비용 전액 손실.
  for (const lot of openLots[loseSide]) {
    completeLossShares += lot.shares;
    completeLossUsd += lot.shares * lot.price; // 1주당 price 만큼 손실(payout 0)
  }
  // 정산까지 미페어로 남은 directional lot 건수(양 사이드). 페어로 못 닫힌 포지션.
  const unpairedDirectionalLots = openLots.Up.length + openLots.Down.length;
  const unpairedDirectionalShares = unpaired('Up') + unpaired('Down');
  const payout = pairedPayout + unpairedWin;
  const gross = payout - totalSpent;
  const net = gross - totalFees;
  return {
    net, gross, fees: totalFees, spent: totalSpent, payout, buys, pairs,
    // 진단(두 critical 이슈 + 페어 품질)
    completeLossShares, completeLossUsd,
    earlyLossPairs, earlyLossShares, earlyLossRegretUsd,
    correctLossPairs, correctLossShares, profitPairs,
    unpairedDirectionalLots, unpairedDirectionalShares,
  };
}

function consume(lots, qty) {
  // 싼 가격(낮은 price)부터 소비.
  const sorted = [...lots].sort((a, b) => a.price - b.price);
  let need = qty;
  const out = [];
  for (const lot of sorted) {
    if (need <= 1e-12) { out.push(lot); continue; }
    if (lot.shares <= need + 1e-12) { need -= lot.shares; continue; }
    out.push({ ...lot, shares: lot.shares - need });
    need = 0;
  }
  return out;
}

function posFinite(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

/** 여러 마켓 tape 를 그룹핑(marketId 별). */
export function groupByMarket(snaps) {
  const map = new Map();
  for (const s of snaps) {
    const k = String(s.marketId ?? 'unknown');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  // 각 마켓 내부는 시간순(개장 후 t 오름차순).
  for (const arr of map.values()) arr.sort((a, b) => Number(a.t) - Number(b.t));
  return [...map.values()];
}

/** 마켓 묶음에 대해 파라미터의 총/평균 net PnL 등 평가. */
export function evaluateParams(markets, params) {
  let net = 0, gross = 0, fees = 0, spent = 0, buys = 0, pairs = 0, n = 0, traded = 0, wins = 0;
  // 두 critical 이슈 집계.
  let completeLossUsd = 0, completeLossShares = 0;
  let earlyLossPairs = 0, earlyLossRegretUsd = 0;
  let correctLossPairs = 0, profitPairs = 0;
  let unpairedDirectionalLots = 0;
  for (const snaps of markets) {
    const r = simulateMarket(snaps, params);
    if (!r) continue;
    n += 1;
    net += r.net; gross += r.gross; fees += r.fees; spent += r.spent; buys += r.buys; pairs += r.pairs;
    if (r.buys > 0) { traded += 1; if (r.net > 0) wins += 1; }
    completeLossUsd += r.completeLossUsd; completeLossShares += r.completeLossShares;
    earlyLossPairs += r.earlyLossPairs; earlyLossRegretUsd += r.earlyLossRegretUsd;
    correctLossPairs += r.correctLossPairs; profitPairs += r.profitPairs;
    unpairedDirectionalLots += r.unpairedDirectionalLots;
  }
  return {
    markets: n, traded,
    net: round(net), gross: round(gross), fees: round(fees), spent: round(spent),
    buys, pairs,
    avgNetPerMarket: n ? round(net / n) : 0,
    winRate: traded ? round(wins / traded, 4) : 0,
    // critical#1: 완전손실(미페어 보유→패배). 가장 줄여야 할 값.
    completeLossUsd: round(completeLossUsd), completeLossShares: round(completeLossShares),
    // critical#2: 조기 손실페어(나중에 더 나은 기회 있었음).
    earlyLossPairs, earlyLossRegretUsd: round(earlyLossRegretUsd),
    correctLossPairs, profitPairs,
    // 정산까지 미페어로 남은 directional buy 건수.
    unpairedDirectionalLots,
  };
}

function round(x, d = 4) { const m = 10 ** d; return Math.round(Number(x) * m) / m; }
