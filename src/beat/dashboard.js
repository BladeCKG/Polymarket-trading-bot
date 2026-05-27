import http from 'http';
import { readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import logger, { subscribeLogs } from '../logger.js';

const MAX_LOGS = 250;
const MAX_MARKETS = 80;
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

export class BeatDashboardServer {
  constructor({ host, port, runtime, config }) {
    this.host = host;
    this.port = port;
    this.state = {
      runtime: {
        ...runtime,
        connected: false,
      },
      config,
      stats: {},
      logs: [],
      btcPrice: null,
      btcBestBid: null,
      btcBestAsk: null,
      btcUpdatedAt: null,
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

  recordPrice(tick) {
    if (tick && typeof tick === 'object') {
      if (tick.price != null && Number.isFinite(Number(tick.price))) {
        this.state.btcPrice = Number(tick.price);
      }
      if (tick.bestBid != null && Number.isFinite(Number(tick.bestBid))) {
        this.state.btcBestBid = Number(tick.bestBid);
      }
      if (tick.bestAsk != null && Number.isFinite(Number(tick.bestAsk))) {
        this.state.btcBestAsk = Number(tick.bestAsk);
      }
      this.state.btcUpdatedAt = tick.timeMs ?? Date.now();
      this.broadcast('price', tick);
      return;
    }
    if (tick != null && Number.isFinite(Number(tick))) {
      this.state.btcPrice = Number(tick);
    }
    this.state.btcUpdatedAt = Date.now();
    this.broadcast('price', { price: tick });
  }

  recordMarket(patch) {
    if (!patch?.slug) return;
    const slug = String(patch.slug);
    const existing = this._marketIndex.get(slug) ?? { slug };
    const next = {
      ...existing,
      ...clone(patch),
      slug,
      updatedAt: patch.updatedAt ?? Date.now(),
    };

    this._marketIndex.set(slug, next);
    this.state.markets = [...this._marketIndex.values()]
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
      .slice(0, MAX_MARKETS);

    if (next.btcPrice != null && Number.isFinite(Number(next.btcPrice))) {
      this.state.btcPrice = Number(next.btcPrice);
      this.state.btcUpdatedAt = next.updatedAt;
    }

    this.broadcast('market', next);
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
