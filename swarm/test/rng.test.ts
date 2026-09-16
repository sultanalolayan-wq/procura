/**
 * test/rng.test.ts — determinism is the whole contract: a seed must reproduce a
 * run exactly, and every helper must stay inside its declared range.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../src/core/rng.js';

test('same seed produces the same stream; different seeds diverge', () => {
  const a = makeRng(1337);
  const b = makeRng(1337);
  const c = makeRng(1338);
  const sa: number[] = [];
  const sb: number[] = [];
  const sc: number[] = [];
  for (let i = 0; i < 64; i++) {
    sa.push(a.next());
    sb.push(b.next());
    sc.push(c.next());
  }
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
});

test('next() stays in [0,1)', () => {
  const r = makeRng(42);
  for (let i = 0; i < 20000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('next() is not degenerate (mean near 0.5, both halves visited)', () => {
  const r = makeRng(7);
  let sum = 0;
  let lo = 0;
  let hi = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const v = r.next();
    sum += v;
    if (v < 0.5) lo++;
    else hi++;
  }
  const mean = sum / n;
  assert.ok(Math.abs(mean - 0.5) < 0.02, `mean drifted: ${mean}`);
  assert.ok(lo > n * 0.4 && hi > n * 0.4, `unbalanced halves: ${lo}/${hi}`);
});

test('int() respects bounds and covers them', () => {
  const r = makeRng(9);
  const seen = new Set<number>();
  for (let i = 0; i < 5000; i++) {
    const v = r.int(5);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 5, `bad int ${v}`);
    seen.add(v);
  }
  assert.equal(seen.size, 5);
  assert.equal(makeRng(1).int(1), 0);
  assert.throws(() => r.int(0), RangeError);
  assert.throws(() => r.int(-3), RangeError);
  assert.throws(() => r.int(2.5), RangeError);
});

test('pick() returns members and throws on empty', () => {
  const r = makeRng(11);
  const arr = ['a', 'b', 'c'];
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(r.pick(arr));
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
  assert.throws(() => r.pick([]), RangeError);
});

test('gauss() is centred and scaled, and is deterministic per seed', () => {
  const r = makeRng(5);
  const n = 20000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = r.gauss(10, 2);
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  assert.ok(Math.abs(mean - 10) < 0.15, `mean ${mean}`);
  assert.ok(Math.abs(Math.sqrt(variance) - 2) < 0.15, `sd ${Math.sqrt(variance)}`);

  const g1 = makeRng(3);
  const g2 = makeRng(3);
  assert.equal(g1.gauss(0, 1), g2.gauss(0, 1));
  assert.equal(g1.gauss(0, 1), g2.gauss(0, 1)); // exercises the cached spare value
});

test('makeRng rejects a non-finite seed', () => {
  assert.throws(() => makeRng(NaN), RangeError);
});
