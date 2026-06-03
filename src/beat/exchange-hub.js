/**
 * exchange-hub.js
 * ───────────────────────────────────────────────────────────────────────────
 * 다중 현물 거래소 실시간 데이터 허브.
 *
 * 목적: "근사-완벽" 확률 모델에 넣을 수 있도록 가능한 한 많은 시장 미시구조
 * 신호를 모은다. 거래소마다 아래 스트림을 구독한다.
 *   - trades       : 체결가/체결량/매수·매도 방향 → CVD(누적 거래량 델타)
 *   - bookTicker   : 최우선 매수/매도(BBO) 호가와 수량 → 스프레드/마이크로프라이스
 *   - depth        : 상위 호가 깊이 → 오더북 불균형(OBI)
 *
 * 거래소별 어댑터(ExchangeFeed)가 위 원시 메시지를 정규화 이벤트로 변환하고,
 * ExchangeHub 가 심볼 단위로 통합 스냅샷(consolidated view)을 만들어 준다.
 *
 * 통합 스냅샷 핵심 필드:
 *   consensusPrice   - 거래소별 미드가의 (거래량 가중) 합의 가격
 *   microprice       - 잔량 가중 마이크로프라이스(단기 압력 반영)
 *   obi              - [-1,1] 오더북 불균형(매수 우위 +, 매도 우위 -)
 *   cvdRatio         - [-1,1] 윈도우 내 (매수체결-매도체결)/총체결
 *   tradeVolumeUsd   - 윈도우 내 총 체결 명목 금액
 *   priceHistory()   - σ/모멘텀 추정용 합의 가격 시계열
 */
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import axios from 'axios';
import logger from '../logger.js';

const PING_INTERVAL_MS = 12_000;
// 무메시지(stall) 감시: 이 시간 동안 메시지가 전혀 안 오면 소켓이 "조용히 죽은" 것으로
// 보고 강제 재연결한다. WS 가 close/error 없이 half-open 으로 멈추는 경우(피드 정지)
// TCP 타임아웃(수십 초)까지 기다리지 않고 빠르게 복구하기 위함이다.
const STALL_TIMEOUT_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const DEPTH_BAND_BPS = 15; // 마이드 대비 ±0.15% 밴드 안의 깊이만 OBI 에 반영

function nowMs() {
  return Date.now();
}

function finitePos(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function baseSymbol(symbol) {
  return String(symbol ?? 'BTC').trim().toUpperCase();
}

/**
 * 거래소별 심볼/엔드포인트 매핑. 새 거래소는 여기에 추가하면 된다.
 */
function exchangeSpec(exchange, symbol) {
  const base = baseSymbol(symbol);
  const lower = base.toLowerCase();
  switch (exchange) {
    case 'binance':
      return {
        exchange,
        wsUrl: `wss://stream.binance.com:9443/stream?streams=${lower}usdt@trade/${lower}usdt@bookTicker/${lower}usdt@depth20@100ms`,
        restUrl: `https://api.binance.com/api/v3/ticker/price?symbol=${base}USDT`,
        pair: `${base}USDT`,
      };
    case 'okx':
      return {
        exchange,
        wsUrl: 'wss://ws.okx.com:8443/ws/v5/public',
        restUrl: `https://www.okx.com/api/v5/market/ticker?instId=${base}-USDT`,
        pair: `${base}-USDT`,
      };
    case 'bybit':
      return {
        exchange,
        wsUrl: 'wss://stream.bybit.com/v5/public/spot',
        restUrl: `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${base}USDT`,
        pair: `${base}USDT`,
      };
    case 'coinbase':
      return {
        exchange,
        wsUrl: 'wss://ws-feed.exchange.coinbase.com',
        restUrl: `https://api.exchange.coinbase.com/products/${base}-USD/ticker`,
        pair: `${base}-USD`,
      };
    default:
      return null;
  }
}

/**
 * 한 거래소·한 심볼의 실시간 피드. 정규화 이벤트를 emit 한다.
 *   'trade' { price, size, side, timeMs }
 *   'bbo'   { bidPrice, bidSize, askPrice, askSize, timeMs }
 *   'depth' { bids:[[p,s]...], asks:[[p,s]...], timeMs }
 */
export class ExchangeFeed extends EventEmitter {
  constructor({ exchange, symbol }) {
    super();
    const spec = exchangeSpec(exchange, symbol);
    if (!spec) throw new Error(`Unsupported exchange: ${exchange}`);
    this.exchange = exchange;
    this.symbol = baseSymbol(symbol);
    this.spec = spec;
    this._ws = null;
    this._closed = false;
    this._reconnectMs = 1_000;
    this._pingTimer = null;
    this._watchdogTimer = null;
    this._lastMsgAtMs = 0;
  }

  start() {
    this._closed = false;
    this._connect();
  }

  stop() {
    this._closed = true;
    this._stopPing();
    this._stopWatchdog();
    try {
      this._ws?.close();
    } catch {
      // ignore
    }
  }

  _connect() {
    if (this._closed) return;
    const ws = new WebSocket(this.spec.wsUrl);
    this._ws = ws;

    ws.on('open', () => {
      this._reconnectMs = 1_000;
      this._lastMsgAtMs = nowMs();
      this._subscribe();
      this._startPing();
      this._startWatchdog();
    });

    ws.on('message', (raw) => {
      this._lastMsgAtMs = nowMs();
      try {
        const text = raw.toString();
        if (text === 'ping' || text === 'pong') return;
        if (!(text.startsWith('{') || text.startsWith('['))) return;
        this._handle(JSON.parse(text));
      } catch (err) {
        logger.debug('ExchangeFeed: parse error', { exchange: this.exchange, err: err.message });
      }
    });

    ws.on('error', (err) => {
      logger.debug('ExchangeFeed: ws error', { exchange: this.exchange, err: err.message });
      this.emit('error', err);
    });

    ws.on('close', () => {
      this._stopPing();
      this._stopWatchdog();
      if (this._closed) return;
      const delay = this._reconnectMs;
      this._reconnectMs = Math.min(this._reconnectMs * 2, 30_000);
      setTimeout(() => this._connect(), delay);
    });
  }

  _subscribe() {
    const { exchange, spec } = this;
    if (exchange === 'okx') {
      this._send({
        op: 'subscribe',
        args: [
          { channel: 'trades', instId: spec.pair },
          { channel: 'bbo-tbt', instId: spec.pair },
          { channel: 'books5', instId: spec.pair },
        ],
      });
      return;
    }
    if (exchange === 'bybit') {
      this._send({
        op: 'subscribe',
        args: [
          `publicTrade.${spec.pair}`,
          `orderbook.1.${spec.pair}`,
        ],
      });
      return;
    }
    if (exchange === 'coinbase') {
      this._send({
        type: 'subscribe',
        product_ids: [spec.pair],
        channels: ['ticker', 'matches'],
      });
      return;
    }
    // binance 는 URL 의 combined stream 으로 이미 구독됨.
  }

  _send(obj) {
    try {
      this._ws?.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      try {
        if (this.exchange === 'okx' || this.exchange === 'bybit') {
          this._ws.send(this.exchange === 'okx' ? 'ping' : JSON.stringify({ op: 'ping' }));
        } else {
          this._ws.ping?.();
        }
      } catch {
        // ignore
      }
    }, PING_INTERVAL_MS);
    this._pingTimer.unref?.();
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  // 무메시지(stall) 감시기. 소켓이 close/error 없이 조용히 죽는 경우를 감지해
  // STALL_TIMEOUT_MS 초과 시 강제 terminate → close 이벤트 → 자동 재연결.
  // 예) 47초 피드 정지 사례: 기존엔 TCP 타임아웃까지 기다렸으나
  //     이제 15초 내 감지해 즉시 재연결한다.
  _startWatchdog() {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(() => {
      if (this._closed || !this._ws) return;
      if (this._ws.readyState !== WebSocket.OPEN) return;
      const silenceMs = nowMs() - this._lastMsgAtMs;
      if (silenceMs > STALL_TIMEOUT_MS) {
        logger.warn('ExchangeFeed: stall detected, force-reconnecting', {
          exchange: this.exchange, symbol: this.symbol, silenceMs: Math.round(silenceMs),
        });
        try { this._ws.terminate(); } catch { /* ignore */ }
        // terminate() 는 즉시 close 이벤트를 발생시켜 재연결 로직을 트리거한다.
      }
    }, WATCHDOG_INTERVAL_MS);
    this._watchdogTimer.unref?.();
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  _handle(msg) {
    switch (this.exchange) {
      case 'binance': return this._handleBinance(msg);
      case 'okx': return this._handleOkx(msg);
      case 'bybit': return this._handleBybit(msg);
      case 'coinbase': return this._handleCoinbase(msg);
      default: return undefined;
    }
  }

  // ── Binance ────────────────────────────────────────────────────────────────
  _handleBinance(msg) {
    const stream = String(msg?.stream ?? '');
    const data = msg?.data ?? msg;
    if (!data) return;
    if (stream.endsWith('@trade') || data.e === 'trade') {
      const price = finitePos(data.p);
      const size = finitePos(data.q);
      if (!price || !size) return;
      // m === true → 매수자가 maker → 공격적 SELL.
      const side = data.m ? 'SELL' : 'BUY';
      this.emit('trade', { price, size, side, timeMs: Number(data.T) || nowMs() });
      return;
    }
    if (stream.endsWith('@bookTicker') || (data.b !== undefined && data.a !== undefined && data.e === undefined)) {
      this._emitBbo(data.b, data.B, data.a, data.A, nowMs());
      return;
    }
    if (stream.includes('@depth')) {
      this._emitDepth(data.bids, data.asks, nowMs());
    }
  }

  // ── OKX ──────────────────────────────────────────────────────────────────────
  _handleOkx(msg) {
    const channel = msg?.arg?.channel;
    const rows = Array.isArray(msg?.data) ? msg.data : null;
    if (!channel || !rows) return;
    if (channel === 'trades') {
      for (const row of rows) {
        const price = finitePos(row.px);
        const size = finitePos(row.sz);
        if (!price || !size) continue;
        const side = String(row.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
        this.emit('trade', { price, size, side, timeMs: Number(row.ts) || nowMs() });
      }
      return;
    }
    if (channel === 'bbo-tbt') {
      const row = rows[0];
      const bid = row?.bids?.[0];
      const ask = row?.asks?.[0];
      this._emitBbo(bid?.[0], bid?.[1], ask?.[0], ask?.[1], Number(row?.ts) || nowMs());
      return;
    }
    if (channel === 'books5') {
      const row = rows[0];
      this._emitDepth(row?.bids, row?.asks, Number(row?.ts) || nowMs());
    }
  }

  // ── Bybit ─────────────────────────────────────────────────────────────────────
  _handleBybit(msg) {
    const topic = String(msg?.topic ?? '');
    if (topic.startsWith('publicTrade')) {
      const rows = Array.isArray(msg?.data) ? msg.data : [];
      for (const row of rows) {
        const price = finitePos(row.p);
        const size = finitePos(row.v);
        if (!price || !size) continue;
        const side = String(row.S ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
        this.emit('trade', { price, size, side, timeMs: Number(row.T) || nowMs() });
      }
      return;
    }
    if (topic.startsWith('orderbook')) {
      const data = msg?.data ?? {};
      this._emitDepth(data.b, data.a, Number(msg?.ts) || nowMs());
      return;
    }
    if (topic.startsWith('tickers')) {
      const data = msg?.data ?? {};
      this._emitBbo(data.bid1Price, data.bid1Size, data.ask1Price, data.ask1Size, Number(msg?.ts) || nowMs());
    }
  }

  // ── Coinbase ─────────────────────────────────────────────────────────────────
  _handleCoinbase(msg) {
    if (msg?.type === 'ticker') {
      this._emitBbo(msg.best_bid, msg.best_bid_size, msg.best_ask, msg.best_ask_size, Date.parse(msg.time) || nowMs());
      const price = finitePos(msg.price);
      if (price && msg.last_size) {
        const side = String(msg.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
        this.emit('trade', { price, size: finitePos(msg.last_size) ?? 0, side, timeMs: Date.parse(msg.time) || nowMs() });
      }
      return;
    }
    if (msg?.type === 'match' || msg?.type === 'last_match') {
      const price = finitePos(msg.price);
      const size = finitePos(msg.size);
      if (!price || !size) return;
      // maker side 가 'buy' 면 공격자는 SELL.
      const side = String(msg.side ?? '').toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
      this.emit('trade', { price, size, side, timeMs: Date.parse(msg.time) || nowMs() });
    }
  }

  _emitBbo(bidPrice, bidSize, askPrice, askSize, timeMs) {
    const bp = finitePos(bidPrice);
    const ap = finitePos(askPrice);
    if (!bp || !ap) return;
    this.emit('bbo', {
      bidPrice: bp,
      bidSize: finitePos(bidSize) ?? 0,
      askPrice: ap,
      askSize: finitePos(askSize) ?? 0,
      timeMs: timeMs || nowMs(),
    });
  }

  _emitDepth(rawBids, rawAsks, timeMs) {
    const toLevels = (rows) => (Array.isArray(rows) ? rows : [])
      .map((row) => [finitePos(row[0]), finitePos(row[1])])
      .filter(([p, s]) => p && s != null);
    const bids = toLevels(rawBids);
    const asks = toLevels(rawAsks);
    if (!bids.length && !asks.length) return;
    this.emit('depth', { bids, asks, timeMs: timeMs || nowMs() });
  }
}

/**
 * 한 심볼에 대한 여러 거래소 피드를 묶어 통합 시장 상태를 산출한다.
 */
export class ExchangeHub extends EventEmitter {
  constructor({
    symbol,
    exchanges = ['binance', 'okx', 'bybit', 'coinbase'],
    tradeWindowMs = 60_000,
    priceHistoryMs = 120_000,
    outlierBps = 25,
  } = {}) {
    super();
    this.symbol = baseSymbol(symbol);
    this.exchanges = exchanges.filter((ex) => exchangeSpec(ex, this.symbol));
    this.tradeWindowMs = Math.max(5_000, Number(tradeWindowMs) || 60_000);
    this.priceHistoryMs = Math.max(30_000, Number(priceHistoryMs) || 120_000);
    // 합의 가격 산출 시, 거래소별 미드가가 중앙값 대비 이 bps 이상 벗어나면
    // 이상치(stale/오류 호가)로 보고 제외한다. 0 이면 비활성.
    this.outlierBps = Math.max(0, Number(outlierBps) || 0);

    // 거래소별 최신 상태.
    this._state = new Map();
    // 윈도우 내 체결(방향성 CVD 용): { timeMs, side, notionalUsd }
    this._trades = [];
    // 합의 가격 시계열: { timeMs, price }
    this._priceHistory = [];
    this._feeds = [];
    this._lastConsensusPrice = null;
  }

  start() {
    for (const exchange of this.exchanges) {
      let feed;
      try {
        feed = new ExchangeFeed({ exchange, symbol: this.symbol });
      } catch (err) {
        logger.warn('ExchangeHub: feed init failed', { exchange, symbol: this.symbol, err: err.message });
        continue;
      }
      this._state.set(exchange, {
        bidPrice: null,
        bidSize: 0,
        askPrice: null,
        askSize: 0,
        bidDepth: 0,
        askDepth: 0,
        lastTradePrice: null,
        bboAtMs: 0,
        depthAtMs: 0,
        tradeAtMs: 0,
      });
      feed.on('trade', (t) => this._onTrade(exchange, t));
      feed.on('bbo', (b) => this._onBbo(exchange, b));
      feed.on('depth', (d) => this._onDepth(exchange, d));
      feed.on('error', () => {});
      feed.start();
      this._feeds.push(feed);
    }
    logger.info('ExchangeHub: started', { symbol: this.symbol, exchanges: this.exchanges });
  }

  stop() {
    for (const feed of this._feeds) feed.stop();
    this._feeds = [];
  }

  _onTrade(exchange, { price, size, side, timeMs }) {
    const recvMs = nowMs();
    const st = this._state.get(exchange);
    if (st) {
      st.lastTradePrice = price;
      st.tradeAtMs = recvMs;
    }
    this._trades.push({ timeMs: recvMs, side, notionalUsd: price * size });
    this._evictTrades(recvMs);
    this._recomputeConsensus(recvMs);
  }

  _onBbo(exchange, { bidPrice, bidSize, askPrice, askSize, timeMs }) {
    const recvMs = nowMs();
    const st = this._state.get(exchange);
    if (!st) return;
    st.bidPrice = bidPrice;
    st.bidSize = bidSize;
    st.askPrice = askPrice;
    st.askSize = askSize;
    st.bboAtMs = recvMs;
    this._recomputeConsensus(recvMs);
  }

  _onDepth(exchange, { bids, asks, timeMs }) {
    const recvMs = nowMs();
    const st = this._state.get(exchange);
    if (!st) return;

    // 최상위 호가는 곧 BBO. 전용 BBO 채널이 없는 거래소(bybit 등)나
    // BBO 가 끊긴 경우를 대비해 depth 최상단으로 BBO 를 갱신한다.
    const topBid = bids[0];
    const topAsk = asks[0];
    if (topBid && topAsk) {
      st.bidPrice = topBid[0];
      st.bidSize = topBid[1];
      st.askPrice = topAsk[0];
      st.askSize = topAsk[1];
      st.bboAtMs = recvMs;
    }

    const mid = st.bidPrice && st.askPrice
      ? (st.bidPrice + st.askPrice) / 2
      : (topBid?.[0] && topAsk?.[0] ? (topBid[0] + topAsk[0]) / 2 : null);
    if (!mid) {
      this._recomputeConsensus(recvMs);
      return;
    }
    const band = mid * (DEPTH_BAND_BPS / 10_000);
    const sumWithin = (levels, isBid) => levels.reduce((sum, [p, s]) => {
      if (isBid ? p >= mid - band : p <= mid + band) return sum + (p * s);
      return sum;
    }, 0);
    st.bidDepth = sumWithin(bids, true);
    st.askDepth = sumWithin(asks, false);
    st.depthAtMs = recvMs;
    this._recomputeConsensus(recvMs);
  }

  _evictTrades(ref = nowMs()) {
    const cutoff = ref - this.tradeWindowMs;
    while (this._trades.length && this._trades[0].timeMs < cutoff) {
      this._trades.shift();
    }
  }

  _evictPriceHistory(ref = nowMs()) {
    const cutoff = ref - this.priceHistoryMs;
    while (this._priceHistory.length && this._priceHistory[0].timeMs < cutoff) {
      this._priceHistory.shift();
    }
  }

  /**
   * refMs 기준으로 신선한(5s 이내) 거래소 상태 목록을 반환하되, 미드가가 중앙값
   * 대비 outlierBps 이상 벗어난 이상치 거래소를 제외한다.
   * 반환: [{ st, mid }]
   */
  _activeVenues(refMs) {
    const fresh = [];
    for (const st of this._state.values()) {
      if (!st.bidPrice || !st.askPrice) continue;
      if (refMs - st.bboAtMs > 5_000) continue;
      fresh.push({ st, mid: (st.bidPrice + st.askPrice) / 2 });
    }
    if (fresh.length <= 2 || this.outlierBps <= 0) return fresh;

    // 중앙값 기준 편차 필터(stale/오류 단일 호가 제거).
    const mids = fresh.map((v) => v.mid).sort((a, b) => a - b);
    const mid = mids.length % 2
      ? mids[(mids.length - 1) / 2]
      : (mids[mids.length / 2 - 1] + mids[mids.length / 2]) / 2;
    if (!(mid > 0)) return fresh;
    const tol = mid * (this.outlierBps / 10_000);
    const filtered = fresh.filter((v) => Math.abs(v.mid - mid) <= tol);
    // 모두 걸러지는 비정상 상황 방지: 최소 1개는 남긴다.
    return filtered.length ? filtered : fresh;
  }

  /**
   * 거래소별 미드가를 BBO 잔량 가중으로 합의 가격을 만들고 시계열에 기록한다.
   */
  _recomputeConsensus(refMs) {
    const t = refMs || nowMs();
    let weightedPrice = 0;
    let weight = 0;
    for (const { st, mid } of this._activeVenues(t)) {
      const w = Math.max(1e-9, st.bidSize + st.askSize);
      weightedPrice += mid * w;
      weight += w;
    }
    if (weight <= 0) return;
    const consensus = weightedPrice / weight;
    this._lastConsensusPrice = consensus;
    const last = this._priceHistory[this._priceHistory.length - 1];
    if (!last || t - last.timeMs >= 100) {
      this._priceHistory.push({ timeMs: t, price: consensus });
      this._evictPriceHistory(t);
    }
  }

  priceHistory() {
    return this._priceHistory.slice();
  }

  /**
   * 모델 입력용 통합 스냅샷.
   */
  snapshot(ref = nowMs()) {
    this._evictTrades(ref);

    // 1) 합의 가격 + 마이크로프라이스(잔량 가중).
    let midWeighted = 0;
    let midWeight = 0;
    let microWeighted = 0;
    let microWeight = 0;
    let obiNum = 0;
    let obiDen = 0;
    let bboCount = 0;
    let freshestBboAtMs = 0;
    let totalBidDepth = 0;
    let totalAskDepth = 0;

    for (const { st, mid } of this._activeVenues(ref)) {
      bboCount += 1;
      freshestBboAtMs = Math.max(freshestBboAtMs, st.bboAtMs);
      const w = Math.max(1e-9, st.bidSize + st.askSize);
      midWeighted += mid * w;
      midWeight += w;
      // 마이크로프라이스: (bid*askSize + ask*bidSize)/(bidSize+askSize)
      const denom = st.bidSize + st.askSize;
      if (denom > 0) {
        const micro = ((st.bidPrice * st.askSize) + (st.askPrice * st.bidSize)) / denom;
        microWeighted += micro * w;
        microWeight += w;
      }
      // OBI: 깊이가 있으면 깊이로, 없으면 BBO 잔량으로.
      const bidQ = st.bidDepth > 0 ? st.bidDepth : st.bidPrice * st.bidSize;
      const askQ = st.askDepth > 0 ? st.askDepth : st.askPrice * st.askSize;
      obiNum += bidQ - askQ;
      obiDen += bidQ + askQ;
      totalBidDepth += bidQ;
      totalAskDepth += askQ;
    }

    const consensusPrice = midWeight > 0 ? midWeighted / midWeight : this._lastConsensusPrice;
    const microprice = microWeight > 0 ? microWeighted / microWeight : consensusPrice;
    const obi = obiDen > 0 ? clamp(obiNum / obiDen, -1, 1) : 0;

    // 2) CVD(체결 흐름 불균형).
    let buyUsd = 0;
    let sellUsd = 0;
    for (const tr of this._trades) {
      if (tr.side === 'BUY') buyUsd += tr.notionalUsd;
      else sellUsd += tr.notionalUsd;
    }
    const tradeVolumeUsd = buyUsd + sellUsd;
    const cvdRatio = tradeVolumeUsd > 0 ? clamp((buyUsd - sellUsd) / tradeVolumeUsd, -1, 1) : 0;

    // 3) 마이크로프라이스가 미드 대비 어느 쪽으로 치우쳤는지(단기 압력).
    const micropriceBias = consensusPrice && microprice
      ? clamp(((microprice - consensusPrice) / consensusPrice) / (DEPTH_BAND_BPS / 10_000), -1, 1)
      : 0;

    return {
      symbol: this.symbol,
      timeMs: ref,
      consensusPrice: finitePos(consensusPrice),
      microprice: finitePos(microprice),
      micropriceBias,
      obi,
      cvdRatio,
      buyVolumeUsd: buyUsd,
      sellVolumeUsd: sellUsd,
      tradeVolumeUsd,
      totalBidDepthUsd: totalBidDepth,
      totalAskDepthUsd: totalAskDepth,
      exchangeCount: bboCount,
      bboAgeMs: freshestBboAtMs ? Math.max(0, ref - freshestBboAtMs) : Infinity,
    };
  }

  /**
   * 모든 WS 가 끊겼을 때를 대비한 REST 폴백(합의 가격 단발 조회).
   */
  async fetchRestConsensusPrice() {
    const prices = [];
    await Promise.all(this.exchanges.map(async (exchange) => {
      const spec = exchangeSpec(exchange, this.symbol);
      if (!spec) return;
      try {
        const res = await axios.get(spec.restUrl, { timeout: 4_000 });
        const p = parseRestPrice(exchange, res?.data);
        if (p) prices.push(p);
      } catch {
        // ignore individual exchange failure
      }
    }));
    if (!prices.length) return null;
    prices.sort((a, b) => a - b);
    const mid = prices[Math.floor(prices.length / 2)];
    return mid;
  }
}

function parseRestPrice(exchange, data) {
  try {
    if (exchange === 'binance') return finitePos(data?.price);
    if (exchange === 'okx') return finitePos(data?.data?.[0]?.last);
    if (exchange === 'bybit') return finitePos(data?.result?.list?.[0]?.lastPrice);
    if (exchange === 'coinbase') return finitePos(data?.price);
  } catch {
    return null;
  }
  return null;
}
