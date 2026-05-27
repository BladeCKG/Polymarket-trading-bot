import http from 'http';
import { readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import logger, { subscribeLogs } from '../logger.js';

const MAX_LOGS = 250;
const MAX_EVENTS = 100;
const DASHBOARD_HTML = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');

function truncatePush(list, value, max = MAX_EVENTS) {
  list.unshift(value);
  if (list.length > max) list.length = max;
}

function htmlPage() {
  return DASHBOARD_HTML;
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
      recentTrades: [],
      logs: [],
    };
    this._server = null;
    this._wss = null;
    this._unsubscribeLogs = null;
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
      socket.send(JSON.stringify({ type: 'snapshot', data: this.state }));
    });

    this._unsubscribeLogs = subscribeLogs((entry) => {
      const logLine = {
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        meta: Object.fromEntries(Object.entries(entry).filter(([key]) => !['level', 'message', 'timestamp'].includes(key))),
      };
      truncatePush(this.state.logs, logLine, MAX_LOGS);
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
    this.setRuntime({ dashboardUrl: url, startedAt: Date.now() });
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

  recordTrade(trade) {
    truncatePush(this.state.recentTrades, trade);
    this.broadcast('trade', trade);
  }

  broadcast(type, data) {
    if (!this._wss) return;
    const payload = JSON.stringify({ type, data });
    for (const client of this._wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }
}
