import http from 'http';
import { readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import logger, { subscribeLogs } from '../logger.js';

const MAX_LOGS = 250;
const MAX_GRAPH_SECONDS = 300;
const DASHBOARD_HTML = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');

function htmlPage() {
  return DASHBOARD_HTML;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function truncate(list, max) {
  if (list.length > max) list.length = max;
}

function finiteNumberOrNull(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function appendSeriesPoint(series, second, value) {
  if (!Number.isFinite(second) || second < 0 || second > MAX_GRAPH_SECONDS) return Array.isArray(series) ? series : [];
  const isGap = value == null;
  if (!isGap && !Number.isFinite(value)) return Array.isArray(series) ? series : [];

  const next = Array.isArray(series) ? [...series] : [];
  const point = { second, value: isGap ? null : value };
  const existingIndex = next.findIndex((entry) => Number(entry?.second) === second);
  if (existingIndex >= 0) {
    next[existingIndex] = point;
  } else {
    next.push(point);
  }

  return next
    .filter((entry) => Number.isFinite(Number(entry?.second)))
    .sort((a, b) => Number(a.second) - Number(b.second));
}

export class BeatDashboardServer {
  constructor({ host, port, runtime, config, onConfigUpdate = null }) {
    this.host = host;
    this.port = port;
    this._onConfigUpdate = onConfigUpdate;
    this.state = {
      runtime: {
        ...runtime,
        connected: false,
      },
      config,
      stats: {},
      learning: null,
      logs: [],
      prices: {},
      markets: [],
    };
    this._server = null;
    this._wss = null;
    this._unsubscribeLogs = null;
    this._marketIndex = new Map();
  }

  async start() {
    this._server = http.createServer((req, res) => {
      if (req.url === '/' || req.url?.startsWith('/?')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlPage());
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    });

    this._wss = new WebSocketServer({ server: this._server, path: '/ws' });
    this._wss.on('connection', (socket) => {
      this.state.runtime.connected = true;
      socket.send(JSON.stringify({ type: 'snapshot', data: clone(this.state) }));
      socket.on('message', (raw) => {
        this._handleMessage(socket, raw);
      });
    });

    this._unsubscribeLogs = subscribeLogs((entry) => {
      const logLine = {
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        meta: Object.fromEntries(
          Object.entries(entry).filter(([key]) => !['level', 'message', 'timestamp'].includes(key)),
        ),
      };
      this.state.logs.unshift(logLine);
      truncate(this.state.logs, MAX_LOGS);
      this.broadcast('log', logLine);
    });

    await new Promise((resolve, reject) => {
      this._server.once('error', reject);
      this._server.listen(this.port, this.host, () => {
        this._server.off('error', reject);
        resolve();
      });
    });

    const url = `http://${this.host}:${this.port}`;
    this.setRuntime({ dashboardUrl: url, startedAt: Date.now(), connected: true });
    logger.info('beat.dashboard: started', { url });
    return url;
  }

  stop() {
    this._unsubscribeLogs?.();
    this._wss?.clients.forEach((client) => client.close());
    this._wss?.close();
    this._server?.close();
  }

  setRuntime(runtime) {
    this.state.runtime = { ...this.state.runtime, ...runtime };
    this.broadcast('runtime', this.state.runtime);
  }

  setStats(stats) {
    this.state.stats = { ...stats };
    this.broadcast('stats', this.state.stats);
  }

  setLearning(info) {
    this.state.learning = { ...info };
    this.broadcast('learning', this.state.learning);
  }

  setConfig(config) {
    this.state.config = config;
    this.broadcast('config', this.state.config);
  }

  recordPrice(tick) {
    if (tick && typeof tick === 'object') {
      const symbol = String(tick.symbol ?? 'BTC').toUpperCase();
      const source = String(tick.source ?? 'rtds').toLowerCase();
      const next = {
        symbol,
        source,
        price: Number.isFinite(Number(tick.price)) ? Number(tick.price) : null,
        bestBid: Number.isFinite(Number(tick.bestBid)) ? Number(tick.bestBid) : null,
        bestAsk: Number.isFinite(Number(tick.bestAsk)) ? Number(tick.bestAsk) : null,
        updatedAt: Number.isFinite(Number(tick.timeMs))
          ? Number(tick.timeMs)
          : (typeof tick.isoTime === 'string' ? Date.parse(tick.isoTime) : Date.now()),
        isoTime: typeof tick.isoTime === 'string'
          ? tick.isoTime
          : new Date(
            Number.isFinite(Number(tick.timeMs))
              ? Number(tick.timeMs)
              : Date.now(),
          ).toISOString(),
      };
      if (!this.state.prices[symbol]) {
        this.state.prices[symbol] = {};
      }
      this.state.prices[symbol][source] = next;
      this.broadcast('price', next);
      return;
    }
    const symbol = 'BTC';
    const source = 'default';
    const next = {
      symbol,
      source,
      price: Number.isFinite(Number(tick)) ? Number(tick) : null,
      bestBid: null,
      bestAsk: null,
      updatedAt: Date.now(),
      isoTime: new Date().toISOString(),
    };
    if (!this.state.prices[symbol]) {
      this.state.prices[symbol] = {};
    }
    this.state.prices[symbol][source] = next;
    this.broadcast('price', next);
  }

  recordMarket(patch) {
    if (!patch?.slug) return;
    const slug = String(patch.slug);
    const existing = this._marketIndex.get(slug) ?? { slug };
    const updatedAt = patch.updatedAt ?? Date.now();
    const next = {
      ...existing,
      ...clone(patch),
      slug,
      updatedAt,
    };
    const chartHistory = {
      move: Array.isArray(existing.chartHistory?.move) ? [...existing.chartHistory.move] : [],
      upAsk: Array.isArray(existing.chartHistory?.upAsk) ? [...existing.chartHistory.upAsk] : [],
      downAsk: Array.isArray(existing.chartHistory?.downAsk) ? [...existing.chartHistory.downAsk] : [],
    };
    const chartPoint = patch?.chartPoint && typeof patch.chartPoint === 'object'
      ? patch.chartPoint
      : null;
    const second = finiteNumberOrNull(chartPoint?.second);
    const move = finiteNumberOrNull(chartPoint?.move);
    const upAsk = finiteNumberOrNull(chartPoint?.upAsk);
    const downAsk = finiteNumberOrNull(chartPoint?.downAsk);

    if (Number.isFinite(second)) {
      if (Number.isFinite(move)) {
        chartHistory.move = appendSeriesPoint(chartHistory.move, second, move);
      }
      if (Number.isFinite(upAsk)) {
        chartHistory.upAsk = appendSeriesPoint(chartHistory.upAsk, second, upAsk);
      } else if (upAsk == null) {
        chartHistory.upAsk = appendSeriesPoint(chartHistory.upAsk, second, null);
      }
      if (Number.isFinite(downAsk)) {
        chartHistory.downAsk = appendSeriesPoint(chartHistory.downAsk, second, downAsk);
      } else if (downAsk == null) {
        chartHistory.downAsk = appendSeriesPoint(chartHistory.downAsk, second, null);
      }
    }

    next.chartHistory = chartHistory;

    this._marketIndex.set(slug, next);
    this.state.markets = [...this._marketIndex.values()]
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));

    if (next.btcPrice != null && Number.isFinite(Number(next.btcPrice))) {
      this.state.btcPrice = Number(next.btcPrice);
      this.state.btcUpdatedAt = next.updatedAt;
    }

    this.broadcast('market', next);
  }

  _handleMessage(socket, raw) {
    let payload = null;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      socket.send(JSON.stringify({ type: 'error', data: { message: 'Invalid JSON message' } }));
      return;
    }

    if (payload?.type === 'config:update') {
      if (typeof this._onConfigUpdate !== 'function') {
        socket.send(JSON.stringify({ type: 'error', data: { message: 'Config updates are disabled' } }));
        return;
      }

      try {
        const next = this._onConfigUpdate(payload.data ?? {});
        if (next && typeof next === 'object') {
          this.setConfig(next);
        } else {
          this.broadcast('config', this.state.config);
        }
        socket.send(JSON.stringify({ type: 'config:ack', data: { ok: true } }));
      } catch (err) {
        socket.send(JSON.stringify({ type: 'error', data: { message: err.message || 'Failed to apply config update' } }));
      }
    }
  }

  broadcast(type, data) {
    if (!this._wss) return;
    const payload = JSON.stringify({ type, data: clone(data) });
    for (const client of this._wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }
}
