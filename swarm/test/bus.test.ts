/**
 * test/bus.test.ts — adversarial tests for the message bus: hop limits, queue
 * backpressure, the TICK-based loop guard, and the guarantee that a throwing
 * handler is counted rather than allowed to take the bus (or the tick) down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/bus/bus.js';
import type { Envelope } from '../src/bus/protocol.js';
import { loadConfig, type AresConfig, type Env } from '../src/core/config.js';
import { TestClock } from '../src/core/clock.js';
import { nullLogger } from '../src/core/logger.js';

function cfgWith(env: Env = {}): AresConfig {
  return loadConfig(env);
}

function makeBus(env: Env = {}): { bus: Bus; clock: TestClock; cfg: AresConfig } {
  const cfg = cfgWith(env);
  const clock = new TestClock(1_000);
  return { bus: new Bus(cfg, clock, nullLogger), clock, cfg };
}

test('publish fills id/ts/hops/traceId and delivers to matching subscribers', async () => {
  const { bus, clock } = makeBus();
  const seen: Envelope[] = [];
  bus.subscribe('a1', ['OPPORTUNITY_FOUND'], (e) => {
    seen.push(e);
  });
  bus.subscribe('a2', ['SALE_FILLED'], () => {
    throw new Error('should never be called for a non-matching type');
  });

  const env = bus.publish({ type: 'OPPORTUNITY_FOUND', from: 'scout-1', tick: 3, payload: { sku: 'X' } });
  assert.match(env.id, /^msg_/);
  assert.equal(env.ts, clock.now());
  assert.equal(env.hops, 0);
  assert.equal(env.to, '*');
  assert.equal(env.causationId, null);
  assert.match(env.traceId, /^trace_/);

  await bus.drain();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.id, env.id);
  assert.equal(bus.stats().published, 1);
  assert.equal(bus.stats().dropped, 0);
  assert.equal(bus.stats().depth, 0);
});

test('directed messages only reach the addressed agent', async () => {
  const { bus } = makeBus();
  let a = 0;
  let b = 0;
  bus.subscribe('a1', ['PRICE_ADVICE'], () => {
    a++;
  });
  bus.subscribe('a2', ['PRICE_ADVICE'], () => {
    b++;
  });
  bus.publish({ type: 'PRICE_ADVICE', from: 'system', to: 'a2', tick: 1, payload: { p: 1 } });
  await bus.drain();
  assert.equal(a, 0);
  assert.equal(b, 1);
});

test('unsubscribe stops delivery', async () => {
  const { bus } = makeBus();
  let n = 0;
  const off = bus.subscribe('a1', ['AUDIT_TICK'], () => {
    n++;
  });
  bus.publish({ type: 'AUDIT_TICK', from: 'system', tick: 1, payload: {} });
  await bus.drain();
  off();
  bus.publish({ type: 'AUDIT_TICK', from: 'system', tick: 2, payload: {} });
  await bus.drain();
  assert.equal(n, 1);
});

test('hops derive from causation and traceId propagates along the chain', () => {
  const { bus } = makeBus();
  const root = bus.publish({ type: 'OPPORTUNITY_FOUND', from: 'scout-1', tick: 1, payload: { i: 0 } });
  const child = bus.publish({ type: 'BUY_REQUEST', from: 'scout-1', tick: 1, payload: { i: 1 }, causation: root });
  const grand = bus.publish({ type: 'BUY_RESULT', from: 'system', tick: 1, payload: { i: 2 }, causation: child });
  assert.equal(root.hops, 0);
  assert.equal(child.hops, 1);
  assert.equal(grand.hops, 2);
  assert.equal(child.traceId, root.traceId);
  assert.equal(grand.traceId, root.traceId);
  assert.equal(child.causationId, root.id);
  assert.equal(grand.causationId, child.id);
});

test('a chain longer than maxHops is dropped and counted', async () => {
  const { bus, cfg } = makeBus({ ARES_MAX_HOPS: '3' });
  const delivered: Envelope[] = [];
  bus.subscribe('sink', ['BUY_REQUEST'], (e) => {
    delivered.push(e);
  });

  let prev: Envelope | null = null;
  const built: Envelope[] = [];
  for (let i = 0; i <= cfg.limits.maxHops + 2; i++) {
    prev = bus.publish({ type: 'BUY_REQUEST', from: 'a', tick: i, payload: { i }, causation: prev });
    built.push(prev);
  }
  await bus.drain();

  // hops 0..3 delivered, hops 4 and 5 dropped.
  assert.deepEqual(built.map((e) => e.hops), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(delivered.map((e) => e.hops), [0, 1, 2, 3]);
  const s = bus.stats();
  assert.equal(s.dropped, 2);
  assert.equal(s.dropReasons['max_hops'], 2);
  assert.equal(s.published, 4);
});

test('a dropped envelope is still returned, so hops keep incrementing honestly', () => {
  const { bus } = makeBus({ ARES_MAX_HOPS: '0' });
  const root = bus.publish({ type: 'HALT', from: 'system', tick: 1, payload: {} });
  const child = bus.publish({ type: 'HALT', from: 'system', tick: 1, payload: {}, causation: root });
  assert.equal(child.hops, 1);
  assert.equal(bus.stats().dropReasons['max_hops'], 1);
});

test('queue depth over maxQueueDepth applies backpressure', async () => {
  const { bus } = makeBus({ ARES_MAX_QUEUE: '3', ARES_REPEAT_THRESHOLD: '1000' });
  bus.subscribe('sink', ['AUDIT_TICK'], () => {});
  for (let i = 0; i < 10; i++) bus.publish({ type: 'AUDIT_TICK', from: 'system', tick: 1, payload: { i } });
  const s = bus.stats();
  assert.equal(s.depth, 3);
  assert.equal(s.published, 3);
  assert.equal(s.dropped, 7);
  assert.equal(s.dropReasons['queue_full'], 7);
  await bus.drain();
  assert.equal(bus.stats().depth, 0);
});

test('LOOP GUARD: identical (from,type,payload) drops once the threshold is hit', async () => {
  const { bus } = makeBus({ ARES_REPEAT_WINDOW: '2', ARES_REPEAT_THRESHOLD: '4' });
  bus.subscribe('sink', ['OPPORTUNITY_FOUND', 'POLICY_DENIED'], () => {});
  const pub = (tick: number) => bus.publish({ type: 'OPPORTUNITY_FOUND', from: 'scout-1', tick, payload: { s: 'X' } });

  for (let i = 0; i < 3; i++) pub(1); // 3 occurrences at tick 1
  assert.equal(bus.stats().dropped, 0);
  pub(2); // 4th occurrence inside the 2-tick window -> still allowed
  assert.equal(bus.stats().dropped, 0);
  pub(2); // 5th -> seen >= 4 -> DROP
  const s = bus.stats();
  assert.equal(s.dropped, 1);
  assert.equal(s.dropReasons['loop_guard'], 1);

  const suspects = bus.loopSuspects();
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0]?.type, 'OPPORTUNITY_FOUND');
  assert.equal(suspects[0]?.from, 'scout-1');
  assert.ok((suspects[0]?.drops ?? 0) >= 1);
});

test('LOOP GUARD: the window is measured in TICKS, not in messages', async () => {
  const { bus } = makeBus({ ARES_REPEAT_WINDOW: '2', ARES_REPEAT_THRESHOLD: '4' });
  const pub = (tick: number) => bus.publish({ type: 'BUY_REQUEST', from: 'scout-1', tick, payload: { s: 'X' } });

  for (let i = 0; i < 4; i++) pub(1);
  pub(1); // 5th at tick 1 -> dropped
  assert.equal(bus.stats().dropReasons['loop_guard'], 1);

  // Jump past the window: the old occurrences must age out by TICK, even though
  // the number of messages published has not changed.
  const before = bus.stats().dropped;
  for (let i = 0; i < 4; i++) pub(50);
  assert.equal(bus.stats().dropped, before, 'occurrences did not age out of the tick window');
  pub(50); // 5th within the new window -> dropped again
  assert.equal(bus.stats().dropReasons['loop_guard'], 2);
});

test('LOOP GUARD: different payload / sender / type are not conflated', () => {
  const { bus } = makeBus({ ARES_REPEAT_WINDOW: '10', ARES_REPEAT_THRESHOLD: '2' });
  bus.publish({ type: 'BUY_REQUEST', from: 'a', tick: 1, payload: { k: 1 } });
  bus.publish({ type: 'BUY_REQUEST', from: 'a', tick: 1, payload: { k: 2 } });
  bus.publish({ type: 'BUY_REQUEST', from: 'b', tick: 1, payload: { k: 1 } });
  bus.publish({ type: 'BUY_RESULT', from: 'a', tick: 1, payload: { k: 1 } });
  assert.equal(bus.stats().dropped, 0);
  // Key ordering inside the payload must not matter (canonical JSON).
  bus.publish({ type: 'BUY_REQUEST', from: 'a', tick: 1, payload: { k: 1, z: 9 } });
  bus.publish({ type: 'BUY_REQUEST', from: 'a', tick: 1, payload: { z: 9, k: 1 } });
  bus.publish({ type: 'BUY_REQUEST', from: 'a', tick: 1, payload: { z: 9, k: 1 } });
  assert.equal(bus.stats().dropReasons['loop_guard'], 1);
});

test('LOOP GUARD: a drop emits POLICY_DENIED without recursing', async () => {
  const { bus } = makeBus({ ARES_REPEAT_WINDOW: '5', ARES_REPEAT_THRESHOLD: '2' });
  const denials: Envelope[] = [];
  bus.subscribe('scout-1', ['POLICY_DENIED'], (e) => {
    denials.push(e);
  });
  bus.subscribe('scout-1', ['OPPORTUNITY_FOUND'], () => {});

  for (let i = 0; i < 5; i++) {
    bus.publish({ type: 'OPPORTUNITY_FOUND', from: 'scout-1', tick: 1, payload: { same: true } });
  }
  await bus.drain();

  assert.equal(denials.length, 3, 'one POLICY_DENIED per dropped message');
  const d = denials[0];
  assert.equal(d?.from, 'system');
  assert.equal(d?.to, 'scout-1');
  assert.equal(d?.hops, 0);
  const payload = d?.payload as Record<string, unknown>;
  assert.equal(payload['reason'], 'loop_guard');
  assert.equal(payload['offendingType'], 'OPPORTUNITY_FOUND');
  // The notices themselves were never loop-guarded into a storm.
  assert.equal(bus.stats().dropReasons['loop_guard'], 3);
});

test('an unhashable payload does not crash publish', async () => {
  const { bus } = makeBus();
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  let got = 0;
  bus.subscribe('sink', ['AUDIT_TICK'], () => {
    got++;
  });
  assert.doesNotThrow(() => bus.publish({ type: 'AUDIT_TICK', from: 'system', tick: 1, payload: cyclic }));
  await bus.drain();
  assert.equal(got, 1);
});

test('a throwing handler is caught, counted, and does not stop other subscribers', async () => {
  const { bus } = makeBus();
  const order: string[] = [];
  bus.subscribe('bad', ['SALE_FILLED'], () => {
    order.push('bad');
    throw new Error('handler exploded');
  });
  bus.subscribe('good', ['SALE_FILLED'], () => {
    order.push('good');
  });

  bus.publish({ type: 'SALE_FILLED', from: 'seller-1', tick: 1, payload: { a: 1 } });
  await assert.doesNotReject(() => bus.drain());
  assert.deepEqual(order, ['bad', 'good']);
  const s = bus.stats();
  assert.equal(s.handlerErrors, 1);
  assert.equal(s.dropReasons['handler_error'], 1);
  assert.equal(s.delivered, 1);

  // The bus keeps working afterwards.
  bus.publish({ type: 'SALE_FILLED', from: 'seller-1', tick: 2, payload: { a: 2 } });
  await bus.drain();
  assert.equal(bus.stats().handlerErrors, 2);
});

test('a rejecting async handler is caught too', async () => {
  const { bus } = makeBus();
  bus.subscribe('bad', ['HALT'], async () => {
    await Promise.resolve();
    throw new Error('async explosion');
  });
  bus.publish({ type: 'HALT', from: 'system', tick: 1, payload: {} });
  await assert.doesNotReject(() => bus.drain());
  assert.equal(bus.stats().handlerErrors, 1);
});

test('drain processes messages published by handlers (cascade)', async () => {
  const { bus } = makeBus({ ARES_REPEAT_THRESHOLD: '1000' });
  const seen: string[] = [];
  bus.subscribe('a', ['OPPORTUNITY_FOUND'], (e) => {
    seen.push('opp');
    bus.publish({ type: 'BUY_REQUEST', from: 'a', tick: e.tick, payload: { n: 1 }, causation: e });
  });
  bus.subscribe('b', ['BUY_REQUEST'], (e) => {
    seen.push(`buy:${e.hops}`);
  });
  bus.publish({ type: 'OPPORTUNITY_FOUND', from: 'system', tick: 1, payload: {} });
  await bus.drain();
  assert.deepEqual(seen, ['opp', 'buy:1']);
  assert.equal(bus.stats().depth, 0);
});

test('close() stops accepting new messages but drains what is queued', async () => {
  const { bus } = makeBus();
  let n = 0;
  bus.subscribe('a', ['AUDIT_TICK'], () => {
    n++;
  });
  bus.publish({ type: 'AUDIT_TICK', from: 'system', tick: 1, payload: {} });
  bus.close();
  bus.publish({ type: 'AUDIT_TICK', from: 'system', tick: 2, payload: {} });
  await bus.drain();
  assert.equal(n, 1);
  assert.equal(bus.stats().dropReasons['closed'], 1);
});

test('stats() returns a copy of dropReasons (no external mutation)', () => {
  const { bus } = makeBus({ ARES_MAX_HOPS: '0' });
  const root = bus.publish({ type: 'HALT', from: 'system', tick: 1, payload: {} });
  bus.publish({ type: 'HALT', from: 'system', tick: 1, payload: {}, causation: root });
  const s = bus.stats();
  s.dropReasons['max_hops'] = 999;
  assert.equal(bus.stats().dropReasons['max_hops'], 1);
});
