/**
 * core/ids.ts — identifier + idempotency-key minting.
 * Invariant: newId() is collision-resistant (128 random bits, crypto RNG) and
 * idempotencyKey() is a pure function of its inputs' canonical JSON.
 * Callers: bus (envelope ids), agents (offers/holdings), adapters, ledger users.
 */

import { randomBytes } from 'node:crypto';
import { canonicalJson, sha256hex } from './hash.js';

// RFC 4648 base32 alphabet, no padding.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function newId(prefix: string): string {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('newId: prefix must be a non-empty string');
  }
  return `${prefix}_${base32(randomBytes(16))}`;
}

export function idempotencyKey(parts: unknown[]): string {
  return sha256hex(canonicalJson(parts)).slice(0, 32);
}
