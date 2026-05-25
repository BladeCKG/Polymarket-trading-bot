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
  constructor({ filename = path.join('logs', 'value-trace.ndjson') } = {}) {
    this.filename = filename;
    this.stream = null;
  }

  start() {
    if (this.stream) return this.filename;
    mkdirSync(path.dirname(this.filename), { recursive: true });
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

  stop() {
    if (!this.stream) return;
    this.stream.end();
    this.stream = null;
  }
}
