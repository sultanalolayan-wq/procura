/**
 * test/clock.test.ts — the deterministic clock is what makes the whole swarm
 * testable: sleep() must only settle when advance() moves virtual time past the
 * deadline, and time must never run backwards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TestClock, systemClock } from '../src/core/clock.js';

test('now() starts where it was constructed and only moves on advance()', () => {
  const c = new TestClock(500);
  assert.equal(c.now(), 500);
  c.advance(250);
  assert.equal(c.now(), 750);
  c.setTime(1000);
  assert.equal(c.now(), 1000);
});

test('sleep() does NOT settle on its own — advance() releases it', async () => {
  const c = new TestClock(0);
  let settled = false;
  const p = c.sleep(100).then(() => {
    settled = true;
  });

  // Give the microtask queue several turns; without advance() nothing resolves.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(c.pending, 1);

  c.advance(99);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(settled, false, 'released before its deadline');

  c.advance(1);
  await p;
  assert.equal(settled, true);
  assert.equal(c.pending, 0);
});

test('advance() releases every due waiter, in one step, and keeps the rest parked', async () => {
  const c = new TestClock(0);
  const done: number[] = [];
  const ps = [10, 20, 30, 40].map((ms) => c.sleep(ms).then(() => done.push(ms)));
  assert.equal(c.pending, 4);

  c.advance(25);
  await Promise.all([ps[0], ps[1]]);
  assert.deepEqual(done, [10, 20]);
  assert.equal(c.pending, 2);

  c.advance(100);
  await Promise.all(ps);
  assert.deepEqual(done, [10, 20, 30, 40]);
  assert.equal(c.pending, 0);
});

test('sleep(0) and negative sleeps resolve immediately', async () => {
  const c = new TestClock(0);
  await c.sleep(0);
  await c.sleep(-5);
  await c.sleep(NaN);
  assert.equal(c.pending, 0);
});

test('time cannot run backwards, and advance() rejects nonsense', () => {
  const c = new TestClock(100);
  assert.throws(() => c.setTime(99), RangeError);
  assert.throws(() => c.advance(-1), RangeError);
  assert.throws(() => c.advance(NaN), RangeError);
  assert.equal(c.now(), 100);
});

test('releaseAll() unparks everything regardless of deadline', async () => {
  const c = new TestClock(0);
  let n = 0;
  const p = Promise.all([c.sleep(1_000_000), c.sleep(5)]).then(() => {
    n++;
  });
  c.releaseAll();
  await p;
  assert.equal(n, 1);
  assert.equal(c.now(), 0, 'releaseAll must not move the clock');
});

test('systemClock reports real time and sleeps for real', async () => {
  const before = systemClock.now();
  assert.ok(before > 1_600_000_000_000, 'systemClock.now() should be a wall-clock epoch ms');
  const t0 = systemClock.now();
  await systemClock.sleep(5);
  assert.ok(systemClock.now() - t0 >= 4);
});
