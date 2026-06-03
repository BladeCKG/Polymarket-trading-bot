/**
 * beat/auto-learn.js
 * ───────────────────────────────────────────────────────────────────────────
 * 마켓이 정산될 때마다 자동으로 학습을 트리거한다.
 *  - runLearn 은 전체 이전 마켓을 재replay 해 총 net PnL 이 현재 모델보다 엄격히
 *    증가할 때만 모델 파일을 갱신한다(단조 개선 보장).
 *  - 개선돼도 "진행 중" 마켓에는 즉시 적용하지 않는다. 개선된 파라미터를 pending 으로
 *    보류해두고, 다음 "새 마켓"이 시작될 때 applyPending() 으로만 살아있는 config 에
 *    반영한다 → 한 마켓은 시작부터 끝까지 동일 모델로 일관되게 동작.
 *  - 동시 실행 금지(직렬화) + 디바운스: 학습 중 들어온 정산은 1회만 대기 후 재실행.
 *  - 학습은 setImmediate 로 다음 틱에 돌려 정산 처리 경로를 막지 않는다.
 */

import { runLearn } from './learn.js';
import { loadLearnedModel } from './model-store.js';
import { applyBeatRuntimeConfigPatch } from './runtime-config.js';
import { BEAT_LEARN_MIN_MARKETS } from '../config.js';
import logger from '../logger.js';

export class AutoLearner {
  constructor(beatConfig, { dashboard = null, minMarkets = BEAT_LEARN_MIN_MARKETS, onApplied = null } = {}) {
    this.beatConfig = beatConfig;
    this.dashboard = dashboard;
    this.minMarkets = minMarkets;
    this.onApplied = typeof onApplied === 'function' ? onApplied : null;
    this._running = false;
    this._pending = false;
    this._pendingParams = null;   // 개선됐지만 아직 새 마켓에 미적용된 파라미터.
    this._pendingMeta = null;
    this.lastResult = null;
    // 모델이 "실제로 개선된" 시각(시도 시각 아님). 재시작 시 모델 파일 updatedAt 으로 복원.
    this.lastImprovedAt = null;
    this.lastAppliedAt = null;
    try {
      const m = loadLearnedModel();
      if (m?.updatedAt) { const t = Date.parse(m.updatedAt); if (Number.isFinite(t)) this.lastImprovedAt = t; }
    } catch { /* ignore */ }
  }

  /** 정산 콜백에서 호출. 즉시 반환(학습은 백그라운드 직렬 실행). */
  notifySettled() {
    if (this._running) { this._pending = true; return; }
    this._running = true;
    setImmediate(() => { this._run().catch((err) => logger.warn('AutoLearner: run failed', { err: err.message })); });
  }

  /**
   * 새 마켓 시작 직전에 호출. 보류 중인 개선 모델이 있으면 그때 살아있는 config 에
   * 적용한다(진행 중 마켓은 건드리지 않음). 적용했으면 true.
   */
  applyPending() {
    if (!this._pendingParams) return false;
    const params = this._pendingParams;
    const meta = this._pendingMeta;
    this._pendingParams = null;
    this._pendingMeta = null;
    applyBeatRuntimeConfigPatch(this.beatConfig, params);
    this.lastAppliedAt = Date.now();
    logger.info('AutoLearner: applied improved model to new market', {
      version: meta?.version, netBefore: meta?.before, netAfter: meta?.after, markets: meta?.markets,
    });
    this._reportLearning({
      status: 'applied',
      improved: true,
      netBefore: meta?.before, netAfter: meta?.after, netGain: meta ? round2(meta.after - meta.before) : null,
      valBefore: meta?.valBefore, valAfter: meta?.valAfter, valGain: meta?.valGain,
      trainMarkets: meta?.trainMarkets, valMarkets: meta?.valMarkets,
      version: meta?.version, markets: meta?.markets,
      metrics: meta?.metrics ?? null,
      unpairedBefore: meta?.metrics?.unpairedBefore ?? null,
      unpairedAfter: meta?.metrics?.unpairedAfter ?? null,
      lastImprovedAt: this.lastImprovedAt,
      appliedAt: this.lastAppliedAt,
    });
    this.onApplied?.(params, meta);
    return true;
  }

  async _run() {
    try {
      const result = await runLearn({ minMarkets: this.minMarkets, quiet: true });
      this.lastResult = result;

      // 학습이 끝날 때마다(개선이든 아니든) 대시보드에 결과를 보고한다.
      const evaluatedAt = Date.now();
      if (result.improved) {
        const model = loadLearnedModel();
        if (model?.params) {
          this._pendingParams = { ...model.params };
          this._pendingMeta = { version: result.version, before: result.before, after: result.after, markets: result.markets, metrics: result.metrics, valBefore: result.valBefore, valAfter: result.valAfter, valGain: result.valGain, trainMarkets: result.trainMarkets, valMarkets: result.valMarkets };
        }
        this.lastImprovedAt = evaluatedAt; // 실제 개선 시각 기록.
        logger.info('AutoLearner: improved model staged (apply on next new market)', {
          version: result.version, netBefore: result.before, netAfter: result.after, netGain: result.netGain, markets: result.markets,
        });
        this._reportLearning({
          status: 'improved-pending',
          improved: true,
          netBefore: result.before, netAfter: result.after, netGain: result.netGain,
          valBefore: result.valBefore, valAfter: result.valAfter, valGain: result.valGain,
          trainMarkets: result.trainMarkets, valMarkets: result.valMarkets,
          version: result.version, markets: result.markets,
          metrics: result.metrics ?? null,
          unpairedBefore: result.metrics?.unpairedBefore ?? null,
          unpairedAfter: result.metrics?.unpairedAfter ?? null,
          lastImprovedAt: this.lastImprovedAt,
          evaluatedAt,
        });
      } else {
        logger.info('AutoLearner: no improvement', {
          reason: result.reason, netBefore: result.before ?? null, netAfter: result.after ?? null,
          netGain: result.netGain ?? 0, markets: result.markets,
        });
        this._reportLearning({
          status: 'not-improved',
          improved: false,
          reason: result.reason,
          netBefore: result.before ?? null, netAfter: result.after ?? null, netGain: result.netGain ?? 0,
          valBefore: result.valBefore ?? null, valAfter: result.valAfter ?? null, valGain: result.valGain ?? null,
          trainMarkets: result.trainMarkets ?? null, valMarkets: result.valMarkets ?? null,
          markets: result.markets,
          lastImprovedAt: this.lastImprovedAt, // 이전에 개선된 적이 있으면 그 시각 유지.
          evaluatedAt,
        });
      }
    } finally {
      this._running = false;
      if (this._pending) { this._pending = false; this.notifySettled(); }
    }
  }

  /** 대시보드로 학습 결과 보고(+ 최근 이력 유지). */
  _reportLearning(info) {
    this.lastLearning = info;
    this._history = this._history || [];
    this._history.unshift(info);
    if (this._history.length > 20) this._history.length = 20;
    this.dashboard?.setLearning?.({ ...info, history: this._history });
  }
}

function round2(x) { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
