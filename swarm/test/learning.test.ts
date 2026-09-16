/**
 * test/learning.test.ts — attacks the learners: seeded determinism (no
 * Math.random anywhere), arm-set edge cases, serialisation fidelity including
 * n, LRU bounding of tracked SKUs, integer-Money output, and the two
 * behavioural claims (the bandit finds the better arm; the price learner
 * converges toward the multiplier that actually sells). Fixed seeds only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Bandit, PriceLearner, sampleBeta, sampleGamma, DEFAULT_PRICE_OPTS } from '../src/memory/learning.js';
import { makeRng } from '../src/core/rng.js';
import { money, type Money } from '../src/core/money.js';
import { AresError } from '../src/core/errors.js';

const ARMS = ['alpha', 'beta', 'gamma'];

function isAres(code: string) {
  return (err: unknown) => err instanceof AresError && err.code === code;
}

// ------------------------------------------------------------------ sampling

test('sampleBeta stays in [0,1] and tracks the posterior mean', () => {
  const rng = makeRng(11);
  let sum = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const v = sampleBeta(8, 2, rng);
    assert.ok(v >= 0 && v <= 1, `beta draw out of range: ${v}`);
    sum += v;
  }
  assert.ok(Math.abs(sum / n - 0.8) < 0.02, `mean ${sum / n} should be ~0.8`);
});

test('sampleGamma handles shape < 1 and rejects a bad shape', () => {
  const rng = makeRng(3);
  for (let i = 0; i < 200; i++) assert.ok(sampleGamma(0.4, rng) > 0);
  assert.throws(() => sampleGamma(0, rng), isAres('INVALID_SHAPE'));
  assert.throws(() => sampleGamma(Number.NaN, rng), isAres('INVALID_SHAPE'));
});

// -------------------------------------------------------------------- Bandit

test('Bandit starts from the prior and reports weights per arm', () => {
  const b = new Bandit(ARMS, makeRng(1));
  assert.deepEqual(b.armNames(), ARMS);
  const w = b.weights();
  assert.deepEqual(Object.keys(w), ARMS);
  assert.deepEqual(w['alpha'], { a: 1, b: 1, mean: 0.5, n: 0 });
  b.update('alpha', 1);
  b.update('alpha', 0);
  assert.deepEqual(b.weights()['alpha'], { a: 2, b: 2, mean: 0.5, n: 2 });
});

test('Bandit is deterministic for a given seed', () => {
  const mk = () => new Bandit(ARMS, makeRng(4242));
  const a = mk();
  const c = mk();
  const seqA: string[] = [];
  const seqC: string[] = [];
  const rewardRng = makeRng(7);
  const rewards: Array<0 | 1> = [];
  for (let i = 0; i < 50; i++) rewards.push(rewardRng.next() < 0.5 ? 1 : 0);
  for (let i = 0; i < 50; i++) {
    const pa = a.select();
    const pc = c.select();
    seqA.push(pa);
    seqC.push(pc);
    a.update(pa, rewards[i] as 0 | 1);
    c.update(pc, rewards[i] as 0 | 1);
  }
  assert.deepEqual(seqA, seqC, 'same seed must produce the same decision sequence');
  assert.deepEqual(a.weights(), c.weights());
  // A different seed must NOT produce the same sequence (the Rng is really used).
  const other = new Bandit(ARMS, makeRng(9));
  const seqO: string[] = [];
  for (let i = 0; i < 50; i++) {
    const p = other.select();
    seqO.push(p);
    other.update(p, rewards[i] as 0 | 1);
  }
  assert.notDeepEqual(seqA, seqO);
});

test('Bandit.update rejects an unknown arm and a non-binary reward', () => {
  const b = new Bandit(ARMS, makeRng(1));
  assert.throws(() => b.update('nope', 1), isAres('UNKNOWN_ARM'));
  // Justified casts: probing values the type system already forbids.
  assert.throws(() => b.update('alpha', 2 as unknown as 1), isAres('INVALID_REWARD'));
  assert.throws(() => b.update('alpha', 0.5 as unknown as 1), isAres('INVALID_REWARD'));
  assert.throws(() => b.update('alpha', true as unknown as 1), isAres('INVALID_REWARD'));
});

test('addArm never resets an existing posterior; removeArm guards the last arm', () => {
  const b = new Bandit(['a'], makeRng(2));
  b.update('a', 1);
  b.update('a', 1);
  const before = b.weights()['a'];
  b.addArm('a');
  assert.deepEqual(b.weights()['a'], before, 'adding an existing arm must be a no-op');

  b.addArm('b');
  assert.deepEqual(b.armNames(), ['a', 'b']);
  b.removeArm('a');
  assert.deepEqual(b.armNames(), ['b']);
  assert.throws(() => b.removeArm('b'), isAres('LAST_ARM'));
  assert.throws(() => b.removeArm('ghost'), isAres('UNKNOWN_ARM'));
  assert.throws(() => b.addArm(''), isAres('INVALID_ARM'));
});

test('select() on an empty arm set throws instead of returning undefined', () => {
  const b = new Bandit([], makeRng(1));
  assert.throws(() => b.select(), isAres('NO_ARMS'));
  b.addArm('only');
  assert.equal(b.select(), 'only');
});

test('Bandit rejects an invalid prior and a missing Rng', () => {
  assert.throws(() => new Bandit(ARMS, makeRng(1), { a: 0, b: 1 }), isAres('INVALID_PRIOR'));
  assert.throws(() => new Bandit(ARMS, makeRng(1), { a: 1, b: -2 }), isAres('INVALID_PRIOR'));
  // Justified cast: simulating a caller that forgot to inject the Rng.
  assert.throws(() => new Bandit(ARMS, undefined as unknown as ReturnType<typeof makeRng>), isAres('INVALID_RNG'));
});

test('toJSON/fromJSON round-trips exactly (including n) and keeps deciding the same way', () => {
  const live = new Bandit(ARMS, makeRng(5));
  const rewardRng = makeRng(77);
  for (let i = 0; i < 60; i++) {
    const arm = live.select();
    live.update(arm, rewardRng.next() < 0.3 ? 1 : 0);
  }
  const json = live.toJSON();
  assert.deepEqual(JSON.parse(JSON.stringify(json)), json, 'JSON-serialisable');

  const restored = Bandit.fromJSON(JSON.parse(JSON.stringify(json)), makeRng(31337));
  assert.deepEqual(restored.toJSON(), json, 'round-trip is exact');
  assert.deepEqual(restored.weights(), live.weights());
  for (const arm of ARMS) assert.equal(restored.weights()[arm]?.n, live.weights()[arm]?.n);

  // A process restart must continue the SAME decisions: build an equivalent
  // bandit by replaying the updates (update() consumes no randomness) and
  // check both produce an identical sequence from an identically seeded Rng.
  const twin = new Bandit(ARMS, makeRng(31337));
  for (const arm of ARMS) {
    const w = live.weights()[arm];
    assert.ok(w);
    for (let i = 0; i < w.a - 1; i++) twin.update(arm, 1);
    for (let i = 0; i < w.b - 1; i++) twin.update(arm, 0);
  }
  const fromRestored: string[] = [];
  const fromTwin: string[] = [];
  for (let i = 0; i < 30; i++) {
    fromRestored.push(restored.select());
    fromTwin.push(twin.select());
  }
  assert.deepEqual(fromRestored, fromTwin);

  assert.throws(() => Bandit.fromJSON(null, makeRng(1)), isAres('INVALID_BANDIT_JSON'));
  assert.throws(() => Bandit.fromJSON({ arms: { x: { a: 'no' } } }, makeRng(1)), isAres('INVALID_BANDIT_JSON'));
});

test('Bandit allocates the clear majority of recent pulls to the better arm', () => {
  const rates: Record<string, number> = { bad: 0.05, good: 0.6 };
  const b = new Bandit(['bad', 'good'], makeRng(20240915));
  const world = makeRng(99);
  const picks: string[] = [];
  for (let i = 0; i < 400; i++) {
    const arm = b.select();
    picks.push(arm);
    b.update(arm, world.next() < (rates[arm] as number) ? 1 : 0);
  }
  const recent = picks.slice(-100);
  const good = recent.filter((p) => p === 'good').length;
  assert.ok(good >= 80, `expected >=80/100 recent pulls on 'good', got ${good}`);
  const w = b.weights();
  assert.ok((w['good']?.mean ?? 0) > (w['bad']?.mean ?? 1), 'posterior mean orders the arms correctly');
  assert.ok((w['good']?.n ?? 0) > (w['bad']?.n ?? 0));
});

// -------------------------------------------------------------- PriceLearner

const BASE: Money = money(10_000, 'SAR'); // SAR 100.00 — every step lands on an integer.

test('the multiplier grid is exact and spans [min,max]', () => {
  const pl = new PriceLearner(makeRng(1));
  assert.equal(pl.min, DEFAULT_PRICE_OPTS.min);
  assert.equal(pl.max, DEFAULT_PRICE_OPTS.max);
  assert.deepEqual(
    [...pl.multipliers],
    [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4],
  );
  assert.throws(() => new PriceLearner(makeRng(1), { min: 0, max: 1, step: 0.1 }), isAres('INVALID_PRICE_OPTS'));
  assert.throws(() => new PriceLearner(makeRng(1), { min: 1.5, max: 1, step: 0.1 }), isAres('INVALID_PRICE_OPTS'));
  assert.throws(() => new PriceLearner(makeRng(1), { min: 0.5, max: 1, step: 0 }), isAres('INVALID_PRICE_OPTS'));
  assert.throws(
    () => new PriceLearner(makeRng(1), { min: 0.5, max: 1, step: 0.1, maxSkus: 0 }),
    isAres('INVALID_PRICE_OPTS'),
  );
});

test('suggest() on an unseen SKU returns a safe positive integer Money in the same currency', () => {
  const pl = new PriceLearner(makeRng(8));
  for (const sku of ['never-seen', 'other', 'x']) {
    const p = pl.suggest(sku, BASE);
    assert.equal(p.currency, BASE.currency);
    assert.ok(Number.isSafeInteger(p.amount), `amount must be an integer, got ${p.amount}`);
    assert.ok(p.amount > 0, 'never zero or negative');
    assert.ok(p.amount >= BASE.amount * pl.min - 1 && p.amount <= BASE.amount * pl.max + 1, `in range: ${p.amount}`);
  }
  // USD baselines keep their currency, and a 1-minor-unit baseline stays >= 1.
  const usd = pl.suggest('usd-sku', money(999, 'USD'));
  assert.equal(usd.currency, 'USD');
  assert.ok(usd.amount > 0);
  assert.ok(pl.suggest('tiny', money(1, 'SAR')).amount >= 1);
  assert.throws(() => pl.suggest('bad', money(0, 'SAR')), isAres('INVALID_BASELINE'));
  assert.throws(() => pl.suggest('bad', money(-5, 'SAR')), isAres('INVALID_BASELINE'));
  assert.throws(() => pl.suggest('', BASE), isAres('INVALID_SKU'));
});

test('observe() snaps the multiplier to the nearest step instead of creating new keys', () => {
  const pl = new PriceLearner(makeRng(2));
  assert.equal(pl.snap(0.83), 0.85);
  assert.equal(pl.snap(0.82), 0.8);
  assert.equal(pl.snap(99), 1.4, 'clamped to max');
  assert.equal(pl.snap(0.01), 0.7, 'clamped to min');

  pl.observe('sku-1', 0.834, true);
  pl.observe('sku-1', 7.5, false); // wildly out of range -> snaps to max
  pl.observe('sku-1', -3, false); // negative -> snaps to min
  const post = pl.posterior('sku-1');
  assert.ok(post);
  assert.equal(post.length, pl.multipliers.length, 'no unbounded key growth');
  const at = (m: number) => post.find((p) => p.multiplier === m);
  assert.deepEqual({ a: at(0.85)?.a, b: at(0.85)?.b, n: at(0.85)?.n }, { a: 2, b: 1, n: 1 });
  assert.equal(at(1.4)?.n, 1);
  assert.equal(at(0.7)?.n, 1);
  assert.equal(pl.size, 1);
  assert.equal(pl.posterior('never-touched'), null);
  assert.throws(() => pl.observe('sku-1', Number.NaN, true), isAres('INVALID_MULTIPLIER'));
  // Justified cast: probing a non-boolean `sold` that the types already forbid.
  assert.throws(() => pl.observe('sku-1', 1, 1 as unknown as boolean), isAres('INVALID_OBSERVATION'));
});

test('tracked SKUs are LRU-bounded so a 24/7 process cannot leak', () => {
  const pl = new PriceLearner(makeRng(3), { min: 0.7, max: 1.4, step: 0.05, maxSkus: 3 });
  for (const sku of ['a', 'b', 'c']) pl.observe(sku, 1, true);
  assert.deepEqual(pl.trackedSkus(), ['a', 'b', 'c']);

  pl.observe('a', 1, true); // 'a' becomes most-recently-used
  assert.deepEqual(pl.trackedSkus(), ['b', 'c', 'a']);

  pl.observe('d', 1, true); // evicts 'b', the least-recently-used
  assert.equal(pl.size, 3);
  assert.deepEqual(pl.trackedSkus(), ['c', 'a', 'd']);
  assert.equal(pl.posterior('b'), null, 'the LRU sku was evicted');
  assert.ok(pl.posterior('a'), 'the refreshed sku survived');

  for (let i = 0; i < 50; i++) pl.suggest(`sku-${i}`, BASE);
  assert.equal(pl.size, 3, 'suggest() is bounded too');
});

test('PriceLearner toJSON/fromJSON round-trips, preserving LRU order and counts', () => {
  const pl = new PriceLearner(makeRng(4), { min: 0.7, max: 1.4, step: 0.05, maxSkus: 10 });
  pl.observe('sku-a', 0.8, true);
  pl.observe('sku-a', 1.2, false);
  pl.observe('sku-b', 1.0, true);
  const json = pl.toJSON();
  assert.deepEqual(JSON.parse(JSON.stringify(json)), json);

  const back = PriceLearner.fromJSON(JSON.parse(JSON.stringify(json)), makeRng(4));
  assert.deepEqual(back.toJSON(), json);
  assert.deepEqual(back.trackedSkus(), ['sku-a', 'sku-b']);
  assert.deepEqual(back.posterior('sku-a'), pl.posterior('sku-a'));
  assert.equal(back.maxSkus, 10);

  // A restored learner with an identically seeded Rng decides identically.
  const twin = PriceLearner.fromJSON(json, makeRng(4));
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(back.suggest('sku-a', BASE), twin.suggest('sku-a', BASE));
  }

  assert.throws(() => PriceLearner.fromJSON(null, makeRng(1)), isAres('INVALID_PRICE_JSON'));
  assert.throws(() => PriceLearner.fromJSON({ skus: [{ sku: 'x' }] }, makeRng(1)), isAres('INVALID_PRICE_JSON'));
  assert.throws(
    () => PriceLearner.fromJSON({ min: 0.7, max: 1.4, step: 0.05, skus: [{ sku: 'x', steps: [{ a: 1, b: 1 }] }] }, makeRng(1)),
    isAres('INVALID_PRICE_JSON'),
  );
});

test('suggest() converges to the low end when only cheap prices ever sell', () => {
  const pl = new PriceLearner(makeRng(2468));
  const SKU = 'stubborn-sku';
  for (let i = 0; i < 400; i++) {
    const price = pl.suggest(SKU, BASE);
    const m = price.amount / BASE.amount;
    pl.observe(SKU, m, m <= 0.8 + 1e-9); // only <= 0.80 ever sells
  }
  const tail: number[] = [];
  for (let i = 0; i < 60; i++) tail.push(pl.suggest(SKU, BASE).amount / BASE.amount);
  const avg = tail.reduce((s, v) => s + v, 0) / tail.length;
  const cheap = tail.filter((m) => m <= 0.8 + 1e-9).length;
  assert.ok(avg <= 0.95, `mean suggested multiplier drifted high: ${avg}`);
  assert.ok(cheap >= 36, `expected >=36/60 suggestions at the selling end, got ${cheap}`);
});
