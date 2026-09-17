/**
 * test/ledger.test.ts — the auditor's source of truth is attacked here:
 * unbalanced legs, tampered bytes on disk, torn trailing writes, duplicate
 * idempotency keys, reopen/replay, and the disk-before-memory write ordering.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, GENESIS_HASH, entryHash, type NewEntry } from '../src/core/ledger.js';
import { TestClock } from '../src/core/clock.js';
import { nullLogger } from '../src/core/logger.js';
import { IntegrityError } from '../src/core/errors.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ares-ledger-'));
}

function open(dir: string, clock = new TestClock(1_000)): Ledger {
  return Ledger.open(dir, clock, nullLogger);
}

function entry(n: number, over: Partial<NewEntry> = {}): NewEntry {
  return {
    tick: n,
    type: 'TEST',
    agentId: 'agent-1',
    currency: 'SAR',
    legs: [
      { account: 'cash', amount: -100 * n },
      { account: 'inventory', amount: 100 * n },
    ],
    idempotencyKey: `k${n}`,
    meta: { n },
    ...over,
  };
}

test('fresh ledger is empty and verifies', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    assert.equal(led.size(), 0);
    assert.deepEqual(led.verify(), { ok: true });
    assert.equal(led.head(), GENESIS_HASH);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append chains hashes from a genesis of 64 zeros', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    const a = led.append(entry(1));
    const b = led.append(entry(2));
    assert.equal(a.seq, 1);
    assert.equal(a.prevHash, GENESIS_HASH);
    assert.equal(GENESIS_HASH, '0'.repeat(64));
    assert.equal(b.seq, 2);
    assert.equal(b.prevHash, a.hash);
    assert.equal(led.head(), b.hash);
    assert.deepEqual(led.verify(), { ok: true });
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hash covers every field INCLUDING prevHash', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    const e = led.append(entry(1));
    const { hash, ...rest } = e;
    assert.equal(entryHash(rest), hash);
    // Flip each field in turn; the digest must change every time.
    const variants: Array<Omit<typeof e, 'hash'>> = [
      { ...rest, seq: 99 },
      { ...rest, ts: rest.ts + 1 },
      { ...rest, tick: rest.tick + 1 },
      { ...rest, type: 'OTHER' },
      { ...rest, agentId: 'agent-2' },
      { ...rest, currency: 'USD' },
      { ...rest, legs: [{ account: 'cash', amount: 1 }, { account: 'inventory', amount: -1 }] },
      { ...rest, idempotencyKey: 'other' },
      { ...rest, meta: { n: 999 } },
      { ...rest, prevHash: 'f'.repeat(64) },
    ];
    for (const v of variants) {
      assert.notEqual(entryHash(v), hash, `digest did not change for ${JSON.stringify(v)}`);
    }
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legs that do not sum to exactly 0 are refused', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    assert.throws(
      () => led.append(entry(1, { legs: [{ account: 'cash', amount: -100 }, { account: 'inventory', amount: 99 }] })),
      (e: unknown) => e instanceof IntegrityError && e.code === 'LEDGER_UNBALANCED',
    );
    assert.throws(
      () => led.append(entry(1, { legs: [{ account: 'cash', amount: 1 }] })),
      (e: unknown) => e instanceof IntegrityError && e.code === 'LEDGER_UNBALANCED',
    );
    // A rejected append writes nothing at all.
    assert.equal(led.size(), 0);
    assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), '');
    // A three-legged balanced entry is fine.
    const ok = led.append(
      entry(1, {
        legs: [
          { account: 'cash', amount: -110 },
          { account: 'inventory', amount: 100 },
          { account: 'fees', amount: 10 },
        ],
      }),
    );
    assert.equal(ok.seq, 1);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed legs/accounts/currency are refused before any write', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    // Justified casts: these are runtime attacks that the type system forbids.
    assert.throws(
      () => led.append(entry(1, { legs: [{ account: 'vault' as unknown as 'cash', amount: 0 }] })),
      (e: unknown) => e instanceof IntegrityError && e.code === 'LEDGER_BAD_ACCOUNT',
    );
    assert.throws(
      () => led.append(entry(1, { legs: [{ account: 'cash', amount: 1.5 }, { account: 'fees', amount: -1.5 }] })),
      (e: unknown) => e instanceof IntegrityError && e.code === 'LEDGER_NON_INTEGER_LEG',
    );
    assert.throws(
      () => led.append(entry(1, { currency: 'EUR' as unknown as 'SAR' })),
      (e: unknown) => e instanceof IntegrityError && e.code === 'LEDGER_BAD_CURRENCY',
    );
    assert.throws(
      () => led.append(entry(1, { legs: [] })),
      (e: unknown) => e instanceof IntegrityError && e.code === 'LEDGER_NO_LEGS',
    );
    assert.equal(led.size(), 0);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate idempotencyKey returns the existing entry, appends nothing, does not bump seq', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    const first = led.append(entry(1, { idempotencyKey: 'same' }));
    const bytesBefore = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
    const again = led.append(entry(2, { idempotencyKey: 'same', meta: { totally: 'different' } }));
    assert.equal(again.seq, first.seq);
    assert.equal(again.hash, first.hash);
    assert.deepEqual(again.meta, { n: 1 });
    assert.equal(led.size(), 1);
    assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), bytesBefore);
    assert.equal(led.has('same'), true);
    assert.equal(led.has('nope'), false);
    // The NEXT distinct entry still gets seq 2 (seq was not consumed).
    assert.equal(led.append(entry(2, { idempotencyKey: 'other' })).seq, 2);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty idempotencyKey is explicitly NOT deduplicated', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    led.append(entry(1, { idempotencyKey: '' }));
    led.append(entry(1, { idempotencyKey: '' }));
    assert.equal(led.size(), 2);
    assert.equal(led.has(''), false);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('idempotency survives a reopen', () => {
  const dir = tmp();
  const a = open(dir);
  a.append(entry(1, { idempotencyKey: 'dedupe-me' }));
  a.close();
  const b = open(dir);
  try {
    assert.equal(b.has('dedupe-me'), true);
    const again = b.append(entry(5, { idempotencyKey: 'dedupe-me' }));
    assert.equal(again.seq, 1);
    assert.equal(b.size(), 1);
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger survives reopen: chain, balances and seq continue', () => {
  const dir = tmp();
  const a = open(dir);
  a.append(entry(1));
  a.append(entry(2));
  const head = a.head();
  a.close();

  const b = open(dir);
  try {
    assert.equal(b.size(), 2);
    assert.equal(b.head(), head);
    assert.deepEqual(b.verify(), { ok: true });
    const c = b.append(entry(3));
    assert.equal(c.seq, 3);
    assert.equal(c.prevHash, head);
    assert.equal(b.balanceOf('cash'), -(100 + 200 + 300));
    assert.equal(b.balanceOf('inventory'), 600);
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TAMPER: corrupting one byte in line 2 is detected at seq 2 on reopen', () => {
  const dir = tmp();
  const path = join(dir, 'ledger.jsonl');
  const a = open(dir);
  a.append(entry(1));
  const second = a.append(entry(2));
  a.append(entry(3));
  a.close();

  const lines = readFileSync(path, 'utf8').split('\n');
  const line2 = lines[1];
  assert.ok(line2 !== undefined);
  // Flip a single byte inside the stored hash: still valid JSON, wrong digest.
  const bad = line2.replace(`"hash":"${second.hash}"`, `"hash":"${flip(second.hash)}"`);
  assert.notEqual(bad, line2, 'tamper did not apply');
  lines[1] = bad;
  writeFileSync(path, lines.join('\n'), 'utf8');

  try {
    assert.throws(
      () => open(dir),
      (e: unknown) =>
        e instanceof IntegrityError && e.code === 'LEDGER_CHAIN_BROKEN' && e.meta?.['brokenAtSeq'] === 2,
    );
    assert.throws(() => open(dir), /broken at seq 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TAMPER: editing a leg amount in place is detected at that seq', () => {
  const dir = tmp();
  const path = join(dir, 'ledger.jsonl');
  const a = open(dir);
  a.append(entry(1));
  a.append(entry(2));
  a.close();

  const lines = readFileSync(path, 'utf8').split('\n');
  const l1 = lines[0];
  assert.ok(l1 !== undefined);
  lines[0] = l1.replace('"amount":-100', '"amount":-900');
  assert.notEqual(lines[0], l1);
  writeFileSync(path, lines.join('\n'), 'utf8');

  try {
    assert.throws(
      () => open(dir),
      (e: unknown) => e instanceof IntegrityError && e.meta?.['brokenAtSeq'] === 1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TORN WRITE: a partial trailing line is reported, never silently skipped', () => {
  const dir = tmp();
  const path = join(dir, 'ledger.jsonl');
  const a = open(dir);
  a.append(entry(1));
  a.append(entry(2));
  a.close();
  // Simulate a crash half-way through the third append.
  appendFileSync(path, '{"seq":3,"ts":1000,"tic', 'utf8');

  try {
    assert.throws(
      () => open(dir),
      (e: unknown) =>
        e instanceof IntegrityError && e.code === 'LEDGER_TRUNCATED' && e.meta?.['expectedSeq'] === 3,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-JSON line is reported with its seq', () => {
  const dir = tmp();
  const path = join(dir, 'ledger.jsonl');
  const a = open(dir);
  a.append(entry(1));
  a.close();
  appendFileSync(path, 'not json at all\n', 'utf8');
  try {
    assert.throws(
      () => open(dir),
      (e: unknown) =>
        e instanceof IntegrityError && e.code === 'LEDGER_MALFORMED_LINE' && e.meta?.['brokenAtSeq'] === 2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a structurally invalid entry is reported with its seq', () => {
  const dir = tmp();
  const path = join(dir, 'ledger.jsonl');
  const a = open(dir);
  a.append(entry(1));
  a.close();
  appendFileSync(path, JSON.stringify({ seq: 2, ts: 1, tick: 1 }) + '\n', 'utf8');
  try {
    assert.throws(
      () => open(dir),
      (e: unknown) =>
        e instanceof IntegrityError && e.code === 'LEDGER_MALFORMED_ENTRY' && e.meta?.['brokenAtSeq'] === 2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DELETION: dropping a middle line is detected (seq/chain discontinuity)', () => {
  const dir = tmp();
  const path = join(dir, 'ledger.jsonl');
  const a = open(dir);
  a.append(entry(1));
  a.append(entry(2));
  a.append(entry(3));
  a.close();
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
  writeFileSync(path, [lines[0], lines[2]].join('\n') + '\n', 'utf8');
  try {
    assert.throws(
      () => open(dir),
      (e: unknown) => e instanceof IntegrityError && e.meta?.['brokenAtSeq'] === 2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CRASH SAFETY: a failed disk write must not advance in-memory state', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    led.append(entry(1));
    const headBefore = led.head();
    const sizeBefore = led.size();
    const bytesBefore = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');

    // Justified cast: reach into the private fd to simulate a disk failure
    // mid-append. This is precisely the ordering guarantee under test.
    const priv = led as unknown as { fd: number };
    const realFd = priv.fd;
    priv.fd = 999_999; // guaranteed-bad descriptor -> appendFileSync throws EBADF
    assert.throws(() => led.append(entry(2)));
    priv.fd = realFd;

    assert.equal(led.size(), sizeBefore, 'in-memory state moved ahead of disk');
    assert.equal(led.head(), headBefore);
    assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), bytesBefore);
    assert.deepEqual(led.verify(), { ok: true });

    // And the ledger is still usable afterwards.
    assert.equal(led.append(entry(2)).seq, 2);
    assert.deepEqual(led.verify(), { ok: true });
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('balances, netCashFlow and entries() filters', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    led.append({
      tick: 1,
      type: 'BUY',
      agentId: 'scout-1',
      currency: 'SAR',
      legs: [
        { account: 'cash', amount: -1000 },
        { account: 'inventory', amount: 900 },
        { account: 'fees', amount: 100 },
      ],
      idempotencyKey: 'b1',
      meta: {},
    });
    led.append({
      tick: 3,
      type: 'SALE',
      agentId: 'seller-1',
      currency: 'SAR',
      legs: [
        { account: 'cash', amount: 1500 },
        { account: 'revenue', amount: -1500 },
      ],
      idempotencyKey: 's1',
      meta: {},
    });
    led.append({
      tick: 9,
      type: 'SALE',
      agentId: 'seller-1',
      currency: 'SAR',
      legs: [
        { account: 'cash', amount: 500 },
        { account: 'revenue', amount: -500 },
      ],
      idempotencyKey: 's2',
      meta: {},
    });

    const b = led.balances();
    assert.equal(b.cash, 1000);
    assert.equal(b.inventory, 900);
    assert.equal(b.fees, 100);
    assert.equal(b.revenue, -2000);
    assert.equal(b.equity, 0);
    assert.equal(b.writeoff, 0);
    assert.equal(led.balanceOf('cash'), 1000);

    assert.equal(led.netCashFlow(0, 100), 1000);
    assert.equal(led.netCashFlow(1, 3), 500);
    assert.equal(led.netCashFlow(2, 3), 1500);
    assert.equal(led.netCashFlow(0, 100, 'scout-1'), -1000);
    assert.equal(led.netCashFlow(0, 100, 'seller-1'), 2000);
    assert.equal(led.netCashFlow(4, 8), 0);

    assert.equal(led.entries({ agentId: 'seller-1' }).length, 2);
    assert.equal(led.entries({ type: 'BUY' }).length, 1);
    assert.equal(led.entries({ sinceSeq: 1 }).length, 2);
    assert.equal(led.entries({ limit: 1 })[0]?.seq, 3, 'limit returns the most recent entries');
    assert.equal(led.entries().length, 3);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append after close() is refused', () => {
  const dir = tmp();
  const led = open(dir);
  led.close();
  try {
    assert.throws(
      () => led.append(entry(1)),
      (e: unknown) => e instanceof IntegrityError && e.code === 'LEDGER_CLOSED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ts comes from the injected clock, never Date.now()', () => {
  const dir = tmp();
  const clock = new TestClock(500);
  const led = open(dir, clock);
  try {
    assert.equal(led.append(entry(1)).ts, 500);
    clock.advance(250);
    assert.equal(led.append(entry(2)).ts, 750);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function flip(hex: string): string {
  const first = hex[0] ?? '0';
  return (first === '0' ? '1' : '0') + hex.slice(1);
}

/* ===================================================================== */
/* FIX B1a / B3 / B4 — bounded memory, streaming replay, incremental      */
/* verify, and a dedupe outcome a caller can actually see.                */
/* ===================================================================== */

test('FIX B3: memory holds only a bounded TAIL while the disk file stays whole', () => {
  const dir = tmp();
  const led = Ledger.open(dir, new TestClock(1_000), nullLogger, { tailCap: 5 });
  try {
    for (let i = 1; i <= 50; i++) led.append(entry(i));

    // Justified cast: the whole point of the fix is what is resident in memory.
    const rows = (led as unknown as { rows: unknown[] }).rows;
    assert.equal(rows.length, 5, 'only the tail is resident — this used to be every entry ever written');
    assert.equal(led.size(), 50, 'but the ledger still knows how big it is');
    assert.equal(led.stats().entries, 50);
    assert.equal(led.stats().retained, 5);

    // The disk file is authoritative and complete.
    const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 50);

    // Aggregates are maintained INCREMENTALLY, so they cover all 50 entries and
    // not just the 5 still in memory. sum(1..50) = 1275.
    assert.equal(led.balanceOf('cash'), -100 * 1275);
    assert.equal(led.balanceOf('inventory'), 100 * 1275);
    assert.equal(led.netCashFlow(0, 10_000), -100 * 1275);
    assert.equal(led.netCashFlow(0, 10_000, 'agent-1'), -100 * 1275);
    assert.equal(led.agentCashTotal('agent-1'), -100 * 1275);

    // The chain still verifies, and appending continues from the real head.
    assert.deepEqual(led.verify(), { ok: true });
    assert.equal(led.append(entry(51)).seq, 51);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FIX B3: a reopen of a tail-bounded ledger replays every entry and continues the chain', () => {
  const dir = tmp();
  const a = Ledger.open(dir, new TestClock(1_000), nullLogger, { tailCap: 4 });
  for (let i = 1; i <= 30; i++) a.append(entry(i));
  const head = a.head();
  a.close();

  const b = Ledger.open(dir, new TestClock(9_000), nullLogger, { tailCap: 4 });
  try {
    assert.equal(b.size(), 30, 'replay counted every line, not just the retained ones');
    assert.equal(b.head(), head);
    assert.equal((b as unknown as { rows: unknown[] }).rows.length, 4);
    assert.equal(b.balanceOf('inventory'), 100 * 465, 'balances were rebuilt from the WHOLE file');
    assert.deepEqual(b.verify(), { ok: true });
    assert.equal(b.append(entry(31)).seq, 31);
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FIX B3: replay streams the file, so a ledger larger than one read chunk opens', () => {
  const dir = tmp();
  // > 1 MiB, i.e. more than one read chunk, with a multi-byte character so a
  // UTF-8 sequence lands across a chunk boundary. The old readFileSync(path,
  // 'utf8') built ONE string for the whole file; past V8's ~536MB ceiling that
  // threw on every subsequent boot, permanently.
  const pad = 'ريال-٧'.repeat(120);
  const a = Ledger.open(dir, new TestClock(1_000), nullLogger);
  for (let i = 1; i <= 1_400; i++) a.append(entry(i, { meta: { n: i, pad } }));
  const head = a.head();
  const size = a.size();
  a.close();

  const bytes = readFileSync(join(dir, 'ledger.jsonl')).length;
  assert.ok(bytes > 1024 * 1024, `expected a multi-chunk file, got ${String(bytes)} bytes`);

  const b = Ledger.open(dir, new TestClock(2_000), nullLogger);
  try {
    assert.equal(b.size(), size);
    assert.equal(b.head(), head);
    assert.deepEqual(b.verify({ full: true }), { ok: true }, 'the full check streams the same bytes back');
    assert.equal(
      (b.entries({ limit: 1 })[0]?.meta as Record<string, unknown>)['pad'],
      pad,
      'multi-byte characters survived the chunk boundaries intact',
    );
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FIX B1a: verify() is incremental over the retained tail; verify({full}) streams the disk', () => {
  const dir = tmp();
  const led = Ledger.open(dir, new TestClock(1_000), nullLogger, { tailCap: 5 });
  try {
    for (let i = 1; i <= 50; i++) led.append(entry(i));
    assert.deepEqual(led.verify(), { ok: true });

    const v = led.lastVerification();
    assert.ok(v);
    assert.equal(v.full, false, 'the default check is NOT the whole chain');
    assert.equal(v.fromSeq, 46, 'it re-hashed the retained tail only — 5 entries, not 50');
    assert.equal(v.atSeq, 50);

    // In-memory tampering inside the tail is still caught.
    const rows = (led as unknown as { rows: Array<{ legs: Array<{ amount: number }> }> }).rows;
    rows[0]!.legs[0]!.amount = 999_999;
    assert.equal(led.verify().ok, false);
    assert.equal(led.verify().brokenAtSeq, 46);

    // ...and the file on disk is untouched, which the full check proves.
    assert.deepEqual(led.verify({ full: true }), { ok: true });
    const full = led.lastVerification();
    assert.ok(full);
    assert.equal(full.full, true);
    assert.equal(full.fromSeq, 1);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FIX B1a: lastVerification() serves a verdict without recomputing one', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    led.append(entry(1));
    assert.equal(led.verify().ok, true);
    const before = led.lastVerification();
    assert.ok(before);
    assert.equal(before.ok, true);
    assert.equal(before.brokenAtSeq, null);

    // Reading the record must not itself verify anything: corrupt the tail and
    // the CACHED verdict is unchanged until someone actually re-checks.
    const rows = (led as unknown as { rows: Array<{ legs: Array<{ amount: number }> }> }).rows;
    rows[0]!.legs[0]!.amount = 1;
    assert.deepEqual(led.lastVerification(), before, 'the cached verdict is read, never recomputed');
    assert.equal(led.verify().ok, false, 'an explicit re-check does see it');
    assert.equal(led.lastVerification()?.ok, false);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FIX B1a: entries({limit}) walks back from the newest instead of materialising every row', () => {
  const dir = tmp();
  const led = Ledger.open(dir, new TestClock(1_000), nullLogger, { tailCap: 100 });
  try {
    for (let i = 1; i <= 60; i++) led.append(entry(i));
    const one = led.entries({ limit: 1 });
    assert.equal(one.length, 1);
    assert.equal(one[0]?.seq, 60, 'the single most recent entry');
    assert.deepEqual(
      led.entries({ limit: 3 }).map((e) => e.seq),
      [58, 59, 60],
      'still oldest-first within the page',
    );
    assert.deepEqual(led.entries({ limit: 0 }), []);
    assert.equal(led.entries({ sinceSeq: 57 }).length, 3);
    assert.equal(led.entries({ agentId: 'agent-1', limit: 2 }).length, 2);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FIX B3: the idempotency index is bounded by age, but a pinned key is never forgotten', () => {
  const dir = tmp();
  const clock = new TestClock(1_000);
  const led = Ledger.open(dir, clock, nullLogger, { keyRetentionMs: 10_000 });
  try {
    // A once-per-lifetime entry. Ageing THIS key out would let the opening
    // balance be booked a second time on the next restart.
    led.append({
      tick: 0,
      type: 'OPENING_BALANCE',
      agentId: 'system',
      currency: 'SAR',
      legs: [
        { account: 'cash', amount: 100_000 },
        { account: 'equity', amount: -100_000 },
      ],
      idempotencyKey: 'budget.opening',
      meta: {},
    });
    led.append(entry(1, { idempotencyKey: 'ordinary' }));
    assert.equal(led.has('budget.opening'), true);
    assert.equal(led.has('ordinary'), true);

    clock.advance(60_000);
    led.append(entry(2, { idempotencyKey: 'recent' }));

    assert.equal(led.has('ordinary'), false, 'an ordinary key ages out of the index');
    assert.equal(led.has('recent'), true);
    assert.equal(led.has('budget.opening'), true, 'the pinned key survives any retention window');
    // And it still deduplicates, which is the only thing that matters.
    const again = led.append({
      tick: 9,
      type: 'OPENING_BALANCE',
      agentId: 'system',
      currency: 'SAR',
      legs: [
        { account: 'cash', amount: 100_000 },
        { account: 'equity', amount: -100_000 },
      ],
      idempotencyKey: 'budget.opening',
      meta: {},
    });
    assert.equal(again.deduplicated, true);
    assert.equal(again.seq, 1);
    assert.equal(led.balanceOf('equity'), -100_000, 'equity was NOT doubled');
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FIX B4: append() reports whether it deduplicated, so a caller can unwind its side effect', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    const first = led.append(entry(1, { idempotencyKey: 'replayed' }));
    assert.equal(first.deduplicated, false, 'the write really happened');
    assert.equal(first.seq, 1);

    const again = led.append(entry(2, { idempotencyKey: 'replayed', meta: { second: true } }));
    assert.equal(again.deduplicated, true, 'a caller can finally TELL that nothing was written');
    assert.equal(again.seq, first.seq);
    assert.equal(again.hash, first.hash);
    assert.deepEqual(again.meta, { n: 1 }, 'it is the pre-existing entry, not the one just offered');
    assert.equal(led.size(), 1);

    // The flag is a property of the RESULT, never of the persisted entry.
    const raw = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
    assert.equal(raw.includes('deduplicated'), false, 'the flag must never reach the hashed line');
    assert.deepEqual(led.verify(), { ok: true });
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FIX B4: invariants() catches negative cash/inventory, which verify() cannot see', () => {
  const dir = tmp();
  const led = open(dir);
  try {
    assert.deepEqual(led.invariants(), { ok: true, violations: [] });

    // A SALE relieving stock that a deduplicated BUY never booked. Every leg
    // balances to 0, so the hash chain is perfectly happy with it.
    led.append({
      tick: 1,
      type: 'SALE',
      agentId: 'seller-1',
      currency: 'SAR',
      legs: [
        { account: 'cogs', amount: 500 },
        { account: 'inventory', amount: -500 },
      ],
      idempotencyKey: 'sale-without-a-buy',
      meta: {},
    });
    assert.deepEqual(led.verify(), { ok: true }, 'the chain is intact — this is exactly the blind spot');
    const inv = led.invariants();
    assert.equal(inv.ok, false);
    assert.deepEqual(inv.violations, [{ account: 'inventory', balanceMinor: -500 }]);

    // Cash is guarded the same way, and both are reported at once.
    led.append({
      tick: 2,
      type: 'FEE',
      agentId: 'seller-1',
      currency: 'SAR',
      legs: [
        { account: 'fees', amount: 700 },
        { account: 'cash', amount: -700 },
      ],
      idempotencyKey: 'fee-1',
      meta: {},
    });
    assert.deepEqual(
      led.invariants().violations.map((v) => v.account).sort(),
      ['cash', 'inventory'],
    );

    // Putting the stock back clears it.
    led.append({
      tick: 3,
      type: 'BUY',
      agentId: 'scout-1',
      currency: 'SAR',
      legs: [
        { account: 'inventory', amount: 500 },
        { account: 'cash', amount: -500 },
      ],
      idempotencyKey: 'late-buy',
      meta: {},
    });
    assert.equal(led.invariants().violations.some((v) => v.account === 'inventory'), false);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
