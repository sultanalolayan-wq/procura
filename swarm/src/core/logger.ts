/**
 * core/logger.ts — structured JSON-lines logging with mandatory redaction.
 * Invariant: any key matching /token|secret|key|password|authorization/i is
 * replaced by "[REDACTED]" recursively; the caller's object is NEVER mutated
 * and cycles are rendered as "[CIRCULAR]" instead of blowing the stack.
 * Callers: everything. `child()` adds permanent bindings (agentId, tick, ...).
 */

import { systemClock, type Clock } from './clock.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const LEVELS: readonly Level[] = ['debug', 'info', 'warn', 'error'];
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLevel(v: unknown): v is Level {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

export const REDACT_PATTERN = /token|secret|key|password|authorization/i;
export const REDACTED = '[REDACTED]';

/**
 * Deep copy with redaction. Pure: returns a new structure, leaves `value` alone.
 * Cycles resolve to "[CIRCULAR]"; Maps/Sets/Dates are flattened to plain data.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  const obj = value as object;
  if (seen.has(obj)) return '[CIRCULAR]';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((v) => redact(v, seen));
    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof Error) {
      return { name: obj.name, message: obj.message, ...redactPlain(obj as unknown as Record<string, unknown>, seen) };
    }
    if (obj instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of obj.entries()) {
        const key = String(k);
        out[key] = REDACT_PATTERN.test(key) ? REDACTED : redact(v, seen);
      }
      return out;
    }
    if (obj instanceof Set) return Array.from(obj.values()).map((v) => redact(v, seen));
    return redactPlain(obj as Record<string, unknown>, seen);
  } finally {
    seen.delete(obj);
  }
}

function redactPlain(rec: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec)) {
    out[k] = REDACT_PATTERN.test(k) ? REDACTED : redact(rec[k], seen);
  }
  return out;
}

export interface LoggerOptions {
  level?: Level;
  base?: Record<string, unknown>;
  /** Sink for a finished JSON line (no trailing newline). Defaults to stdout. */
  write?: (line: string) => void;
  clock?: Clock;
}

function defaultWrite(line: string): void {
  process.stdout.write(line + '\n');
}

class JsonLogger implements Logger {
  constructor(
    private readonly level: Level,
    private readonly base: Record<string, unknown>,
    private readonly write: (line: string) => void,
    private readonly clock: Clock,
  ) {}

  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger(this.level, { ...this.base, ...bindings }, this.write, this.clock);
  }

  private emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
    if (RANK[level] < RANK[this.level]) return;
    const record: Record<string, unknown> = {
      ts: this.clock.now(),
      level,
      msg,
      ...(redact(this.base) as Record<string, unknown>),
    };
    if (meta !== undefined) record['meta'] = redact(meta);
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: this.clock.now(), level, msg, meta: '[UNSERIALISABLE]' });
    }
    this.write(line);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.emit('debug', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.emit('info', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.emit('warn', msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.emit('error', msg, meta);
  }
}

/** Accepts either a bare Level ("info") or a full options object. */
export function createLogger(opts: Level | LoggerOptions = {}): Logger {
  const o: LoggerOptions = typeof opts === 'string' ? { level: opts } : opts;
  const level = isLevel(o.level) ? o.level : 'info';
  return new JsonLogger(level, o.base ?? {}, o.write ?? defaultWrite, o.clock ?? systemClock);
}

/** Swallows everything. Handy in tests and in shutdown paths. */
export const nullLogger: Logger = {
  child: () => nullLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
