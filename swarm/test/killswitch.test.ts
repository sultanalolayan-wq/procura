/**
 * test/killswitch.test.ts — the latch is attacked here: re-tripping, late
 * subscribers, a callback that throws, and the HALT-file watcher driven by a
 * TestClock (no real timers anywhere).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KillSwitch, haltFilePath, HALT_FILE } from '../src/governance/killswitch.js';
import { TestClock } from '../src/core/clock.js';
import { nullLogger } from '../src/core/logger.js';
import { HaltedError } from '../src/core/errors.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ares-halt-'));
}

/** Let queued microtasks (the watcher loop) run. No timers involved. */
async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

test('a fresh kill switch is live', () => {
  const ks = new KillSwitch(nullLogger);
  assert.equal(ks.tripped, false);
  assert.equal(ks.reason, null);
  assert.doesNotThrow(() => ks.assertLive());
});

test('trip latches and assertLive throws HaltedError', () => {
  const clock = new TestClock(5_000);
  const ks = new KillSwitch(nullLogger, clock);
  ks.trip('drawdown breached', { drawdown: 20_001 });
  assert.equal(ks.tripped, true);
  assert.equal(ks.reason, 'drawdown breached');
  assert.equal(ks.trippedAt, 5_000);
  assert.deepEqual(ks.meta, { drawdown: 20_001 });
  assert.throws(
    () => ks.assertLive(),
    (e: unknown) => e instanceof HaltedError && e.code === 'HALTED',
  );
});

test('a second trip keeps the FIRST reason and does not re-fire callbacks', () => {
  const ks = new KillSwitch(nullLogger);
  const seen: string[] = [];
  ks.onTrip((r) => seen.push(r));
  ks.trip('first');
  ks.trip('second');
  ks.trip('third');
  assert.equal(ks.reason, 'first');
  assert.deepEqual(seen, ['first']);
  assert.equal(ks.tripped, true);
});

test('callbacks registered after the trip fire immediately with the reason', () => {
  const ks = new KillSwitch(nullLogger);
  ks.trip('already gone');
  const seen: string[] = [];
  ks.onTrip((r) => seen.push(r));
  assert.deepEqual(seen, ['already gone']);
});

test('a throwing callback cannot starve its peers or unlatch the switch', () => {
  const ks = new KillSwitch(nullLogger);
  const seen: string[] = [];
  ks.onTrip(() => {
    seen.push('a');
  });
  ks.onTrip(() => {
    throw new Error('subscriber exploded');
  });
  ks.onTrip(() => {
    seen.push('c');
  });
  assert.doesNotThrow(() => ks.trip('boom'));
  assert.deepEqual(seen, ['a', 'c']);
  assert.equal(ks.tripped, true);
  assert.equal(ks.reason, 'boom');
  // And a late subscriber still fires.
  ks.onTrip((r) => seen.push(`late:${r}`));
  assert.deepEqual(seen, ['a', 'c', 'late:boom']);
});

test('onTrip returns an unsubscribe that works before the trip', () => {
  const ks = new KillSwitch(nullLogger);
  const seen: string[] = [];
  const off = ks.onTrip(() => seen.push('x'));
  off();
  ks.trip('nobody listening');
  assert.deepEqual(seen, []);
});

test('trip() with an empty reason still latches with a placeholder', () => {
  const ks = new KillSwitch(nullLogger);
  ks.trip('');
  assert.equal(ks.tripped, true);
  assert.equal(ks.reason, 'unspecified');
});

test('watchFile trips when the HALT file appears, on the injected clock only', async () => {
  const dir = tmp();
  const clock = new TestClock(0);
  const ks = new KillSwitch(nullLogger, clock);
  const stop = ks.watchFile(dir, clock, { intervalMs: 100 });
  try {
    await flush();
    assert.equal(ks.tripped, false, 'no HALT file yet');

    // Time passes with no file: still live.
    clock.advance(1_000);
    await flush();
    assert.equal(ks.tripped, false);

    writeFileSync(join(dir, HALT_FILE), 'stop');
    // The watcher must not notice until the clock moves.
    assert.equal(ks.tripped, false);
    clock.advance(100);
    await flush();
    assert.equal(ks.tripped, true);
    assert.match(ks.reason ?? '', /halt file present/);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchFile trips synchronously when the HALT file already exists', () => {
  const dir = tmp();
  writeFileSync(join(dir, HALT_FILE), '');
  const clock = new TestClock(0);
  const ks = new KillSwitch(nullLogger, clock);
  const stop = ks.watchFile(dir, clock, { intervalMs: 50 });
  try {
    assert.equal(ks.tripped, true);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop() ends the watcher so the process can exit', async () => {
  const dir = tmp();
  const clock = new TestClock(0);
  const ks = new KillSwitch(nullLogger, clock);
  const stop = ks.watchFile(dir, clock, { intervalMs: 10 });
  try {
    await flush();
    stop();
    assert.equal(ks.snapshot().watchers, 0);
    writeFileSync(join(dir, HALT_FILE), '');
    clock.advance(10_000);
    await flush();
    assert.equal(ks.tripped, false, 'a stopped watcher must not trip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('haltFilePath accepts a data dir or the halt file itself', () => {
  assert.equal(haltFilePath('/var/ares'), join('/var/ares', 'HALT'));
  assert.equal(haltFilePath(join('/var/ares', 'HALT')), join('/var/ares', 'HALT'));
});

test('snapshot reports listeners, watchers and the latch', async () => {
  const dir = tmp();
  const clock = new TestClock(7);
  const ks = new KillSwitch(nullLogger, clock);
  const stop = ks.watchFile(dir, clock, { intervalMs: 5 });
  try {
    ks.onTrip(() => {});
    await flush();
    const s = ks.snapshot();
    assert.equal(s.tripped, false);
    assert.equal(s.listeners, 1);
    assert.equal(s.watchers, 1);
    assert.equal(s.trippedAt, null);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
