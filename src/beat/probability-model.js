/**
 * probability-model.js
 * ───────────────────────────────────────────────────────────────────────────
 * "근사-완벽" Up/Down 확률 추정기.
 *
 * 시장 정의(Polymarket BTC 5m up/down):
 *   - 윈도우 오픈 시점의 기준가 K(beat price)를 잡는다.
 *   - 윈도우 종료 시점의 가격 S_T 가 K 이상이면 "Up", 아니면 "Down".
 *
 * 모델: 로그가격을 드리프트-확산(기하 브라운 운동)으로 본다.
 *   x   = ln(S / K)                         (현재 기준가 대비 로그 거리)
 *   x_T = x + μ·τ + σ·√τ·Z,   Z ~ N(0,1)
 *   P(Up) = P(x_T ≥ 0) = Φ( (x + μ·τ) / (σ·√τ) )
 *
 * τ        : 종료까지 남은 초
 * σ        : 합의 가격 시계열에서 EWMA 로 추정한 초당 √분산(per-√second 변동성)
 * μ·τ 역할 : 단일 노이즈 추정 대신, 다중 거래소 미시구조 신호를 [-1,1] 로
 *            정규화·융합해 "추가 z 이동량(zDrift)"으로 반영한다.
 *
 * 사용 신호(모두 [-1,1], + 는 상승 압력):
 *   momentum        - 합의 가격의 단기/중기 로그수익률(σ 로 표준화)
 *   obi             - 오더북 불균형(매수 깊이 우위 +)
 *   cvdRatio        - 체결 흐름 불균형(공격적 매수 우위 +)
 *   micropriceBias  - 마이크로프라이스가 미드 위로 치우침(매수 압력 +)
 *
 * 최종 fair 확률은 신뢰도(confidence)로 0.5 쪽으로 수축시키고 [min,max] 로 클램프.
 * 옵션으로 Polymarket 내재확률을 사전분포로 섞을 수 있으나, 기본 가중치 0(엣지 보존).
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((((a5 * t) + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCDF(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

function logReturn(curr, prev) {
  const c = Number(curr);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p) || c <= 0 || p <= 0) return null;
  return Math.log(c / p);
}

/**
/**
 * 합의 가격 시계열에서 EWMA per-√second 변동성을 추정한다.
 * history: [{ timeMs, price }] (오름차순)
 *
 * σ-스파이크 완화: 단발성 큰 수익률(예: 한 거래소 stale 틱)이 분산 추정을 순간적으로
 * 부풀려 확률을 왜곡하는 것을 막기 위해, 각 틱의 관측 분산을 현재 EWMA 분산의
 * maxJumpRatio 배로 winsorize(상한 클램프)한다. maxJumpRatio<=0 이면 비활성.
 */
export function ewmaSigmaPerSqrtSecond(history = [], lambda = 0.97, maxJumpRatio = 0) {
  const lam = clamp(Number(lambda) || 0.97, 0.5, 0.9999);
  const jumpCap = Number(maxJumpRatio) > 0 ? Number(maxJumpRatio) : 0;
  let variance = null;
  for (let i = 1; i < history.length; i += 1) {
    const prev = history[i - 1];
    const next = history[i];
    const dtSeconds = (Number(next?.timeMs) - Number(prev?.timeMs)) / 1000;
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) continue;
    const r = logReturn(next?.price, prev?.price);
    if (!Number.isFinite(r)) continue;
    let perSecondVar = (r * r) / dtSeconds;
    // 현재 EWMA 분산 대비 과도한 단발 스파이크를 상한 클램프.
    if (jumpCap > 0 && variance != null && variance > 0) {
      const cap = jumpCap * variance;
      if (perSecondVar > cap) perSecondVar = cap;
    }
    variance = variance == null
      ? perSecondVar
      : (lam * variance) + ((1 - lam) * perSecondVar);
  }
  return variance != null && variance > 0 ? Math.sqrt(variance) : null;
}

/**
 * 시계열에서 `msAgo` 이전(또는 그에 가장 가까운 과거) 샘플을 찾는다.
 */
function sampleAgo(history, msAgo, ref) {
  const cutoff = ref - msAgo;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (Number(history[i]?.timeMs ?? 0) <= cutoff) return history[i];
  }
  return history[0] ?? null;
}

/**
 * 여러 시간대 로그수익률을 σ 로 표준화해 [-1,1] 모멘텀 신호로 만든다.
 */
function momentumSignal(history, ref, sigmaPerSqrtSecond) {
  if (history.length < 2) return { signal: 0, parts: {} };
  const latest = history[history.length - 1];
  const horizons = [1_000, 3_000, 10_000, 30_000];
  const weights = { 1000: 0.40, 3000: 0.30, 10000: 0.20, 30000: 0.10 };
  let acc = 0;
  let wAcc = 0;
  const parts = {};
  for (const h of horizons) {
    const prior = sampleAgo(history, h, ref);
    const r = logReturn(latest?.price, prior?.price);
    if (!Number.isFinite(r)) continue;
    const horizonSeconds = h / 1000;
    // 해당 구간에서 기대되는 √분산으로 표준화 → z 단위.
    const scale = sigmaPerSqrtSecond && sigmaPerSqrtSecond > 0
      ? sigmaPerSqrtSecond * Math.sqrt(horizonSeconds)
      : Math.max(1e-9, Math.abs(r));
    const z = r / scale;
    const normalized = Math.tanh(z); // [-1,1]
    parts[`m${horizonSeconds}s`] = normalized;
    acc += normalized * weights[h];
    wAcc += weights[h];
  }
  return { signal: wAcc > 0 ? clamp(acc / wAcc, -1, 1) : 0, parts };
}

/**
 * 핵심 진입점: 현재 시점의 fair Up/Down 확률을 계산.
 *
 * @returns null | {
 *   pUp, pDown,
 *   sigmaPerSqrtSecond, driftSignal, zBase, zDrift, z, pRaw,
 *   features: {...}
 * }
 */
export function computeFairProbability({
  consensusPrice,
  beatPrice,
  secondsLeft,
  priceHistory = [],
  hub = {},
  config = {},
  marketImpliedUp = null,
} = {}) {
  const S = Number(consensusPrice);
  const K = Number(beatPrice);
  const tau = Number(secondsLeft);
  if (!Number.isFinite(S) || !Number.isFinite(K) || S <= 0 || K <= 0) return null;

  const ref = Number(hub?.timeMs) || Date.now();
  const lambda = Number(config.BEAT_PROBABILITY_VOL_LAMBDA) || 0.97;
  const volJumpCap = Number(config.BEAT_PROBABILITY_VOL_MAX_JUMP_RATIO) || 0;
  let sigmaPerSqrtSecond = ewmaSigmaPerSqrtSecond(priceHistory, lambda, volJumpCap);
  if (!Number.isFinite(sigmaPerSqrtSecond) || sigmaPerSqrtSecond <= 0) return null;

  // σ 하한: 실현 변동성이 비정상적으로 작을 때(가격 정체) z = x/(σ√τ) 가 과도하게
  // 커져 작은 가격 출렁임에도 확률이 급변(whipsaw)하는 것을 막는다. 하한은 가격 대비
  // bps(연간/절대 아님, per-√second 로그수익률 스케일)로 정의해 심볼 무관하게 적용.
  const volMinBps = Number(config.BEAT_PROBABILITY_VOL_MIN_BPS);
  if (Number.isFinite(volMinBps) && volMinBps > 0) {
    const sigmaFloor = volMinBps / 10_000; // 로그수익률 근사: bps 그대로 per-√second
    if (sigmaPerSqrtSecond < sigmaFloor) sigmaPerSqrtSecond = sigmaFloor;
  }

  // 종료에 매우 근접하면 사실상 확정.
  if (!Number.isFinite(tau) || tau <= 0) {
    const pUp = S >= K ? 1 : 0;
    return {
      pUp, pDown: 1 - pUp,
      sigmaPerSqrtSecond, driftSignal: 0, zBase: 0, zDrift: 0, z: 0, pRaw: pUp,
      features: { x: Math.log(S / K), secondsLeft: tau, terminal: true },
    };
  }

  const x = Math.log(S / K);
  const denom = sigmaPerSqrtSecond * Math.sqrt(tau);
  const zBase = denom > 0 ? x / denom : 0;

  // ── 방향 신호 융합 ─────────────────────────────────────────────────────────
  const { signal: momentum, parts: momentumParts } = momentumSignal(priceHistory, ref, sigmaPerSqrtSecond);
  const obi = clamp(Number(hub?.obi) || 0, -1, 1);
  const cvd = clamp(Number(hub?.cvdRatio) || 0, -1, 1);
  const microBias = clamp(Number(hub?.micropriceBias) || 0, -1, 1);

  const wMom = Math.max(0, Number(config.BEAT_MODEL_MOMENTUM_WEIGHT) ?? 0.40);
  const wObi = Math.max(0, Number(config.BEAT_MODEL_OBI_WEIGHT) ?? 0.20);
  const wCvd = Math.max(0, Number(config.BEAT_MODEL_CVD_WEIGHT) ?? 0.25);
  const wMicro = Math.max(0, Number(config.BEAT_MODEL_MICROPRICE_WEIGHT) ?? 0.15);
  const wTotal = wMom + wObi + wCvd + wMicro;
  const driftSignal = wTotal > 0
    ? clamp(((momentum * wMom) + (obi * wObi) + (cvd * wCvd) + (microBias * wMicro)) / wTotal, -1, 1)
    : 0;

  // 신호가 남은 시간 동안 z 를 얼마나 밀어주는지. 시간이 짧을수록 영향력 축소
  // (√(min(τ,60)/60) 로 스케일 → 마감 직전 과신 방지).
  const zScale = Number(config.BEAT_MODEL_DRIFT_Z_SCALE) || 1.0;
  const horizonShrink = Math.sqrt(clamp(Math.min(tau, 60) / 60, 0, 1));
  const zDrift = driftSignal * zScale * horizonShrink;

  const z = zBase + zDrift;
  const pRaw = normalCDF(clamp(z, -8, 8));

  // 신뢰도 수축 + 클램프.
  const confidence = clamp(Number(config.BEAT_PROBABILITY_CONFIDENCE) || 0.80, 0, 1);
  const minP = clamp(Number(config.BEAT_PROBABILITY_MIN) || 0.02, 0, 0.5);
  const maxP = clamp(Number(config.BEAT_PROBABILITY_MAX) || 0.98, 0.5, 1);
  let pUp = clamp(0.5 + (confidence * (pRaw - 0.5)), minP, maxP);

  // 옵션: Polymarket 내재확률을 사전분포로 섞기.
  const priorWeight = clamp(Number(config.BEAT_MODEL_MARKET_PRIOR_WEIGHT) || 0, 0, 1);
  if (priorWeight > 0 && Number.isFinite(Number(marketImpliedUp))) {
    pUp = clamp(((1 - priorWeight) * pUp) + (priorWeight * Number(marketImpliedUp)), minP, maxP);
  }

  return {
    pUp,
    pDown: 1 - pUp,
    sigmaPerSqrtSecond,
    driftSignal,
    zBase,
    zDrift,
    z,
    pRaw,
    features: {
      x,
      secondsLeft: tau,
      consensusPrice: S,
      beatPrice: K,
      momentum,
      momentumParts,
      obi,
      cvd,
      microBias,
      horizonShrink,
      confidence,
      marketImpliedUp: Number.isFinite(Number(marketImpliedUp)) ? Number(marketImpliedUp) : null,
    },
  };
}
