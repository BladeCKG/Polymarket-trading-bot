/**
 * polymarket-feed.js
 * ───────────────────────────────────────────────────────────────────────────
 * Polymarket Up/Down 마켓에서 얻을 수 있는 모든 실시간 신호를 모은다.
 *
 * 내부적으로 clob.js 의 BookFeed(WS + REST 폴백)를 사용해 두 토큰(Up/Down)의
 *   - 전체 오더북(bids/asks)
 *   - 최우선 매수/매도(BBO), 미드
 *   - 최근 체결(trade) → 토큰별 체결 흐름 OFI
 * 를 추적하고, 마켓 내재확률(implied prob)도 계산한다.
 *
 * 내재확률 계산:
 *   Up/Down 미드가는 각각 해당 결과의 시장가 확률에 해당한다. 합이 1 에서
 *   벗어나므로(스프레드/수수료) 정규화한다.
 *     impliedUp = midUp / (midUp + midDown)
 */
import { BookFeed } from '../clob.js';
import { BeatOfiTracker } from './ofi.js';

function bestBid(book) {
  return Array.isArray(book?.bids) && book.bids.length ? book.bids[0] : null;
}

function bestAsk(book) {
  return Array.isArray(book?.asks) && book.asks.length ? book.asks[0] : null;
}

function midOf(book) {
  const b = bestBid(book);
  const a = bestAsk(book);
  if (b && a) return (b.price + a.price) / 2;
  if (a) return a.price;
  if (b) return b.price;
  return null;
}

function depthUsd(levels) {
  return (Array.isArray(levels) ? levels : []).reduce((sum, l) => sum + (Number(l.price) * Number(l.size)), 0);
}

export class PolymarketMarketFeed {
  constructor({ upTokenId, downTokenId, ofiConfig = {} } = {}) {
    this.upTokenId = String(upTokenId);
    this.downTokenId = String(downTokenId);
    this._books = new Map();
    this._bookAtMs = new Map();
    this._feed = new BookFeed([this.upTokenId, this.downTokenId]);
    this._started = false;

    this.ofi = new BeatOfiTracker({
      enabled: ofiConfig.enabled ?? true,
      windowMs: ofiConfig.windowMs ?? 3_000,
      toxicityThreshold: ofiConfig.toxicityThreshold ?? 200,
      ratioEnter: ofiConfig.ratioEnter ?? 0.70,
      ratioExit: ofiConfig.ratioExit ?? 0.40,
      exitRatio: ofiConfig.exitRatio ?? 0.85,
    });

    this._feed.on('update', ({ tokenId, book }) => {
      this._books.set(String(tokenId), book);
      this._bookAtMs.set(String(tokenId), Date.now());
    });
    this._feed.on('trade', (trade) => {
      this.ofi.recordTrade(trade);
    });
    this._feed.on('error', () => {});
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._feed.start();
  }

  stop() {
    this._feed.stop();
    this._started = false;
  }

  bookFor(side) {
    return this._books.get(side === 'Up' ? this.upTokenId : this.downTokenId) ?? null;
  }

  /**
   * 두 토큰의 통합 마켓 스냅샷.
   */
  snapshot(ref = Date.now()) {
    const upBook = this._books.get(this.upTokenId) ?? null;
    const downBook = this._books.get(this.downTokenId) ?? null;
    const upAsk = bestAsk(upBook);
    const upBid = bestBid(upBook);
    const downAsk = bestAsk(downBook);
    const downBid = bestBid(downBook);
    const midUp = midOf(upBook);
    const midDown = midOf(downBook);

    let impliedUp = null;
    if (Number.isFinite(midUp) && Number.isFinite(midDown) && (midUp + midDown) > 0) {
      impliedUp = midUp / (midUp + midDown);
    } else if (Number.isFinite(midUp)) {
      impliedUp = midUp;
    } else if (Number.isFinite(midDown)) {
      impliedUp = 1 - midDown;
    }

    const upOfi = this.ofi.snapshotFor(this.upTokenId, ref);
    const downOfi = this.ofi.snapshotFor(this.downTokenId, ref);

    return {
      timeMs: ref,
      up: {
        book: upBook,
        bestBid: upBid?.price ?? null,
        bestBidSize: upBid?.size ?? null,
        bestAsk: upAsk?.price ?? null,
        bestAskSize: upAsk?.size ?? null,
        mid: midUp,
        bidDepthUsd: depthUsd(upBook?.bids),
        askDepthUsd: depthUsd(upBook?.asks),
        ofi: upOfi,
        ageMs: this._bookAtMs.has(this.upTokenId) ? ref - this._bookAtMs.get(this.upTokenId) : Infinity,
      },
      down: {
        book: downBook,
        bestBid: downBid?.price ?? null,
        bestBidSize: downBid?.size ?? null,
        bestAsk: downAsk?.price ?? null,
        bestAskSize: downAsk?.size ?? null,
        mid: midDown,
        bidDepthUsd: depthUsd(downBook?.bids),
        askDepthUsd: depthUsd(downBook?.asks),
        ofi: downOfi,
        ageMs: this._bookAtMs.has(this.downTokenId) ? ref - this._bookAtMs.get(this.downTokenId) : Infinity,
      },
      impliedUp,
      pairAskCost: (Number.isFinite(upAsk?.price) && Number.isFinite(downAsk?.price))
        ? upAsk.price + downAsk.price
        : null,
    };
  }
}
