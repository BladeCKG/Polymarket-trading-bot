const HOT_ADJUST_TICKS = 1;
const TOXIC_ADJUST_TICKS = 2;
const DEFAULT_TICK_SIZE = 0.01;
const HOT_THRESHOLD_RATIO = 0.5;
const SATURATION_RATIO = 0.85;
const SATURATION_SCORE_MULTIPLIER = 1.5;

function finitePositive(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizeTradeSide(value) {
  const side = String(value ?? '').trim().toUpperCase();
  if (side === 'BUY') return 'BUY';
  if (side === 'SELL') return 'SELL';
  return null;
}

function normalizeTimeMs(value) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return num > 1e12 ? num : num * 1000;
  }
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function createEmptyWindow() {
  return {
    ticks: [],
    state: {
      isHot: false,
      isToxic: false,
    },
  };
}

export class BeatOfiTracker {
  constructor({
    enabled = true,
    windowMs = 3_000,
    toxicityThreshold = 200,
    ratioEnter = 0.70,
    ratioExit = 0.40,
    exitRatio = 0.85,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.windowMs = Math.max(250, Number(windowMs) || 3_000);
    this.toxicityThreshold = Math.max(1, Number(toxicityThreshold) || 200);
    this.ratioEnter = Math.max(0, Math.min(1, Number(ratioEnter) || 0.70));
    this.ratioExit = Math.max(0, Math.min(this.ratioEnter, Number(ratioExit) || 0.40));
    this.exitRatio = Math.max(0.05, Math.min(0.99, Number(exitRatio) || 0.85));
    this.hotThreshold = this.toxicityThreshold * HOT_THRESHOLD_RATIO;
    this.windows = new Map();
  }

  recordTrade({ tokenId, side, size, timeMs = Date.now() } = {}) {
    if (!this.enabled) return false;
    const normalizedTokenId = String(tokenId ?? '').trim();
    const normalizedSide = normalizeTradeSide(side);
    const normalizedSize = finitePositive(size);
    if (!normalizedTokenId || !normalizedSide || normalizedSize == null) {
      return false;
    }

    const window = this._windowFor(normalizedTokenId);
    window.ticks.push({
      side: normalizedSide,
      size: normalizedSize,
      timeMs: normalizeTimeMs(timeMs),
    });
    this._evict(window, Date.now());
    return true;
  }

  snapshotFor(tokenId, nowMs = Date.now()) {
    if (!this.enabled) {
      return this._emptySnapshot();
    }

    const normalizedTokenId = String(tokenId ?? '').trim();
    if (!normalizedTokenId) {
      return this._emptySnapshot();
    }

    const window = this._windowFor(normalizedTokenId);
    this._evict(window, nowMs);

    let buyVolume = 0;
    let sellVolume = 0;
    for (const tick of window.ticks) {
      if (tick.side === 'BUY') buyVolume += tick.size;
      if (tick.side === 'SELL') sellVolume += tick.size;
    }

    const totalVolume = buyVolume + sellVolume;
    const ofiScore = buyVolume - sellVolume;
    const absOfi = Math.abs(ofiScore);
    const ratio = totalVolume > 0 ? absOfi / totalVolume : 0;
    const enterToxic = absOfi >= this.toxicityThreshold && ratio >= this.ratioEnter;
    const stayToxic = absOfi >= this.toxicityThreshold * this.exitRatio && ratio >= this.ratioExit;
    const enterHot = absOfi >= this.hotThreshold && ratio >= this.ratioEnter;
    const stayHot = absOfi >= this.hotThreshold * this.exitRatio && ratio >= this.ratioExit;

    if (window.state.isToxic) {
      window.state.isToxic = stayToxic;
    } else {
      window.state.isToxic = enterToxic;
    }

    if (window.state.isHot) {
      window.state.isHot = !window.state.isToxic && stayHot;
    } else {
      window.state.isHot = !window.state.isToxic && enterHot;
    }

    const saturated = window.state.isToxic
      && absOfi >= this.toxicityThreshold * SATURATION_SCORE_MULTIPLIER
      && ratio >= SATURATION_RATIO;

    return {
      buyVolume,
      sellVolume,
      totalVolume,
      ofiScore,
      absOfi,
      ratio,
      isHot: window.state.isHot,
      isToxic: window.state.isToxic,
      saturated,
      tradeCount: window.ticks.length,
      windowMs: this.windowMs,
      threshold: this.toxicityThreshold,
    };
  }

  decisionFor(tokenId, tickSize = DEFAULT_TICK_SIZE, nowMs = Date.now()) {
    const snapshot = this.snapshotFor(tokenId, nowMs);
    const normalizedTickSize = finitePositive(tickSize) ?? DEFAULT_TICK_SIZE;
    if (!this.enabled || snapshot.tradeCount === 0) {
      return {
        adjustTicks: 0,
        adjustPrice: 0,
        suppress: false,
        snapshot,
      };
    }
    if (snapshot.isToxic && snapshot.saturated) {
      return {
        adjustTicks: TOXIC_ADJUST_TICKS,
        adjustPrice: TOXIC_ADJUST_TICKS * normalizedTickSize,
        suppress: true,
        snapshot,
      };
    }
    if (snapshot.isToxic) {
      return {
        adjustTicks: TOXIC_ADJUST_TICKS,
        adjustPrice: TOXIC_ADJUST_TICKS * normalizedTickSize,
        suppress: false,
        snapshot,
      };
    }
    if (snapshot.isHot) {
      return {
        adjustTicks: HOT_ADJUST_TICKS,
        adjustPrice: HOT_ADJUST_TICKS * normalizedTickSize,
        suppress: false,
        snapshot,
      };
    }
    return {
      adjustTicks: 0,
      adjustPrice: 0,
      suppress: false,
      snapshot,
    };
  }

  _windowFor(tokenId) {
    if (!this.windows.has(tokenId)) {
      this.windows.set(tokenId, createEmptyWindow());
    }
    return this.windows.get(tokenId);
  }

  _evict(window, nowMs) {
    const cutoff = nowMs - this.windowMs;
    while (window.ticks.length && Number(window.ticks[0]?.timeMs ?? 0) < cutoff) {
      window.ticks.shift();
    }
  }

  _emptySnapshot() {
    return {
      buyVolume: 0,
      sellVolume: 0,
      totalVolume: 0,
      ofiScore: 0,
      absOfi: 0,
      ratio: 0,
      isHot: false,
      isToxic: false,
      saturated: false,
      tradeCount: 0,
      windowMs: this.windowMs,
      threshold: this.toxicityThreshold,
    };
  }
}
