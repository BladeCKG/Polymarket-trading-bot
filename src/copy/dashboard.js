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

export class CopyDashboardServer {
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
      recentCopies: [],
      recentSkips: [],
      recentFailures: [],
      dryRun: { stats: {}, markets: [], recorded: [], settled: [] },
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
        meta: Object.fromEntries(Object.entries(entry).filter(([key]) =>
          !['level', 'message', 'timestamp'].includes(key)
        )),
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
    logger.info('copy.dashboard: started', { url });
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

  setConfig(config) {
    this.state.config = config;
    this.broadcast('config', this.state.config);
  }

  setDryRunSnapshot(snapshot) {
    this.state.dryRun = {
      ...snapshot,
      recorded: this.state.dryRun.recorded,
      settled: this.state.dryRun.settled,
    };
    this.broadcast('dryRunSnapshot', this.state.dryRun);
  }

  recordTrade(trade) {
    truncatePush(this.state.recentTrades, trade);
    this.broadcast('trade', trade);
  }

  recordCopy(copy) {
    truncatePush(this.state.recentCopies, copy);
    this.broadcast('copy', copy);
  }

  recordSkip(skip) {
    truncatePush(this.state.recentSkips, skip);
    this.broadcast('skip', skip);
  }

  recordFailure(failure) {
    truncatePush(this.state.recentFailures, failure);
    this.broadcast('failure', failure);
  }

  recordDryRunRecorded(event) {
    truncatePush(this.state.dryRun.recorded, event);
    this.broadcast('dryRunRecorded', event);
  }

  recordDryRunSettled(event) {
    truncatePush(this.state.dryRun.settled, event);
    this.broadcast('dryRunSettled', event);
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
