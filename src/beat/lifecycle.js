export const BEAT_LIFECYCLE = Object.freeze({
  UPCOMING: 'upcoming',
  WAITING_SKIP: 'waiting for skip',
  MONITORING: 'monitoring',
  RESOLVING: 'resolving',
  SETTLED: 'settled',
  HALTED: 'halted',
});

export const BEAT_LIFECYCLE_ORDER = Object.freeze({
  [BEAT_LIFECYCLE.UPCOMING]: 0,
  [BEAT_LIFECYCLE.WAITING_SKIP]: 1,
  [BEAT_LIFECYCLE.MONITORING]: 2,
  [BEAT_LIFECYCLE.RESOLVING]: 3,
  [BEAT_LIFECYCLE.HALTED]: 4,
  [BEAT_LIFECYCLE.SETTLED]: 5,
});

export function lifecycleRank(value) {
  return BEAT_LIFECYCLE_ORDER[String(value ?? '').trim().toLowerCase()] ?? BEAT_LIFECYCLE_ORDER[BEAT_LIFECYCLE.UPCOMING];
}
