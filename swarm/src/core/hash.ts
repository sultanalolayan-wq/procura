/**
 * core/hash.ts — deterministic serialisation + hashing primitives.
 * Invariant: canonicalJson(x) is byte-identical for structurally equal values
 * regardless of key insertion order, and never emits `undefined`.
 * Callers: ledger (hash chain), ids (idempotency), bus (loop guard), memory.
 */

import { createHash } from 'node:crypto';
import { AresError } from './errors.js';

/**
 * Deterministic JSON: object keys sorted, undefined-valued keys dropped,
 * undefined/function array slots become null, non-finite numbers become null.
 * Throws on cycles rather than silently producing a bogus digest.
 */
export function canonicalJson(v: unknown): string {
  const seen = new Set<object>();
  return enc(v, seen);
}

function enc(v: unknown, seen: Set<object>): string {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v as number) ? JSON.stringify(v) : 'null';
  if (t === 'string') return JSON.stringify(v);
  if (t === 'boolean') return (v as boolean) ? 'true' : 'false';
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
  if (t === 'bigint') {
    throw new AresError('CANONICAL_JSON_BIGINT', 'canonicalJson: bigint is not serialisable');
  }

  const o = v as object;
  if (seen.has(o)) {
    throw new AresError('CANONICAL_JSON_CYCLE', 'canonicalJson: circular structure');
  }
  seen.add(o);
  try {
    if (Array.isArray(o)) {
      const parts: string[] = [];
      for (const item of o) parts.push(enc(item, seen));
      return `[${parts.join(',')}]`;
    }
    if (o instanceof Date) return JSON.stringify(o.toISOString());
    // `toJSON` support (errors, custom value objects) before generic object walk.
    const maybe = o as { toJSON?: () => unknown };
    if (typeof maybe.toJSON === 'function') {
      seen.delete(o);
      return enc(maybe.toJSON(), seen);
    }
    const rec = o as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const val = rec[k];
      if (val === undefined) continue; // drop undefined values entirely
      parts.push(`${JSON.stringify(k)}:${enc(val, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(o);
  }
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
