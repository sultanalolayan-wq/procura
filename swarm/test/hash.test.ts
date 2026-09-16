/**
 * test/hash.test.ts — canonical serialisation must be order-independent and
 * undefined-free, because the ledger hash chain and every idempotency key
 * depend on byte-for-byte determinism.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256hex } from '../src/core/hash.js';
import { idempotencyKey, newId, base32 } from '../src/core/ids.js';
import { AresError } from '../src/core/errors.js';

test('sha256hex matches the known vector for "abc"', () => {
  assert.equal(sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('canonicalJson sorts keys recursively and is insertion-order stable', () => {
  const a = { b: 1, a: { z: 1, y: [3, { q: 1, p: 2 }] } };
  const b: Record<string, unknown> = {};
  b['a'] = { y: [3, { p: 2, q: 1 }], z: 1 };
  b['b'] = 1;
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"y":[3,{"p":2,"q":1}],"z":1},"b":1}');
  // The whole point: equivalent objects hash identically.
  assert.equal(sha256hex(canonicalJson(a)), sha256hex(canonicalJson(b)));
});

test('canonicalJson drops undefined values but keeps nulls', () => {
  assert.equal(canonicalJson({ a: undefined, b: null, c: 1 }), '{"b":null,"c":1}');
  assert.equal(canonicalJson({ c: 1, b: null }), '{"b":null,"c":1}');
  // Array holes/undefined become null, matching JSON.stringify semantics.
  assert.equal(canonicalJson([1, undefined, 3]), '[1,null,3]');
});

test('canonicalJson normalises non-finite numbers and handles primitives', () => {
  assert.equal(canonicalJson(NaN), 'null');
  assert.equal(canonicalJson(Infinity), 'null');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson('x'), '"x"');
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson(-0), '0');
});

test('canonicalJson refuses cycles instead of recursing forever', () => {
  const o: Record<string, unknown> = { a: 1 };
  o['self'] = o;
  assert.throws(() => canonicalJson(o), (e: unknown) => e instanceof AresError && e.code === 'CANONICAL_JSON_CYCLE');
});

test('canonicalJson allows the same object twice in a non-cyclic graph', () => {
  const shared = { x: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
});

test('canonicalJson refuses bigint', () => {
  assert.throws(
    () => canonicalJson({ n: 1n }),
    (e: unknown) => e instanceof AresError && e.code === 'CANONICAL_JSON_BIGINT',
  );
});

test('idempotencyKey is 32 hex chars, pure and order-insensitive on object keys', () => {
  const k1 = idempotencyKey(['buy', { sku: 'A', qty: 2 }, 7]);
  const k2 = idempotencyKey(['buy', { qty: 2, sku: 'A' }, 7]);
  assert.equal(k1, k2);
  assert.equal(k1.length, 32);
  assert.match(k1, /^[0-9a-f]{32}$/);
  assert.notEqual(k1, idempotencyKey(['buy', { sku: 'A', qty: 3 }, 7]));
  // Array order still matters — it is part of the value.
  assert.notEqual(idempotencyKey([1, 2]), idempotencyKey([2, 1]));
});

test('newId is prefixed, base32 and unique', () => {
  const a = newId('msg');
  const b = newId('msg');
  assert.notEqual(a, b);
  assert.match(a, /^msg_[A-Z2-7]+$/);
  assert.equal(a.split('_')[1]?.length, 26); // 16 bytes -> ceil(128/5) = 26 chars
  assert.throws(() => newId(''), TypeError);
});

test('base32 encodes deterministically', () => {
  assert.equal(base32(new Uint8Array([0, 0, 0, 0, 0])), 'AAAAAAAA');
  assert.equal(base32(new Uint8Array([255, 255, 255, 255, 255])), '77777777');
});
