/**
 * beat/replay-metrics.js
 * 보조 진단 지표(주 목적은 PnL, 이건 참고용 calibration).
 * tape 의 합의가격 시계열을 재구성해 라이브와 동일한 computeFairProbability 로 pUp 을
 * 재계산하고, 결과 라벨(up)에 대한 log-loss 를 낸다.
 */
import { computeMarketProbabilities } from './replay-sim.js';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function logLossFromMarkets(markets, params) {
  let sum = 0, n = 0;
  for (const snaps of markets) {
    const pUps = computeMarketProbabilities(snaps, params);
    for (let i = 0; i < snaps.length; i++) {
      const p = pUps[i];
      if (p == null) continue;
      const pc = clamp(p, 1e-6, 1 - 1e-6);
      const y = Number(snaps[i].up);
      if (y !== 0 && y !== 1) continue;
      sum += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
      n += 1;
    }
  }
  return n ? sum / n : Infinity;
}
