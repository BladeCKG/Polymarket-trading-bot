/**
 * beat/decision-log.js  —  full per-moment replay tape
 * ───────────────────────────────────────────────────────────────────────────
 * "결정"만이 아니라 **매 순간의 시장 상태(snapshot)**를 한 파일에 적재한다.
 * 개선된 모델은 다른 순간에 다른 결정을 하므로, 결정만 저장하면 재현이 불가능하다.
 * 따라서 모든 모니터 루프 틱마다 replay 에 필요한 최소 상태를 기록하고, 정산 시
 * outcome(Up/Down) 라벨을 붙여 한 파일(logs/beat-replay.ndjson)에 append 한다.
 *
 * → 이 tape 위에서 임의의 파라미터로 진입·페어 로직을 처음부터 재시뮬레이션(replay)
 *   하여 실제 net PnL 을 계산하고, PnL 을 최대화하도록 모델을 개선할 수 있다.
 *
 * 한 라인(snap) 스키마:
 *   { marketId, t(=초, 개장후), secondsLeft, consensusPrice, beatPrice,
 *     zBase, momentum, obi, cvd, microBias,        // 모델 feature(없으면 null)
 *     upAsk, downAsk, upBid, downBid, upAgeMs, downAgeMs,
 *     feeRate, feeExp,                              // 테이커 수수료 파라미터
 *     priceSeed?,                                   // 첫 스냅샷에만: 개장 전 워밍업 [[tRel,price]...]
 *     up }                                          // 결과 라벨(정산 시 부여, 1=Up)
 */

import fs from 'node:fs';
import path from 'node:path';
import logger from '../logger.js';

const DEFAULT_PATH = path.resolve(process.cwd(), 'logs', 'beat-replay.ndjson');

export class DecisionLog {
  constructor(filePath = DEFAULT_PATH, { minIntervalMs = 500 } = {}) {
    this.filePath = filePath;
    // tape 기록 최소 간격(ms). 루프가 100ms로 돌아도 이 간격보다 자주 기록하지 않는다.
    // 500ms = 1s 해상도 대비 타이밍 오차 절반, 용량 2배(vs 100ms 해상도 대비 1/5 용량).
    this._minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this._buffers = new Map(); // marketId -> snap[]
    this._lastSnapMs = new Map(); // marketId -> lastRecordedMs (interval gate)
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (err) {
      logger.warn('DecisionLog: cannot create log dir', { err: err.message });
    }
  }

  _buf(marketId) {
    const key = String(marketId ?? 'unknown');
    if (!this._buffers.has(key)) this._buffers.set(key, []);
    return this._buffers.get(key);
  }

  /** 매 루프 틱의 시장 상태를 버퍼에 적재(결과 라벨은 정산 시 부여). */
  recordSnapshot(marketId, snap = {}) {
    const key = String(marketId ?? 'unknown');
    const nowMs = Date.now();
    const isFirst = !this._buffers.has(key); // priceSeed 포함 첫 스냅은 반드시 기록.

    // 간격 게이트: 첫 스냅이 아니고 minInterval 미달이면 스킵.
    if (!isFirst && this._minIntervalMs > 0) {
      const last = this._lastSnapMs.get(key) ?? 0;
      if (nowMs - last < this._minIntervalMs) return;
    }
    this._lastSnapMs.set(key, nowMs);

    const s = {
      t: num(snap.t),
      secondsLeft: num(snap.secondsLeft),
      consensusPrice: num(snap.consensusPrice),
      beatPrice: num(snap.beatPrice),
      zBase: numOrNull(snap.zBase),
      momentum: numOrNull(snap.momentum),
      obi: numOrNull(snap.obi),
      cvd: numOrNull(snap.cvd),
      microBias: numOrNull(snap.microBias),
      upAsk: numOrNull(snap.upAsk),
      downAsk: numOrNull(snap.downAsk),
      upBid: numOrNull(snap.upBid),
      downBid: numOrNull(snap.downBid),
      upAgeMs: numOrNull(snap.upAgeMs),
      downAgeMs: numOrNull(snap.downAgeMs),
      feeRate: numOrNull(snap.feeRate),
      feeExp: numOrNull(snap.feeExp),
    };
    // 개장 전 워밍업 가격 시드(첫 스냅샷에만 존재). replay cold-start 해소용.
    if (Array.isArray(snap.priceSeed) && snap.priceSeed.length >= 2) {
      s.priceSeed = snap.priceSeed;
    }
    // 최소 요건: 시간축 + 적어도 한쪽 ask. (둘 다 없으면 replay 무의미)
    if (!Number.isFinite(s.secondsLeft)) return;
    if (s.upAsk == null && s.downAsk == null) return;
    this._buf(marketId).push(s);
  }

  /** 정산 시 호출: 버퍼된 모든 snap 에 outcome 라벨(up)을 붙여 한 파일에 append. */
  finalizeMarket(marketId, { outcome = null, beatPrice = null } = {}) {
    const key = String(marketId ?? 'unknown');
    const snaps = this._buffers.get(key);
    if (!snaps) return;
    this._buffers.delete(key);
    if (outcome !== 'Up' && outcome !== 'Down') return; // 라벨 없으면 학습 불가 → 버림
    if (!snaps.length) return;
    const up = outcome === 'Up' ? 1 : 0;
    const lines = snaps.map((s) => JSON.stringify({ marketId: key, up, ...s }));
    try {
      fs.appendFileSync(this.filePath, lines.join('\n') + '\n');
    } catch (err) {
      logger.warn('DecisionLog: append failed', { err: err.message });
    }
  }

  dropMarket(marketId) {
    this._buffers.delete(String(marketId ?? 'unknown'));
  }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function numOrNull(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

let _singleton = null;
export function getDecisionLog(filePath = DEFAULT_PATH, { minIntervalMs = 500 } = {}) {
  if (!_singleton) _singleton = new DecisionLog(filePath, { minIntervalMs });
  return _singleton;
}

export const DECISION_LOG_PATH = DEFAULT_PATH;
