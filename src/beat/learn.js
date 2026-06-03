/**
 * beat/learn.js  —  replay · validate · improve · persist  (walk-forward 검증)
 * ───────────────────────────────────────────────────────────────────────────
 * replay tape(logs/beat-replay.ndjson)를 읽어 마켓별로 묶고 시간순 정렬한 뒤:
 *   1) SPLIT   : 시간순으로 train(앞) / validation(뒤 최신 구간)으로 분할.
 *                개선 모델이 "미래"에서도 통하는지 보려면 검증은 학습보다 뒤여야 한다.
 *   2) REPLAY  : 현재 파라미터로 train·validation 각각 재시뮬레이션(replay-sim).
 *   3) IMPROVE : train 구간 총 net PnL(− critical 페널티)을 좌표하강으로 최대화.
 *   4) ACCEPT  : 최적 파라미터의 "validation 구간" net PnL 이 현재 모델보다 의미있게
 *                증가할 때만 채택(in-sample 과최적화 방지). train 만 올라도 채택 안 함.
 *   5) PERSIST : 채택 시에만 models/beat-model.json 저장(version++).
 *
 * "모델이 개선됐는가" = 한 번도 학습에 안 쓴 검증 구간(미래)에서 net PnL 이 늘었는가.
 * 표본이 BEAT_LEARN_MIN_MARKETS 미만이면 과최적화 위험이 커 학습을 보류한다.
 * 사용: node src/beat/learn.js   (npm run beat:learn) — 정산 시 자동 호출되기도 함.
 */

import fs from 'node:fs';
import readline from 'node:readline';
import { groupByMarket, evaluateParams } from './replay-sim.js';
import { logLossFromMarkets } from './replay-metrics.js';
import { loadLearnedModel, saveLearnedModel, MODEL_PATH } from './model-store.js';
import { getBeatRuntimeConfigDefaults } from './runtime-config.js';
import { DECISION_LOG_PATH } from './decision-log.js';
import {
  BEAT_LEARN_MIN_MARKETS,
  BEAT_LEARN_VALIDATION_FRACTION,
  BEAT_LEARN_MIN_VALIDATION_GAIN,
} from '../config.js';
import logger from '../logger.js';

// 학습 대상 파라미터와 탐색 범위(격자 라인서치).
const PARAM_SPACE = {
  // 확률 모델 — 신호 융합 가중치
  BEAT_MODEL_MOMENTUM_WEIGHT: [0, 1.0],
  BEAT_MODEL_OBI_WEIGHT: [0, 1.0],
  BEAT_MODEL_CVD_WEIGHT: [0, 1.0],
  BEAT_MODEL_MICROPRICE_WEIGHT: [0, 1.0],
  BEAT_MODEL_DRIFT_Z_SCALE: [0, 3],
  BEAT_PROBABILITY_CONFIDENCE: [0.4, 1.0],
  BEAT_PROBABILITY_CALIB_GAIN_BASE: [0.8, 3.0],
  BEAT_PROBABILITY_CALIB_GAIN_ENDGAME: [0.8, 5.0],
  // 확률 모델 — σ(변동성) 추정 파라미터 (raw 시계열 재구성으로 zBase 까지 재계산됨)
  BEAT_PROBABILITY_VOL_LAMBDA: [0.80, 0.999],
  BEAT_PROBABILITY_VOL_MIN_BPS: [0.0, 5.0],
  BEAT_PROBABILITY_VOL_MAX_JUMP_RATIO: [0.0, 10.0],
  // 확률 모델 — 모멘텀 시간대(1/3/10/30s) 가중치
  BEAT_MODEL_MOMENTUM_H1_WEIGHT: [0, 1.0],
  BEAT_MODEL_MOMENTUM_H2_WEIGHT: [0, 1.0],
  BEAT_MODEL_MOMENTUM_H3_WEIGHT: [0, 1.0],
  BEAT_MODEL_MOMENTUM_H4_WEIGHT: [0, 1.0],
  // 진입 정책
  BEAT_PROBABILITY_REQUIRED_EDGE: [0.0, 0.3],
  BEAT_SIDE_MAX_ASK: [0.6, 0.98],
  BEAT_SIDE_MIN_ASK: [0.02, 0.30],
  BEAT_STOP_BUYING_BEFORE_CLOSE_SECONDS: [0, 120],
  // 페어 cap
  BEAT_ARB_PAIR_COST_MAX: [0.90, 1.00],
  BEAT_ARB_PAIR_TIME_FLOOR: [0.0, 1.0],
  BEAT_ARB_PAIR_TIME_EXPONENT: [0.5, 3.0],
};

function round(x, d = 5) { const m = 10 ** d; return Math.round(Number(x) * m) / m; }

// 마켓의 개장 windowTs 를 추출(marketId 끝 숫자). walk-forward 분할 키.
function windowTsOf(snaps) {
  const id = String(snaps?.[0]?.marketId ?? '');
  const m = id.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

// 마켓 묶음을 시간순(개장 windowTs 오름차순)으로 정렬한다. marketId 형식:
// "btc-updown-5m-<windowTs>" → 끝의 숫자가 개장 시각. walk-forward 분할의 전제.
function sortMarketsChrono(markets) {
  return [...markets].sort((a, b) => windowTsOf(a) - windowTsOf(b));
}

// 목적함수 = net PnL − (완전손실 가중) − (조기 손실페어 후회 가중).
// PnL 이 주목표지만, 두 critical 이슈(완전손실 > 조기손실페어)를 추가로 눌러
// 같은 PnL 이면 critical 이슈가 적은 파라미터를 선호한다(lexicographic 근사).
const W_COMPLETE_LOSS = 0.5;   // 완전손실 1달러당 추가 페널티(최우선)
const W_EARLY_LOSS = 0.25;     // 조기 손실페어 후회 1달러당 추가 페널티(2순위)
function objective(ev) {
  return ev.net - W_COMPLETE_LOSS * ev.completeLossUsd - W_EARLY_LOSS * ev.earlyLossRegretUsd;
}

async function readSnaps(filePath) {
  const out = [];
  if (!fs.existsSync(filePath)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    out.push(o);
  }
  return out;
}

// 좌표하강으로 목적함수(=net PnL − critical 페널티)를 최대화. 현재 파라미터에서
// 출발하므로 결과는 현재보다 같거나 크다(단조). 여러 패스 반복, 개선 없으면 조기 종료.
function optimize(markets, startParams) {
  const params = { ...startParams };
  let best = objective(evaluateParams(markets, params));
  const keys = Object.keys(PARAM_SPACE);
  const passes = 6;
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    for (const key of keys) {
      const [lo, hi] = PARAM_SPACE[key];
      const steps = 17;
      let bestVal = params[key];
      let localBest = best;
      for (let i = 0; i < steps; i++) {
        const v = lo + (hi - lo) * (i / (steps - 1));
        const trial = { ...params, [key]: v };
        const score = objective(evaluateParams(markets, trial));
        if (score > localBest + 1e-9) { localBest = score; bestVal = v; }
      }
      if (bestVal !== params[key]) { params[key] = bestVal; best = localBest; improved = true; }
    }
    if (!improved) break;
  }
  return { params, score: best };
}

/**
 * 핵심 학습 루틴(CLI/자동 트리거 공용).  walk-forward 검증:
 * train 으로 최적화한 파라미터가 validation(미래) 구간에서도 현재 모델보다 PnL 이
 * 의미있게 높을 때만 저장한다(in-sample 과최적화 방지).
 * @returns { improved, before, after, version?, params?, markets, ... }
 */
export async function runLearn({
  logPath = DECISION_LOG_PATH,
  minMarkets = BEAT_LEARN_MIN_MARKETS,
  validationFraction = BEAT_LEARN_VALIDATION_FRACTION,
  minValidationGain = BEAT_LEARN_MIN_VALIDATION_GAIN,
  quiet = false,
} = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  const snaps = await readSnaps(logPath);
  const allMarkets = sortMarketsChrono(groupByMarket(snaps));
  if (allMarkets.length < minMarkets) {
    return { improved: false, reason: 'insufficient-markets', markets: allMarkets.length, minMarkets };
  }

  // ── train / validation 시간순 분할(윈도우 경계 기준) ───────────────────────
  // 검증은 학습보다 "뒤(미래)" 구간이어야 walk-forward 의미가 산다.
  // 멀티심볼이면 같은 windowTs 에 여러 심볼 마켓이 공존하므로, 분할은 마켓 개수가 아닌
  // "윈도우(개장 시각) 경계"에서 끊는다. 같은 윈도우의 심볼들이 train/val 로 쪼개져
  // 정보가 새는 것(leakage)을 막는다.
  const vFrac = clamp01(validationFraction, 0.1, 0.9);
  const windowTsList = [...new Set(allMarkets.map(windowTsOf))].sort((a, b) => a - b);
  const nWindows = windowTsList.length;
  let nValWindows = Math.round(nWindows * vFrac);
  nValWindows = Math.max(1, Math.min(nWindows - 1, nValWindows)); // 양쪽 최소 1 윈도우 보장
  const cutoffTs = windowTsList[nWindows - nValWindows]; // 이 윈도우부터(포함) validation
  const trainMarkets = allMarkets.filter((m) => windowTsOf(m) < cutoffTs);
  const valMarkets = allMarkets.filter((m) => windowTsOf(m) >= cutoffTs);
  if (!trainMarkets.length || !valMarkets.length) {
    return { improved: false, reason: 'split-degenerate', markets: allMarkets.length, windows: nWindows };
  }

  const defaults = getBeatRuntimeConfigDefaults();
  const existing = loadLearnedModel();
  const currentParams = { ...defaults, ...(existing?.params ?? {}) };

  // 현재 모델 평가: train / validation / 전체.
  const curTrain = evaluateParams(trainMarkets, currentParams);
  const curVal = evaluateParams(valMarkets, currentParams);
  const curAll = evaluateParams(allMarkets, currentParams);

  // 시작점 후보(현재 + 중립 calibration) 중 train 목적함수가 더 좋은 쪽에서 최적화.
  const cands = [
    currentParams,
    { ...currentParams, BEAT_PROBABILITY_CALIB_GAIN_BASE: 1, BEAT_PROBABILITY_CALIB_GAIN_ENDGAME: 1 },
  ];
  let start = currentParams, startScore = -Infinity;
  for (const c of cands) { const sc = objective(evaluateParams(trainMarkets, c)); if (sc > startScore) { startScore = sc; start = c; } }

  // train 구간으로만 최적화(validation 은 절대 최적화에 쓰지 않는다).
  const opt = optimize(trainMarkets, start);

  // 최적 파라미터를 train / validation / 전체에서 평가.
  const newTrain = evaluateParams(trainMarkets, opt.params);
  const newVal = evaluateParams(valMarkets, opt.params);
  const newAll = evaluateParams(allMarkets, opt.params);

  const valGain = newVal.net - curVal.net;
  const trainGain = newTrain.net - curTrain.net;
  log(`beat:learn — markets=${allMarkets.length} (train=${trainMarkets.length} val=${valMarkets.length})`);
  log(`  TRAIN net: ${round(curTrain.net)} -> ${round(newTrain.net)} (Δ ${round(trainGain)})`);
  log(`  VALID net: ${round(curVal.net)} -> ${round(newVal.net)} (Δ ${round(valGain)})  ← 채택 기준`);
  log(`  completeLossUsd(val): ${curVal.completeLossUsd} -> ${newVal.completeLossUsd}  earlyLossRegret(val): ${curVal.earlyLossRegretUsd} -> ${newVal.earlyLossRegretUsd}`);

  // ── 채택 게이트(검증 구간 기준) ───────────────────────────────────────────
  //  (1) validation net PnL 이 의미있게 증가(0/근사0 은 개선 아님) AND
  //  (2) validation 의 두 critical 이슈가 악화되지 않음.
  const completeLossOk = newVal.completeLossUsd <= curVal.completeLossUsd + 1e-6;
  const earlyLossOk = newVal.earlyLossRegretUsd <= curVal.earlyLossRegretUsd + 1e-6;
  if (valGain < minValidationGain || !completeLossOk || !earlyLossOk) {
    return {
      improved: false,
      reason: valGain < minValidationGain ? 'no-validation-gain'
        : (!completeLossOk ? 'val-complete-loss-worsened' : 'val-early-loss-worsened'),
      // 대시보드 표시는 "전체 마켓" 기준 PnL 을 보여준다(현재→최적). 채택은 val 기준.
      before: round(curAll.net), after: round(newAll.net), netGain: round(newAll.net - curAll.net),
      valBefore: round(curVal.net), valAfter: round(newVal.net), valGain: round(valGain),
      markets: allMarkets.length, trainMarkets: trainMarkets.length, valMarkets: valMarkets.length,
    };
  }

  const newParams = {};
  for (const k of Object.keys(PARAM_SPACE)) newParams[k] = round(opt.params[k], 5);
  const mergedParams = { ...(existing?.params ?? {}), ...newParams };
  const model = {
    version: (existing?.version ?? 0) + 1,
    metrics: {
      markets: allMarkets.length, trainMarkets: trainMarkets.length, valMarkets: valMarkets.length,
      validationFraction: round(vFrac, 3),
      // 전체 마켓 기준 PnL(대시보드 표시용).
      netBefore: round(curAll.net), netAfter: round(newAll.net),
      // 검증 구간 기준 PnL(실제 채택 근거).
      valNetBefore: round(curVal.net), valNetAfter: round(newVal.net), valNetGain: round(valGain),
      trainNetBefore: round(curTrain.net), trainNetAfter: round(newTrain.net),
      avgNetBefore: curAll.avgNetPerMarket, avgNetAfter: newAll.avgNetPerMarket,
      winRateBefore: curVal.winRate, winRateAfter: newVal.winRate,
      // critical#1 완전손실(검증 구간).
      completeLossUsdBefore: curVal.completeLossUsd, completeLossUsdAfter: newVal.completeLossUsd,
      // critical#2 조기 손실페어(검증 구간).
      earlyLossPairsBefore: curVal.earlyLossPairs, earlyLossPairsAfter: newVal.earlyLossPairs,
      earlyLossRegretBefore: curVal.earlyLossRegretUsd, earlyLossRegretAfter: newVal.earlyLossRegretUsd,
      correctLossPairsAfter: newVal.correctLossPairs, profitPairsAfter: newVal.profitPairs,
      // 정산까지 미페어로 남은 directional buy 건수(검증 구간, 이전/개선).
      unpairedBefore: curVal.unpairedDirectionalLots, unpairedAfter: newVal.unpairedDirectionalLots,
      logLossBefore: round(logLossFromMarkets(valMarkets, currentParams), 5),
      logLossAfter: round(logLossFromMarkets(valMarkets, opt.params), 5),
    },
    params: mergedParams,
  };
  const saved = saveLearnedModel(model);
  log('beat:learn — saved improved model →', MODEL_PATH, 'version', saved.version, `(val Δ ${round(valGain)})`);
  return {
    improved: true,
    before: round(curAll.net), after: round(newAll.net), netGain: round(newAll.net - curAll.net),
    valBefore: round(curVal.net), valAfter: round(newVal.net), valGain: round(valGain),
    version: saved.version, params: mergedParams,
    markets: allMarkets.length, trainMarkets: trainMarkets.length, valMarkets: valMarkets.length,
    metrics: model.metrics,
  };
}

function clamp01(v, lo = 0, hi = 1) { const n = Number(v); return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo)); }

async function mainCli() {
  const logPath = process.argv[2] || DECISION_LOG_PATH;
  console.log('beat:learn — reading', logPath);
  const r = await runLearn({ logPath });
  if (r.improved) {
    console.log('metrics:', JSON.stringify(r.metrics, null, 2));
    console.log('params:', JSON.stringify(r.params, null, 2));
  } else {
    console.log('No model change:', r.reason, JSON.stringify({ before: r.before, after: r.after, markets: r.markets }));
  }
}

// CLI 로 직접 실행될 때만 main 구동.
const isCli = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/beat/learn.js');
if (isCli) {
  mainCli().catch((err) => { logger.error('beat:learn failed', { err: err.message }); process.exit(1); });
}
