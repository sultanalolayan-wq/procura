/**
 * test/survival.test.ts — the termination rule and its two guards. Immaturity
 * must be absolute immunity, a passing window must clear probation, evaluating
 * twice inside one window (or revisiting an earlier one) must not count twice,
 * and stripping the guards must restore the literal zero-tolerance behaviour.
 * Real Ledger, TestClock.
 *
 * DELIBERATE AMENDMENT (A1). Every verdict here is now driven by RECORDED
 * OUTCOMES rather than by ledger cash movement, because the rule is. The
 * harness's `realise()` does both — it records the outcome AND posts the
 * matching cash leg — so the assertions below are as strong as they were, while
 * `post()` survives for the cases that must prove cash movement ALONE decides
 * nothing. The old harness could only post cash, which is exactly the metric the
 * council proved inverts the rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SurvivalEvaluator, type SurvivalFactStore } from '../src/governance/survival.js';
import { Ledger } from '../src/core/ledger.js';
import { TestClock } from '../src/core/clock.js';
import { nullLogger } from '../src/core/logger.js';
import { loadConfig, type AresConfig, type Env } from '../src/core/config.js';
import type { StrategyOutcome } from '../src/core/types.js';

interface Harness {
  cfg: AresConfig;
  ledger: Ledger;
  ev: SurvivalEvaluator;
  /** Move `amount` minor units of cash for `agent` at `tick`. Cash ONLY. */
  post(agent: string, tick: number, amount: number): void;
  /** A REALISED result: recorded as an outcome and posted to the ledger. */
  realise(agent: string, tick: number, net: number): void;
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
  const post = (agent: string, tick: number, amount: number): void => {
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
  };
  return {
    cfg,
    ledger,
    ev,
    post,
    realise(agent, tick, net): void {
      ev.record(outcome(agent, tick, net));
      if (net !== 0) post(agent, tick, net);
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
    for (const t of [0, 20, 40, 60]) h.realise('scout-1', t, -9_000);
    assert.equal(h.ev.evaluate('scout-1', 0).verdict, 'IMMATURE', 'window 1 of grace 2');
    assert.equal(h.ev.evaluate('scout-1', 20).verdict, 'IMMATURE', 'window 2 of grace 2');
    const third = h.ev.evaluate('scout-1', 40);
    assert.equal(third.verdict, 'PROBATION', 'grace is over');
    assert.equal(third.windows, 3);
    assert.equal(third.judgedNetMinor, -9_000);
    assert.equal(h.ev.evaluate('scout-1', 60).verdict, 'TERMINATE');
  } finally {
    h.close();
  }
});

test('too few samples keeps the verdict IMMATURE even after the grace period', () => {
  const h = harness({ ARES_GRACE_WINDOWS: '0' }); // minSamples stays 8
  try {
    h.samples('scout-1', 5);
    h.realise('scout-1', 0, -5_000); // the 6th sample
    h.realise('scout-1', 20, -5_000); // the 7th
    const a = h.ev.evaluate('scout-1', 0);
    assert.equal(a.verdict, 'IMMATURE');
    assert.equal(a.samples, 7, 'seven samples, one short of the floor of 8');
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
    h.realise('scout-1', 3, 1_200);
    const r = h.ev.evaluate('scout-1', 3);
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.judgedNetMinor, 1_200);
    assert.equal(r.windowSamples, 5, 'four zero-net samples plus the realised gain');
    assert.equal(r.windows, 1);
  } finally {
    h.close();
  }
});

test('a benchmark above zero is enforced exactly', () => {
  const h = harness({ ...NO_GRACE, ARES_MIN_NET: '500' });
  try {
    h.samples('a', 4);
    h.realise('a', 0, 499);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'PROBATION');
    h.realise('a', 20, 500);
    assert.equal(h.ev.evaluate('a', 20).verdict, 'PASS');
  } finally {
    h.close();
  }
});

test('consecutive failing mature windows escalate PROBATION -> TERMINATE', () => {
  const h = harness(NO_GRACE);
  try {
    h.samples('a', 4);
    h.realise('a', 0, -100);
    h.realise('a', 20, -100);
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
    h.realise('a', 0, -100); // window 0 fails
    h.realise('a', 20, 900); // window 1 passes
    h.realise('a', 40, -100); // window 2 fails again
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
    h.realise('a', 0, -100);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'PROBATION');
    for (const t of [0, 1, 7, 19]) {
      assert.equal(h.ev.evaluate('a', t).verdict, 'PROBATION', `tick ${t} is the same window`);
    }
    assert.equal(h.ev.state('a')?.failStreak, 1, 'one window, one count');
    h.realise('a', 20, -100);
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
    h.realise('a', 0, -1); // one halala down, on one realised trade
    const first = h.ev.evaluate('a', 0);
    assert.equal(first.verdict, 'PROBATION', 'judged immediately, with the bare minimum of evidence');
    assert.equal(first.samples, 1);
    assert.equal(first.windows, 1);
    h.realise('a', 20, -1);
    assert.equal(h.ev.evaluate('a', 20).verdict, 'TERMINATE');
  } finally {
    h.close();
  }
});

test('net is scoped to the agent and to the window', () => {
  const h = harness(NO_GRACE);
  try {
    h.samples('a', 4);
    h.realise('b', 0, -50_000); // another agent's disaster
    h.realise('a', 19, 700); // inside window 0
    h.realise('a', 20, -900); // window 1
    const w0 = h.ev.evaluate('a', 0);
    assert.equal(w0.judgedNetMinor, 700);
    assert.equal(w0.verdict, 'PASS');
    const w1 = h.ev.evaluate('a', 25);
    assert.equal(w1.judgedNetMinor, -900);
    assert.equal(w1.verdict, 'PROBATION');
  } finally {
    h.close();
  }
});

test('reset() clears one agent for respawn', () => {
  const h = harness(NO_GRACE);
  try {
    h.samples('a', 4);
    h.realise('a', 0, -100);
    h.realise('a', 20, -100);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'PROBATION');
    assert.equal(h.ev.evaluate('a', 20).verdict, 'TERMINATE');

    h.ev.reset('a');
    assert.equal(h.ev.state('a'), null);
    h.samples('a', 4, 20);
    h.realise('a', 20, -100);
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
    assert.equal(r.judgedNetMinor, 0);
    assert.equal(r.cashFlowMinor, 0);
  } finally {
    h.close();
  }
});

/* ------------------------------ AMENDMENT A2: the probationWindows -> streak map */

test('probationWindows=0 TERMINATES on the very first failing mature window', () => {
  const h = harness({ ...NO_GRACE, ARES_PROBATION_WINDOWS: '0' });
  try {
    assert.equal(h.cfg.survival.probationWindows, 0);
    h.samples('a', 4);
    h.realise('a', 0, -1); // a single halala down is a failing window
    const first = h.ev.evaluate('a', 0);
    assert.equal(first.verdict, 'TERMINATE', 'zero tolerance: no warning step at all');
    assert.equal(h.ev.state('a')?.failStreak, 1);
    assert.match(first.reason, /probationWindows=0/);
  } finally {
    h.close();
  }
});

test('probationWindows=0 still cannot terminate an IMMATURE agent', () => {
  // The grace guard is orthogonal to the probation mapping: cold-start immunity
  // must survive the harshest possible probation setting.
  const h = harness({ ARES_PROBATION_WINDOWS: '0' });
  try {
    h.samples('a', 20);
    for (const t of [0, 20, 40]) h.realise('a', t, -9_000);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'IMMATURE');
    assert.equal(h.ev.evaluate('a', 20).verdict, 'IMMATURE');
    assert.equal(h.ev.evaluate('a', 40).verdict, 'TERMINATE', 'fatal only once mature');
  } finally {
    h.close();
  }
});

test('probationWindows=1 keeps the documented warn-then-terminate behaviour', () => {
  const h = harness({ ...NO_GRACE, ARES_PROBATION_WINDOWS: '1' });
  try {
    h.samples('a', 4);
    h.realise('a', 0, -100);
    h.realise('a', 20, -100);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'PROBATION');
    assert.equal(h.ev.evaluate('a', 20).verdict, 'TERMINATE');
  } finally {
    h.close();
  }
});

test('probationWindows=2 tolerates two failing windows before terminating', () => {
  const h = harness({ ...NO_GRACE, ARES_PROBATION_WINDOWS: '2' });
  try {
    h.samples('a', 4);
    h.realise('a', 0, -100);
    h.realise('a', 20, -100);
    h.realise('a', 40, -100);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'PROBATION');
    assert.equal(h.ev.evaluate('a', 20).verdict, 'PROBATION');
    assert.equal(h.ev.evaluate('a', 40).verdict, 'TERMINATE');
    assert.equal(h.ev.state('a')?.failStreak, 3);
  } finally {
    h.close();
  }
});

test('a passing window clears the streak even under probationWindows=0', () => {
  const h = harness({ ...NO_GRACE, ARES_PROBATION_WINDOWS: '0' });
  try {
    h.samples('a', 4);
    h.realise('a', 0, 500);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'PASS');
    assert.equal(h.ev.state('a')?.failStreak, 0);
  } finally {
    h.close();
  }
});

/* ========================= AMENDMENT A1: the headline defect ==================
 * Both observed behaviours from the orchestrator's 304-tick run, reproduced
 * directly and asserted not to happen any more.
 * ========================================================================== */

test('A1a: the PROFITABLE seller is NOT terminated for a fee-only losing window', () => {
  // seller-1, verbatim from the run: lifetime +26,237 realised, executed for a
  // window net of -50. The cash legs are the seller's: positive on every sale,
  // negative on every listing fee, and never once carrying the cost of goods.
  const h = harness({ ...NO_GRACE, ARES_WINDOW_TICKS: '8', ARES_PROBATION_WINDOWS: '1' });
  try {
    // Windows 0 and 1: real, profitable trading.
    h.realise('seller-1', 1, 13_000);
    h.realise('seller-1', 9, 13_287);
    assert.equal(h.ev.evaluate('seller-1', 7).verdict, 'PASS');
    assert.equal(h.ev.evaluate('seller-1', 15).verdict, 'PASS');

    // Window 2: nothing settled, three listing fees went out. Under the old rule
    // this was "net -75 below benchmark 0" and the second such window was fatal.
    for (const t of [16, 18, 20]) h.post('seller-1', t, -25);
    const w2 = h.ev.evaluate('seller-1', 23);
    assert.equal(w2.cashFlowMinor, -75, 'the cash DID go out, and it is still reported');
    assert.equal(w2.judgedNetMinor, 0, 'but no realised outcome was recorded');
    assert.equal(w2.verdict, 'UNJUDGED', 'fee noise in an idle window is not a verdict');

    // Window 3: same again. Two consecutive such windows used to be a killing.
    for (const t of [24, 26]) h.post('seller-1', t, -25);
    const w3 = h.ev.evaluate('seller-1', 31);
    assert.equal(w3.verdict, 'UNJUDGED');
    assert.equal(h.ev.state('seller-1')?.failStreak, 0, 'no streak was ever built out of fees');

    // Window 4: a small realised LOSS is a real, judged failure — once.
    h.realise('seller-1', 33, -50);
    assert.equal(h.ev.evaluate('seller-1', 39).verdict, 'PROBATION');

    // And the agent that is up 26,237 over its life is still alive.
    const st = h.ev.state('seller-1');
    assert.equal(st?.failStreak, 1);
    assert.ok(st !== null);
  } finally {
    h.close();
  }
});

test('A1a: the LOSS-MAKING scout is judged on its losses, not on its cash leg', () => {
  // scout-1, verbatim: -13,544 realised over the run, verdict PASS. Its cash leg
  // is negative on every purchase, so cash flow condemned it in every window it
  // traded and let it off in every window it did not. Neither is performance.
  const h = harness({ ...NO_GRACE, ARES_WINDOW_TICKS: '8', ARES_PROBATION_WINDOWS: '1' });
  try {
    // A window in which the scout bought (cash out) and the round trips lost.
    h.post('scout-1', 1, -4_000); // the purchase leg
    h.realise('scout-1', 6, -6_772); // what the round trip actually realised
    const w0 = h.ev.evaluate('scout-1', 7);
    assert.equal(w0.judgedNetMinor, -6_772);
    assert.equal(w0.verdict, 'PROBATION', 'a real loss is a real failure');

    h.realise('scout-1', 14, -6_772);
    assert.equal(h.ev.evaluate('scout-1', 15).verdict, 'TERMINATE', 'the loss-maker dies');
  } finally {
    h.close();
  }
});

test('A1a: a PROFITABLE round trip passes even though its cash leg is negative', () => {
  // The structural case the CTO called out: a buyer whose every cash leg is a
  // debit, but whose realised margin is positive, must PASS.
  const h = harness(NO_GRACE);
  try {
    h.ev.record(outcome('scout-2', 4, 2_400)); // realised +2,400
    h.post('scout-2', 4, -8_000); // ...on 8,000 of purchases in the same window
    const r = h.ev.evaluate('scout-2', 4);
    assert.equal(r.cashFlowMinor, -8_000, 'the old metric would have condemned it');
    assert.equal(r.judgedNetMinor, 2_400);
    assert.equal(r.verdict, 'PASS');
  } finally {
    h.close();
  }
});

test('A1b: an IDLE agent accumulates no passes and cannot clear a probation streak', () => {
  const h = harness({ ...NO_GRACE, ARES_PROBATION_WINDOWS: '1' });
  try {
    // One real failing window: on probation, streak 1.
    h.realise('idler', 0, -300);
    assert.equal(h.ev.evaluate('idler', 0).verdict, 'PROBATION');
    assert.equal(h.ev.state('idler')?.failStreak, 1);

    // Then it simply stops working. Five silent windows.
    for (const t of [20, 40, 60, 80, 100]) {
      const r = h.ev.evaluate('idler', t);
      assert.equal(r.verdict, 'UNJUDGED', `window at tick ${t} has no activity to judge`);
      assert.equal(r.judgedNetMinor, 0);
      assert.equal(r.windowSamples, 0);
      assert.match(r.reason, /idle window is not a pass/);
    }
    assert.equal(h.ev.state('idler')?.failStreak, 1, 'doing nothing neither cleared nor grew the streak');

    // The moment it trades and loses again, the streak resumes and is fatal.
    h.realise('idler', 120, -300);
    assert.equal(h.ev.evaluate('idler', 120).verdict, 'TERMINATE');
  } finally {
    h.close();
  }
});

test('A1b: an idle window is UNJUDGED even with every guard stripped off', () => {
  const h = harness({}, (c) => ({ ...c, survival: { ...c.survival, graceWindows: 0, minSamples: 0 } }));
  try {
    const r = h.ev.evaluate('ghost', 0);
    assert.equal(r.verdict, 'UNJUDGED', 'zero tolerance still has nothing to be intolerant OF');
    assert.notEqual(r.verdict, 'PASS', 'and above all it is not a pass');
  } finally {
    h.close();
  }
});

/* ===================== AMENDMENT A3: re-evaluating an earlier window ========= */

test('A3: re-evaluating an EARLIER window does not decide it a second time', () => {
  // evaluate(w0), evaluate(w1), evaluate(w0) used to increment the streak three
  // times, because the lock was a single scalar holding only the latest window.
  const h = harness({ ...NO_GRACE, ARES_PROBATION_WINDOWS: '3' });
  try {
    h.realise('a', 0, -100); // window 0
    h.realise('a', 20, -100); // window 1

    assert.equal(h.ev.evaluate('a', 0).verdict, 'PROBATION');
    assert.equal(h.ev.state('a')?.failStreak, 1);
    assert.equal(h.ev.evaluate('a', 20).verdict, 'PROBATION');
    assert.equal(h.ev.state('a')?.failStreak, 2);

    // Back to window 0. It has already been decided; it must not count again.
    const again = h.ev.evaluate('a', 0);
    assert.equal(again.verdict, 'PROBATION');
    assert.equal(h.ev.state('a')?.failStreak, 2, 'still two: window 0 was decided once');

    // ...and repeatedly, in any order.
    for (const t of [0, 20, 5, 25, 0]) h.ev.evaluate('a', t);
    assert.equal(h.ev.state('a')?.failStreak, 2, 'two windows, two counts, whatever the call order');
  } finally {
    h.close();
  }
});

test('A3: an old verdict is reported unchanged while live figures stay current', () => {
  const h = harness(NO_GRACE);
  try {
    h.realise('a', 0, -100);
    const first = h.ev.evaluate('a', 0);
    assert.equal(first.verdict, 'PROBATION');
    // More activity lands in window 0 AFTER it was decided (a late settlement).
    h.realise('a', 5, 5_000);
    const revisit = h.ev.evaluate('a', 5);
    assert.equal(revisit.verdict, 'PROBATION', 'the verdict is locked');
    assert.equal(revisit.reason, first.reason, 'including its reason');
    assert.equal(revisit.judgedNetMinor, 4_900, 'while the live figure is up to date');
  } finally {
    h.close();
  }
});

/* ============ AMENDMENT A4: survival state survives a process restart ======== */

/** A MemoryStore-shaped fact store, in memory, shared across "boots". */
function factStore(): SurvivalFactStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    getFact<T>(k: string, d: T): T {
      return (k in data ? (data[k] as T) : d);
    },
    setFact(k: string, v: unknown): void {
      data[k] = JSON.parse(JSON.stringify(v)) as unknown;
    },
    flush(): void {
      /* nothing to sync in memory */
    },
  };
}

test('A4: a restart does NOT re-arm the grace period or wipe the probation streak', () => {
  const h = harness({ ARES_MIN_SAMPLES: '1' }); // graceWindows stays at 2
  const store = factStore();
  try {
    // --- run 1: three windows of real losses. Two are immune, the third bites.
    h.ev.attachMemory(store, 'run-1');
    for (const t of [0, 20, 40]) h.realise('a', t, -500);
    assert.equal(h.ev.evaluate('a', 0).verdict, 'IMMATURE');
    assert.equal(h.ev.evaluate('a', 20).verdict, 'IMMATURE');
    assert.equal(h.ev.evaluate('a', 40).verdict, 'PROBATION', 'grace exhausted, streak 1');
    assert.equal(h.ev.state('a')?.failStreak, 1);
    assert.ok(Object.keys(store.data).length > 0, 'the row was written through');

    // --- run 2: a brand new process. Ticks restart at 0, as they really do.
    const fresh = new SurvivalEvaluator(h.cfg, h.ledger, nullLogger);
    fresh.attachMemory(store, 'run-2');
    const restored = fresh.state('a');
    assert.ok(restored);
    assert.equal(restored.failStreak, 1, 'the streak survived the restart');
    assert.equal(restored.samples, 3, 'and so did the evidence count');
    assert.equal(restored.windows, 3, 'and the windows already elapsed');

    // The very first window of the new run is therefore MATURE, not immune.
    fresh.record({ strategyId: 's', agentId: 'a', tick: 0, netMinor: -500, success: false, meta: {} });
    const first = fresh.evaluate('a', 0);
    assert.notEqual(first.verdict, 'IMMATURE', 'a restart must not hand out fresh immunity');
    assert.equal(first.verdict, 'TERMINATE', 'streak 1 carried in, streak 2 is fatal');
  } finally {
    h.close();
  }
});

test('A4: rehydration ignores rows this same run wrote, and reset() clears them', () => {
  const h = harness(NO_GRACE);
  const store = factStore();
  try {
    h.ev.attachMemory(store, 'run-1');
    h.realise('a', 0, -100);
    h.ev.evaluate('a', 0);
    assert.equal(h.ev.state('a')?.failStreak, 1);

    // Re-attaching the SAME run must not double-count the row back onto itself.
    h.ev.attachMemory(store, 'run-1');
    assert.equal(h.ev.state('a')?.failStreak, 1);
    assert.equal(h.ev.state('a')?.samples, 1);

    // A respawn wipes the row in the store too, so the heir is genuinely new.
    h.ev.reset('a');
    const fresh = new SurvivalEvaluator(h.cfg, h.ledger, nullLogger);
    fresh.attachMemory(store, 'run-2');
    assert.equal(fresh.state('a'), null, 'reset() is durable, not just in-process');
  } finally {
    h.close();
  }
});

test('A4: the judged metric never merges tick ranges across runs', () => {
  // The ledger persists and ticks restart at 0, so netCashFlow(w*T, ...) can
  // match a PREVIOUS run's entries. The judged number cannot: realised outcomes
  // are per-run and are not carried over.
  const h = harness(NO_GRACE);
  const store = factStore();
  try {
    h.ev.attachMemory(store, 'run-1');
    h.post('a', 3, -20_000); // last run's catastrophe, still in the ledger
    h.ev.record(outcome('a', 3, -20_000));
    h.ev.evaluate('a', 3);

    const fresh = new SurvivalEvaluator(h.cfg, h.ledger, nullLogger);
    fresh.attachMemory(store, 'run-2');
    fresh.record(outcome('a', 3, 400)); // this run: a modest profit at tick 3
    const r = fresh.evaluate('a', 3);
    assert.equal(r.cashFlowMinor, -20_000, 'the ledger range DOES straddle both runs');
    assert.equal(r.judgedNetMinor, 400, 'the judged number does not');
    assert.equal(r.verdict, 'PASS', 'and the verdict follows the judged number');
  } finally {
    h.close();
  }
});
