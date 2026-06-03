/**
 * beat/model-store.js
 * ───────────────────────────────────────────────────────────────────────────
 * 학습된 모델 파라미터(models/beat-model.json)를 읽어 런타임 config 에 머지한다.
 *
 * 권위 순서(나중이 우선): env/config.js 기본값  <  학습된 모델 파일.
 * 즉 학습으로 개선된 값이 .env 설정을 오버라이드한다("env 는 불가침이 아니다").
 *
 * 모델 파일 스키마(예):
 * {
 *   "version": 3,
 *   "updatedAt": "2026-06-03T...",
 *   "metrics": { "logLossBefore":..., "logLossAfter":..., ... },
 *   "params": {
 *     "BEAT_MODEL_MOMENTUM_WEIGHT": 0.42,
 *     "BEAT_PROBABILITY_CALIB_GAIN_BASE": 1.8,
 *     "BEAT_ARB_PAIR_COST_MAX": 0.965,
 *     ...
 *   }
 * }
 * params 의 키는 runtime-config DEFAULTS 에 존재하는 것만 적용된다.
 */

import fs from 'node:fs';
import path from 'node:path';
import logger from '../logger.js';

export const MODEL_PATH = path.resolve(process.cwd(), 'models', 'beat-model.json');

export function loadLearnedModel(filePath = MODEL_PATH) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.params || typeof parsed.params !== 'object') {
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn('model-store: failed to load learned model, ignoring', { filePath, err: err.message });
    return null;
  }
}

/** 학습된 params 를 overrides 객체로 반환(runtime-config 에 머지용). 없으면 {}. */
export function learnedConfigOverrides(filePath = MODEL_PATH) {
  const model = loadLearnedModel(filePath);
  if (!model) return {};
  return { ...model.params };
}

export function saveLearnedModel(model, filePath = MODEL_PATH) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = { ...model, updatedAt: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n');
  return payload;
}
