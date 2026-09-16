/**
 * test/memory.test.ts — attacks the agent's durable memory: path traversal via
 * scope, torn/corrupt files on disk, unbounded growth, numerical stability of
 * the running stats, flush debouncing and byte-for-byte reload fidelity.
 * Deterministic only: real temp dirs, no timers, no wall-clock ordering.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MemoryStore, EPISODE_CAP, POSTMORTEM_CAP, EWMA_ALPHA, safeScopeName } from '../src/memory/store.js';
import { createLogger, nullLogger } from '../src/core/logger.js';
import { TestClock } from '../src/core/clock.js';
import { AresError } from '../src/core/errors.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ares-memory-'));
}

function open(dir: string, scope = 'agent-1', logger = nullLogger): MemoryStore {
  return MemoryStore.open(dir, scope, logger);
}

function episode(tick: number, kind = 'buy'): {
  tick: number;
  kind: string;
  net: number;
  success: boolean;
  meta: Record<string, unknown>;
} {
  return { tick, kind, net: tick * 10, success: tick % 2 === 0, meta: { tick } };
}

test('open() creates the memory dir and a per-scope file on flush', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    assert.equal(m.file, join(dir, 'memory', 'agent-1.json'));
    m.setFact('hello', 'world');
    m.flush();
    assert.ok(existsSync(m.file));
    assert.equal(JSON.parse(readFileSync(m.file, 'utf8')).facts.hello, 'world');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope sanitisation keeps the file inside the memory dir', () => {
  const dir = tmp();
  try {
    const m = open(dir, 'scout agent #7');
    assert.equal(basename(m.file), 'scout_agent__7.json');
    m.setFact('k', 1);
    m.flush();
    const files = readdirSync(join(dir, 'memory'));
    assert.deepEqual(files, ['scout_agent__7.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('path-traversal scopes are REJECTED, not cleaned up', () => {
  const dir = tmp();
  try {
    const attacks = [
      '..',
      '../evil',
      '../../etc/passwd',
      'a/../../b',
      '/etc/passwd',
      'a/b',
      'a\\b',
      'x\0y',
      '',
      '.hidden',
      'C:\\windows\\system32',
      'x'.repeat(200),
    ];
    for (const scope of attacks) {
      assert.throws(
        () => open(dir, scope),
        (err: unknown) => err instanceof AresError && err.code === 'INVALID_SCOPE',
        `scope ${JSON.stringify(scope)} must be rejected`,
      );
    }
    // The scope is validated BEFORE any filesystem work: nothing was created
    // at all, inside the dataDir or anywhere else.
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(existsSync(join(dir, 'memory')), false);
    assert.ok(safeScopeName('agent-1') === 'agent-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remember() is a ring buffer of 500 keeping the NEWEST in order', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    for (let i = 0; i < 600; i++) m.remember(episode(i));
    assert.equal(m.size(), EPISODE_CAP);
    const all = m.recall();
    assert.equal(all.length, EPISODE_CAP);
    // Most-recent-first, contiguous, oldest surviving tick is 100.
    assert.equal(all[0]?.tick, 599);
    assert.equal(all[EPISODE_CAP - 1]?.tick, 100);
    for (let i = 0; i < all.length; i++) assert.equal(all[i]?.tick, 599 - i);
    // Survives a reload with the same window.
    m.flush();
    const again = open(dir).recall();
    assert.equal(again.length, EPISODE_CAP);
    assert.equal(again[0]?.tick, 599);
    assert.equal(again[EPISODE_CAP - 1]?.tick, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recall() filters by kind and honours limit, newest first', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    for (let i = 0; i < 10; i++) m.remember(episode(i, i % 2 === 0 ? 'buy' : 'sell'));
    const sells = m.recall('sell');
    assert.deepEqual(
      sells.map((e) => e.tick),
      [9, 7, 5, 3, 1],
    );
    assert.deepEqual(
      m.recall('sell', 2).map((e) => e.tick),
      [9, 7],
    );
    assert.equal(m.recall('nope').length, 0);
    assert.equal(m.recall(undefined, 3).length, 3);
    assert.equal(m.recall(undefined, 0).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remember() rejects a malformed record', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    assert.throws(
      // Justified cast: deliberately feeding the wrong shape past the type system.
      () => m.remember({ tick: 1, kind: 'x', net: 1, success: true } as unknown as never),
      (err: unknown) => err instanceof AresError && err.code === 'INVALID_EPISODE',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('facts round-trip; getFact returns the default for an unset key', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    assert.equal(m.getFact('missing', 42), 42);
    m.setFact('n', 7);
    m.setFact('obj', { a: [1, 2, 3], b: 'x' });
    assert.equal(m.getFact('n', 0), 7);
    assert.deepEqual(m.getFact<{ a: number[]; b: string }>('obj', { a: [], b: '' }), { a: [1, 2, 3], b: 'x' });
    // Stored facts are copies: mutating the caller's object cannot alter memory.
    const src = { mutate: 1 };
    m.setFact('copy', src);
    src.mutate = 999;
    assert.deepEqual(m.getFact('copy', {}), { mutate: 1 });
    assert.throws(
      () => m.setFact('', 1),
      (err: unknown) => err instanceof AresError && err.code === 'INVALID_FACT_KEY',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('observe() keeps a stable Welford mean and a documented EWMA; stat() is null when unseen', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    assert.equal(m.stat('margin'), null);

    m.observe('margin', 10);
    assert.deepEqual(m.stat('margin'), { n: 1, mean: 10, ewma: 10, last: 10 });

    m.observe('margin', 20);
    const s = m.stat('margin');
    assert.equal(s?.n, 2);
    assert.equal(s?.mean, 15);
    assert.equal(s?.last, 20);
    assert.ok(Math.abs((s?.ewma ?? 0) - (EWMA_ALPHA * 20 + (1 - EWMA_ALPHA) * 10)) < 1e-12);

    // Numerical stability: a naive sum/n loses all precision at this offset.
    const big = open(dir, 'big');
    const base = 1e9;
    for (const v of [base + 4, base + 7, base + 13, base + 16]) big.observe('x', v);
    assert.equal(big.stat('x')?.mean, base + 10);
    assert.ok(Math.abs((big.variance('x') ?? 0) - 30) < 1e-6);
    assert.equal(big.variance('never'), null);

    assert.throws(
      () => m.observe('margin', Number.NaN),
      (err: unknown) => err instanceof AresError && err.code === 'INVALID_OBSERVATION',
    );
    assert.throws(
      () => m.observe('margin', Number.POSITIVE_INFINITY),
      (err: unknown) => err instanceof AresError && err.code === 'INVALID_OBSERVATION',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('postmortems are bounded, newest-first, and survive a reload', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    for (let i = 0; i < POSTMORTEM_CAP + 20; i++) m.postmortem(`died ${i}`, { i });
    m.flush();
    const back = open(dir);
    const all = back.postmortems();
    assert.equal(all.length, POSTMORTEM_CAP);
    assert.equal(all[0]?.text, `died ${POSTMORTEM_CAP + 19}`);
    assert.equal(all[all.length - 1]?.text, `died ${20}`);
    assert.deepEqual(all[0]?.meta, { i: POSTMORTEM_CAP + 19 });
    // Sequence numbers keep counting across the reload.
    back.postmortem('one more', {});
    assert.equal(back.postmortems(1)[0]?.seq, POSTMORTEM_CAP + 21);
    assert.throws(
      () => back.postmortem('', {}),
      (err: unknown) => err instanceof AresError && err.code === 'INVALID_POSTMORTEM',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flush() is debounced: many mutations cost one fsync, and a clean store writes nothing', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    for (let i = 0; i < 25; i++) m.setFact(`k${i}`, i);
    m.observe('x', 1);
    m.remember(episode(1));
    assert.equal(m.flushCount, 0, 'no disk write before flush()');
    assert.ok(m.dirty);
    assert.equal(existsSync(m.file), false, 'nothing persisted until flush()');

    m.flush();
    assert.equal(m.flushCount, 1);
    assert.equal(m.dirty, false);

    m.flush();
    m.flush();
    assert.equal(m.flushCount, 1, 'flushing a clean store is a no-op');

    m.setFact('again', true);
    m.flush();
    assert.equal(m.flushCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flush() leaves no tmp file behind and the target always parses', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    for (let i = 0; i < 5; i++) {
      m.remember(episode(i));
      m.flush();
      const files = readdirSync(join(dir, 'memory'));
      assert.deepEqual(files, ['agent-1.json'], 'tmp file is renamed, never left behind');
      assert.ok(JSON.parse(readFileSync(m.file, 'utf8')));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a crash BEFORE the rename leaves the old file intact and the stray tmp is discarded', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    m.setFact('good', 'value');
    m.flush();
    const good = readFileSync(m.file, 'utf8');

    // Simulate the crash: a half-written tmp exists, the target is untouched.
    writeFileSync(`${m.file}.tmp`, '{"facts":{"good":"HALF-WRIT');
    assert.equal(readFileSync(m.file, 'utf8'), good);

    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', write: (l) => lines.push(l), clock: new TestClock(1) });
    const back = MemoryStore.open(dir, 'agent-1', logger);
    assert.equal(back.getFact('good', 'x'), 'value', 'recovered the last good file');
    assert.equal(existsSync(`${m.file}.tmp`), false, 'stale tmp discarded on open');
    assert.ok(lines.some((l) => l.includes('stale memory tmp')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt memory file is quarantined, logged, and never crashes open()', () => {
  const dir = tmp();
  try {
    const first = open(dir);
    first.setFact('k', 'v');
    first.flush();
    writeFileSync(first.file, '{ this is not json at all ');

    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', write: (l) => lines.push(l), clock: new TestClock(1) });
    const back = MemoryStore.open(dir, 'agent-1', logger);

    assert.equal(back.getFact('k', 'default'), 'default', 'starts from empty state');
    assert.equal(back.size(), 0);
    const files = readdirSync(join(dir, 'memory'));
    assert.ok(
      files.some((f) => f.startsWith('agent-1.json.corrupt.')),
      `bad file preserved aside: ${files.join(',')}`,
    );
    assert.ok(lines.some((l) => l.includes('corrupt')), 'a warning was logged');
    assert.ok(lines.some((l) => JSON.parse(l).level === 'warn'));

    // And the store is fully usable afterwards.
    back.setFact('k', 'fresh');
    back.flush();
    assert.equal(open(dir).getFact('k', ''), 'fresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a structurally wrong (but valid JSON) file is treated as corrupt', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    m.setFact('k', 'v');
    m.flush();
    writeFileSync(m.file, JSON.stringify({ version: 1, facts: { a: 1 } })); // no episodes/stats
    const back = open(dir);
    assert.equal(back.getFact('a', 'default'), 'default');
    assert.ok(readdirSync(join(dir, 'memory')).some((f) => f.includes('.corrupt.')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reload fidelity: facts, episodes, stats and postmortems all survive export() identical', () => {
  const dir = tmp();
  try {
    const m = open(dir, 'task');
    m.setFact('bestChannel', 'dataproducts');
    m.setFact('nested', { a: 1, b: [true, null, 'x'] });
    for (let i = 0; i < 12; i++) m.remember(episode(i, i % 3 === 0 ? 'sale' : 'buy'));
    for (const v of [1.5, 2.25, 3.125, 4]) m.observe('sellThrough', v);
    m.observe('latencyMs', 11);
    m.postmortem('terminated: negative net for 2 windows', { agentId: 'scout-3', netMinor: -1200 });
    m.postmortem('quarantined: 3 crashes', { agentId: 'seller-1' });
    const before = m.export();
    m.flush();

    const back = open(dir, 'task');
    assert.deepEqual(back.export(), before);
    // Byte-identical when re-serialised, too.
    assert.equal(JSON.stringify(back.export()), JSON.stringify(before));
    assert.deepEqual(back.stat('sellThrough'), m.stat('sellThrough'));
    assert.equal(back.recall('sale').length, m.recall('sale').length);
    assert.equal(back.postmortems()[0]?.text, 'quarantined: 3 crashes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export() is a plain JSON snapshot and a detached copy', () => {
  const dir = tmp();
  try {
    const m = open(dir);
    m.remember(episode(1));
    const snap = m.export();
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
    snap.episodes.length = 0;
    snap.facts['injected'] = true;
    assert.equal(m.size(), 1, 'mutating the snapshot cannot corrupt the store');
    assert.equal(m.getFact('injected', false), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two scopes in the same dataDir are independent files', () => {
  const dir = tmp();
  try {
    const a = open(dir, 'scout-1');
    const b = open(dir, 'seller-1');
    a.setFact('who', 'scout');
    b.setFact('who', 'seller');
    a.flush();
    b.flush();
    assert.equal(open(dir, 'scout-1').getFact('who', ''), 'scout');
    assert.equal(open(dir, 'seller-1').getFact('who', ''), 'seller');
    assert.deepEqual(readdirSync(join(dir, 'memory')).sort(), ['scout-1.json', 'seller-1.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
