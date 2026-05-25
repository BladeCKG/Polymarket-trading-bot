import http from 'http';
import { readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import logger, { subscribeLogs } from '../logger.js';

const DASHBOARD_HTML = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const MAX_EVENTS = 150;
const MAX_LOGS = 250;

function truncatePush(list, value, max = MAX_EVENTS) {
  list.unshift(value);
  if (list.length > max) list.length = max;
}

export class ValueDashboardServer {
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
      markets: [],
      recentActions: [],
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
        res.end(DASHBOARD_HTML);
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
      const line = {
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        meta: Object.fromEntries(Object.entries(entry).filter(([key]) =>
          !['level', 'message', 'timestamp'].includes(key)
        )),
      };
      truncatePush(this.state.logs, line, MAX_LOGS);
      this.broadcast('log', line);
    });

    await new Promise((resolve, reject) => {
      this._server.once('error', reject);
      this._server.listen(this.port, this.host, () => {
        this._server.off('error', reject);
        resolve();
      });
    });

    const url = `http://${this.host}:${this.port}`;
    this.setRuntime({ dashboardUrl: url });
    logger.info('value.dashboard: started', { url });
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

  setMarkets(markets) {
    this.state.markets = markets;
    this.broadcast('markets', this.state.markets);
  }

  recordAction(action) {
    truncatePush(this.state.recentActions, action);
    this.broadcast('action', action);
  }

  broadcast(type, data) {
    if (!this._wss) return;
    const payload = JSON.stringify({ type, data });
    for (const client of this._wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }
}
