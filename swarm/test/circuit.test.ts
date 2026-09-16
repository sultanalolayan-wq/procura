/**
 * test/circuit.test.ts — state machine + concurrency cap of the breaker, and
 * the token bucket's continuous refill. Everything runs on a TestClock: an
 * open circuit must never be reopened by a real timer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, RateLimiter } from '../src/governance/circuit.js';
import { TestClock } from '../src/core/clock.js';
import { nullLogger } from '../src/core/logger.js';
import { AdapterError, AresError } from '../src/core/errors.js';

const OPTS = { failureThreshold: 3, cooldownMs: 10_000, halfOpenMax: 1 };

function breaker(clock: TestClock, over: Partial<typeof OPTS> = {}): CircuitBreaker {
  return new CircuitBreaker('sim', { ...OPTS, ...over }, clock, nullLogger);
}

const boom = (): Promise<never> => Promise.reject(new Error('adapter down'));

async function fails(cb: CircuitBreaker, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await assert.rejects(() => cb.exec(boom));
  }
}

test('a closed circuit passes values through', async () => {
  const cb = breaker(new TestClock(0));
  assert.equal(cb.state, 'closed');
  assert.equal(await cb.exec(async () => 42), 42);
  assert.equal(cb.stats().successes, 1);
});

test('a failing call rethrows the ORIGINAL error, not a wrapper', async () => {
  const cb = breaker(new TestClock(0));
  await assert.rejects(
    () => cb.exec(boom),
    (e: unknown) => e instanceof Error && !(e instanceof AdapterError) && e.message === 'adapter down',
  );
});

test('a success in closed state resets the consecutive failure counter', async () => {
  const cb = breaker(new TestClock(0));
  await fails(cb, 2);
  assert.equal(cb.stats().consecutiveFailures, 2);
  await cb.exec(async () => 'ok');
  assert.equal(cb.stats().consecutiveFailures, 0);
  await fails(cb, 2);
  assert.equal(cb.state, 'closed', 'the streak restarted, so the threshold is not reached');
});

test('the circuit opens at failureThreshold consecutive failures and stops calling fn', async () => {
  const clock = new TestClock(0);
  const cb = breaker(clock);
  await fails(cb, 3);
  assert.equal(cb.state, 'open');

  let called = 0;
  await assert.rejects(
    () =>
      cb.exec(async () => {
        called++;
        return 1;
      }),
    (e: unknown) => e instanceof AdapterError && e.code === 'CIRCUIT_OPEN',
  );
  assert.equal(called, 0, 'an open circuit must not touch the adapter');
  assert.equal(cb.stats().rejected, 1);
});

test('the circuit stays open for the whole cooldown, measured on the injected clock', async () => {
  const clock = new TestClock(0);
  const cb = breaker(clock);
  await fails(cb, 3);
  clock.advance(9_999);
  assert.equal(cb.state, 'open');
  clock.advance(1);
  assert.equal(cb.state, 'half_open');
});

test('one success in half_open closes the circuit and resets the counter', async () => {
  const clock = new TestClock(0);
  const cb = breaker(clock);
  await fails(cb, 3);
  clock.advance(10_000);
  assert.equal(cb.state, 'half_open');
  assert.equal(await cb.exec(async () => 'probe'), 'probe');
  assert.equal(cb.state, 'closed');
  assert.equal(cb.stats().consecutiveFailures, 0);
  await fails(cb, 2);
  assert.equal(cb.state, 'closed', 'the failure budget was restored in full');
});

test('one failure in half_open reopens and restarts the FULL cooldown', async () => {
  const clock = new TestClock(0);
  const cb = breaker(clock);
  await fails(cb, 3);
  clock.advance(10_000);
  assert.equal(cb.state, 'half_open');
  await assert.rejects(() => cb.exec(boom));
  assert.equal(cb.state, 'open');
  clock.advance(9_999);
  assert.equal(cb.state, 'open', 'the cooldown restarted from the reopen, not the first open');
  clock.advance(1);
  assert.equal(cb.state, 'half_open');
  assert.equal(cb.stats().opens, 2);
});

test('half_open admits at most halfOpenMax concurrent trials', async () => {
  const clock = new TestClock(0);
  const cb = breaker(clock, { halfOpenMax: 1 });
  await fails(cb, 3);
  clock.advance(10_000);
  assert.equal(cb.state, 'half_open');

  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const first = cb.exec(async () => {
    await gate;
    return 'first';
  });

  let secondCalled = 0;
  await assert.rejects(
    () =>
      cb.exec(async () => {
        secondCalled++;
        return 'second';
      }),
    (e: unknown) => e instanceof AdapterError && e.code === 'CIRCUIT_HALF_OPEN_BUSY',
  );
  assert.equal(secondCalled, 0, 'the extra trial never reaches the adapter');

  assert.ok(release);
  (release as unknown as () => void)();
  assert.equal(await first, 'first');
  assert.equal(cb.state, 'closed');
});

test('halfOpenMax > 1 admits exactly that many trials', async () => {
  const clock = new TestClock(0);
  const cb = breaker(clock, { halfOpenMax: 2 });
  await fails(cb, 3);
  clock.advance(10_000);

  const gates: Array<() => void> = [];
  const mk = (): Promise<string> =>
    cb.exec(
      () =>
        new Promise<string>((r) => {
          gates.push(() => r('done'));
        }),
    );
  const a = mk();
  const b = mk();
  await assert.rejects(
    () => cb.exec(async () => 'third'),
    (e: unknown) => e instanceof AdapterError && e.code === 'CIRCUIT_HALF_OPEN_BUSY',
  );
  for (const g of gates) g();
  assert.deepEqual(await Promise.all([a, b]), ['done', 'done']);
  assert.equal(cb.state, 'closed');
});

test('bad breaker options are refused at construction', () => {
  const clock = new TestClock(0);
  assert.throws(() => new CircuitBreaker('x', { ...OPTS, failureThreshold: 0 }, clock, nullLogger), AresError);
  assert.throws(() => new CircuitBreaker('x', { ...OPTS, cooldownMs: -1 }, clock, nullLogger), AresError);
  assert.throws(() => new CircuitBreaker('x', { ...OPTS, halfOpenMax: 0 }, clock, nullLogger), AresError);
});

test('reset() closes the circuit manually', async () => {
  const clock = new TestClock(0);
  const cb = breaker(clock);
  await fails(cb, 3);
  assert.equal(cb.state, 'open');
  cb.reset();
  assert.equal(cb.state, 'closed');
  assert.equal(await cb.exec(async () => 1), 1);
});

test('RateLimiter allows a burst up to capacity then refuses', () => {
  const clock = new TestClock(0);
  const rl = new RateLimiter(60, clock);
  for (let i = 0; i < 60; i++) assert.equal(rl.tryTake(), true, `take ${i}`);
  assert.equal(rl.tryTake(), false);
  assert.equal(rl.stats().refused, 1);
});

test('RateLimiter refills continuously, not in fixed windows', () => {
  const clock = new TestClock(0);
  const rl = new RateLimiter(120, clock); // 2 per second
  for (let i = 0; i < 120; i++) rl.tryTake();
  assert.equal(rl.tryTake(), false);

  clock.advance(500); // half a second -> exactly one token
  assert.equal(rl.tryTake(), true);
  assert.equal(rl.tryTake(), false, 'no window boundary hands out a free batch');

  clock.advance(1_000);
  assert.equal(rl.tryTake(2), true);
  assert.equal(rl.tryTake(), false);
});

test('RateLimiter never mints more than capacity and never runs backwards', () => {
  const clock = new TestClock(0);
  const rl = new RateLimiter(10, clock);
  clock.advance(600_000);
  assert.equal(Math.round(rl.available()), 10);
  assert.equal(rl.tryTake(10), true);
  assert.equal(rl.tryTake(), false);
});

test('RateLimiter rejects nonsense configuration and takes', () => {
  const clock = new TestClock(0);
  assert.throws(() => new RateLimiter(0, clock), AresError);
  const rl = new RateLimiter(10, clock);
  assert.throws(() => rl.tryTake(0), AresError);
  assert.throws(() => rl.tryTake(-2), AresError);
});
