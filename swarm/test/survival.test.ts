/**
 * test/survival.test.ts — the termination rule and its two guards. Immaturity
 * must be absolute immunity, a passing window must clear probation, evaluating
 * twice inside one window must not count twice, and stripping the guards must
 * restore the literal zero-tolerance behaviour. Real Ledger, TestClock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SurvivalEvaluator } from '../src/governance/survival.js';
import { Ledger } from '../src/core/ledger.js';
import { TestClock } from '../src/core/clock.js';
import { nullLogger } from '../src/core/logger.js';
import { loadConfig, type AresConfig, type Env } from '../src/core/config.js';
import type { StrategyOutcome } from '../src/core/types.js';

interface Harness {
  cfg: AresConfig;
  ledger: Ledger;
  ev: SurvivalEvaluator;
  /** Move `amount` minor units of cash for `agent` at `tick` (sign = direction). */
  post(agent: string, tick: number, amount: number): void;
  samples(agent: string, n: number, tick?: number): void;
  close(): void;
}

function harness(env: Env = {}, mutate: (c: AresConfig) => AresConfig = (c) => c): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ares-survival-'));
  const cfg = mutate(loadConfig({ ARES_DATA_DIR: dir, ...env }));
  const clock = new TestClock(1_000);
  const ledger = Ledger.open(dir, clock, nullLogger);
  const ev = new SurvivalEvaluator(cfg, ledger, nullLogger);
  let seq = 0;
  return {
    cfg,
    ledger,
    ev,
    post(agent, tick, amount): void {
      seq++;
      ledger.append({
        tick,
        type: amount >= 0 ? 'SALE' : 'BUY',
        agentId: agent,
        currency: 'SAR',
        legs: [
          { account: 'cash', amount },
          { account: 'equity', amount: -amount },
        ],
        idempotencyKey: `k${seq}`,
        meta: {},
      });
    },
    samples(agent, n, tick = 0): void {
      for (let i = 0; i < n; i++) ev.record(outcome(agent, tick));
    },
    close(): void {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function outcome(agentId: string, tick: number, netMinor = 0): StrategyOutcome {
  return { strategyId: 'strat-a', agentId, tick, netMinor, success: netMinor >= 0, meta: {} };
}

/** Grace and sample floor removed via env; windowTicks stays at the default 20. */
const NO_GRACE: Env = { ARES_GRACE_WINDOWS: '0', ARES_MIN_SAMPLES: '1' };

test('an IMMATURE agent can never be terminated, however badly it loses', () => {
  const h = harness();
  try {
    h.samples('scout-1', 20);
    for (const t of [0, 20, 40, 60]) h.post('scout-1', t, -9_000);
    assert.equal(h.ev.evaluate('scout-1', 0).verdict, 'IMMATURE', 'window 1 of grace 2');
    assert.equal(h.ev.evaluate('scout-1', 20).verdict, 'IMMATURE', 'window 2 of grace 2');
    const third = h.ev.evaluate('scout-1', 40);
    assert.equal(third.verdict, 'PROBATION', 'grace is over');
    assert.equal(third.windows, 3);
    assert.equal(third.netMinor, -9_000);
    assert.equal(h.ev.evaluate('scout-1', 60).verdict, 'TERMINATE');
  } finally {
    h.close();
  }
});

test('too few samples keeps the verdict IMMATURE even after the grace period', () => {
  const h = harness({ ARES_GRACE_WINDOWS: '0' }); // minSamples stays 8
  try {
    h.samples('scout-1', 7);
    h.post('scout-1', 0, -5_000);
    h.post('scout-1', 20, -5_000);
    const a = h.ev.evaluate('scout-1', 0);
    assert.equal(a.verdict, 'IMMATURE');
    assert.equal(a.samples, 7);
    assert.match(a.reason, /sample/);

    h.samples('scout-1', 1, 20);
    assert.equal(h.ev.evaluate('scout-1', 20).verdict, 'PROBATION', '8 samples is the statistical floor');
  } finally {
    h.close();
  }
});

test('a mature window at or above the benchmark PASSES', () => {
  const h = harness(NO_GRACE);
  try {
    h.samples('scout-1', 4);
    h.post('scout-1', 3, 1_200);
    const r = h.ev.evaluate('scout-1', 3);
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.netMinor, 1_200);
    assert.equal(r.windows, 1);
  } finally {
    h.close();
  }
});

test('a benchmark above zero is enforced exactly', () => {
  const h = harness({ ...NO_GRACE, ARES_MIN_NET: '500' });
  try {
    h.samples('a', 4);
    h.post('a', 0, 499);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'PROBATION');
    h.post('a', 20, 500);
    assert.equal(h.ev.evaluate('a', 20).verdict, 'PASS');
  } finally {
    h.close();
  }
});

test('consecutive failing mature windows escalate PROBATION -> TERMINATE', () => {
  const h = harness(NO_GRACE);
  try {
    h.samples('a', 4);
    h.post('a', 0, -100);
    h.post('a', 20, -100);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'PROBATION');
    const t = h.ev.evaluate('a', 21).verdict;
    assert.equal(t, 'TERMINATE');
    assert.equal(h.ev.state('a')?.failStreak, 2);
  } finally {
    h.close();
  }
});

test('a passing window resets the probation counter to zero', () => {
  const h = harness(NO_GRACE);
  try {
    h.samples('a', 4);
    h.post('a', 0, -100); // window 0 fails
    h.post('a', 20, 900); // window 1 passes
    h.post('a', 40, -100); // window 2 fails again
    assert.equal(h.ev.evaluate('a', 0).verdict, 'PROBATION');
    assert.equal(h.ev.evaluate('a', 20).verdict, 'PASS');
    assert.equal(h.ev.state('a')?.failStreak, 0, 'the streak was cleared');
    assert.equal(h.ev.evaluate('a', 40).verdict, 'PROBATION', 'not TERMINATE: the streak restarted');
  } finally {
    h.close();
  }
});

test('evaluate() is idempotent inside one window and cannot double-count', () => {
  const h = harness(NO_GRACE);
  try {
    h.samples('a', 4);
    h.post('a', 0, -100);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'PROBATION');
    for (const t of [0, 1, 7, 19]) {
      assert.equal(h.ev.evaluate('a', t).verdict, 'PROBATION', `tick ${t} is the same window`);
    }
    assert.equal(h.ev.state('a')?.failStreak, 1, 'one window, one count');
    h.post('a', 20, -100);
    assert.equal(h.ev.evaluate('a', 20).verdict, 'TERMINATE', 'the NEXT window escalates');
  } finally {
    h.close();
  }
});

test('zero grace and zero minSamples restore the literal zero-tolerance rule', () => {
  // loadConfig enforces ARES_MIN_SAMPLES >= 1, so the guard-free configuration
  // is built directly — it is exactly what the operator asked for.
  const h = harness({}, (c) => ({ ...c, survival: { ...c.survival, graceWindows: 0, minSamples: 0 } }));
  try {
    assert.equal(h.cfg.survival.graceWindows, 0);
    assert.equal(h.cfg.survival.minSamples, 0);
    h.post('a', 0, -1); // one halala down, no samples recorded at all
    const first = h.ev.evaluate('a', 0);
    assert.equal(first.verdict, 'PROBATION', 'judged immediately, with no evidence and no grace');
    assert.equal(first.samples, 0);
    assert.equal(first.windows, 1);
    h.post('a', 20, -1);
    assert.equal(h.ev.evaluate('a', 20).verdict, 'TERMINATE');
  } finally {
    h.close();
  }
});

test('net is scoped to the agent and to the window', () => {
  const h = harness(NO_GRACE);
  try {
    h.samples('a', 4);
    h.post('b', 0, -50_000); // another agent's disaster
    h.post('a', 19, 700); // inside window 0
    h.post('a', 20, -900); // window 1
    const w0 = h.ev.evaluate('a', 0);
    assert.equal(w0.netMinor, 700);
    assert.equal(w0.verdict, 'PASS');
    const w1 = h.ev.evaluate('a', 25);
    assert.equal(w1.netMinor, -900);
    assert.equal(w1.verdict, 'PROBATION');
  } finally {
    h.close();
  }
});

test('reset() clears one agent for respawn', () => {
  const h = harness(NO_GRACE);
  try {
    h.samples('a', 4);
    h.post('a', 0, -100);
    h.post('a', 20, -100);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'PROBATION');
    assert.equal(h.ev.evaluate('a', 20).verdict, 'TERMINATE');

    h.ev.reset('a');
    assert.equal(h.ev.state('a'), null);
    h.samples('a', 4, 20);
    const after = h.ev.evaluate('a', 20);
    assert.equal(after.verdict, 'PROBATION', 'history is gone, the streak restarts');
    assert.equal(after.windows, 1);
  } finally {
    h.close();
  }
});

test('record() keeps a bounded outcome ring but an unbounded sample count', () => {
  const h = harness(NO_GRACE);
  try {
    for (let i = 0; i < 250; i++) h.ev.record(outcome('a', i, i % 2 === 0 ? 10 : -10));
    const st = h.ev.state('a');
    assert.equal(st?.samples, 250);
    assert.equal(st?.successes, 125);
    assert.equal(h.ev.outcomes('a').length, 200);
    assert.equal(h.ev.outcomes('a', 3).length, 3);
    assert.deepEqual(h.ev.agents(), ['a']);
    assert.throws(() => h.ev.record({ ...outcome('', 1) }), TypeError);
  } finally {
    h.close();
  }
});

test('an unseen agent evaluates cleanly instead of throwing', () => {
  const h = harness();
  try {
    const r = h.ev.evaluate('never-seen', 5);
    assert.equal(r.verdict, 'IMMATURE');
    assert.equal(r.samples, 0);
    assert.equal(r.netMinor, 0);
  } finally {
    h.close();
  }
});
