import { mkdirSync, createWriteStream } from 'fs';
import path from 'path';

function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

export class ValueTraceFile {
  constructor({
    filename = path.join('logs', 'value-trace.ndjson'),
    marketsDir = path.join('logs', 'value-markets'),
  } = {}) {
    this.filename = filename;
    this.marketsDir = marketsDir;
    this.stream = null;
    this.marketStreams = new Map();
  }

  start() {
    if (this.stream) return this.filename;
    mkdirSync(path.dirname(this.filename), { recursive: true });
    mkdirSync(this.marketsDir, { recursive: true });
    this.stream = createWriteStream(this.filename, { flags: 'a' });
    return this.filename;
  }

  write(type, payload) {
    if (!this.stream) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      payload: jsonSafe(payload),
    });
    this.stream.write(line + '\n');
  }

  writeMarket(slug, type, payload) {
    if (!this.stream || !slug) return;
    const stream = this._marketStream(slug);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      payload: jsonSafe(payload),
    });
    stream.write(line + '\n');
  }

  _marketStream(slug) {
    let stream = this.marketStreams.get(slug);
    if (stream) return stream;
    const filename = path.join(this.marketsDir, `${slug}.ndjson`);
    stream = createWriteStream(filename, { flags: 'a' });
    this.marketStreams.set(slug, stream);
    return stream;
  }

  stop() {
    if (this.stream) this.stream.end();
    for (const stream of this.marketStreams.values()) {
      stream.end();
    }
    this.marketStreams.clear();
    this.stream = null;
  }
}
