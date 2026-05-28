/**
 * logger.js
 * Structured logger (winston). Every module imports this directly.
 * Fields: timestamp, level, market (if provided), message, ...meta
 */
import winston from 'winston';
import fs from 'node:fs';
import path from 'node:path';
import { LOG_LEVEL } from './config.js';

const { combine, timestamp, colorize, printf, json } = winston.format;
const logSubscribers = new Set();
const marketFileStreams = new Map();
const MARKET_LOG_DIR = path.join(process.cwd(), 'logs', 'beat-markets');

const consoleFormat = printf(({ level, message, timestamp: ts, market, ...meta }) => {
  const mkt = market ? ` [${market}]` : '';
  const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${ts} ${level}${mkt}: ${message}${extra}`;
});

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: combine(timestamp({ format: 'HH:mm:ss.SSS' }), json()),
  transports: [
    new winston.transports.Console({
      format: combine(timestamp({ format: 'HH:mm:ss.SSS' }), colorize(), consoleFormat),
    }),
    new winston.transports.File({
      filename: 'bot.log',
      format: combine(timestamp(), json()),
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

logger.on('data', (entry) => {
  for (const subscriber of logSubscribers) {
    try {
      subscriber(entry);
    } catch {
      // Ignore subscriber failures so logging never breaks the bot.
    }
  }
});

export default logger;

/**
 * Subscribe to structured log entries emitted by the shared logger.
 * Returns an unsubscribe function.
 */
export function subscribeLogs(listener) {
  logSubscribers.add(listener);
  return () => {
    logSubscribers.delete(listener);
  };
}

/**
 * Returns a child logger that automatically includes the market slug in every log line.
 */
export function marketLogger(slug) {
  return logger.child({ market: slug });
}

function ensureMarketLogDir() {
  fs.mkdirSync(MARKET_LOG_DIR, { recursive: true });
}

function sanitizeMarketLogName(slug) {
  const normalized = String(slug ?? 'unknown-market').trim() || 'unknown-market';
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export function getMarketLogFilePath(slug) {
  return path.join(MARKET_LOG_DIR, `${sanitizeMarketLogName(slug)}.jsonl`);
}

export function marketFileLogger(slug) {
  const key = String(slug ?? 'unknown-market');
  let stream = marketFileStreams.get(key);
  if (!stream) {
    ensureMarketLogDir();
    stream = fs.createWriteStream(getMarketLogFilePath(key), { flags: 'a' });
    marketFileStreams.set(key, stream);
  }

  return {
    path: getMarketLogFilePath(key),
    write(eventType, payload = {}) {
      const entry = {
        timestamp: new Date().toISOString(),
        market: key,
        eventType,
        ...payload,
      };
      try {
        stream.write(`${JSON.stringify(entry)}\n`);
      } catch {
        // Ignore file logging failures so audit logging never interrupts trading.
      }
    },
  };
}
