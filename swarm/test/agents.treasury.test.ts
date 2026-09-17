/**
 * test/agents.treasury.test.ts — the auditor. Pins: a tampered ledger latches
 * the kill switch; a drawdown breach halts; survival is judged on WINDOW
 * BOUNDARIES against the window that just completed; PROBATION halves caps;
 * TERMINATE runs the whole terminate -> reallocate -> respawn cycle with the
 * postmortem carried forward; and the treasury is exempt from all of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { LedgerEntry } from '../src/core/ledger.js';
import type { AgentId } from '../src/core/types.js';
import { BaseAgent, type AgentDeps } from '../src/agents/base.js';
import { AgentRegistry } from '../src/agents/registry.js';
import { TreasuryAgent, MAX_CATCHUP_WINDOWS } from '../src/agents/treasury.js';
import { makeStack, type Stack } from './agents.harness.js';

/** An agent that loses a fixed amount every tick and says so. */
class Loser extends BaseAgent {
  lossPerTick = 100;
  constructor(id: AgentId, strategyId: string, deps: AgentDeps) {
    super(id, 'scout', strategyId, deps);
  }
  override async onTick(tick: number): Promise<void> {
    this.deps.ledger.append({
      tick,
      type: 'LOSS',
      agentId: this.id,
      currency: 'SAR',
      legs: [
        { account: 'cash', amount: -this.lossPerTick },
        { account: 'writeoff', amount: this.lossPerTick },
      ],
      idempotencyKey: `loss-${this.id}-${tick}`,
      meta: {},
    });
    this.learn({
      strategyId: this.strategyId,
      agentId: this.id,
      tick,
      netMinor: -this.lossPerTick,
      success: false,
      meta: { kind: 'trade' },
    });
  }
}

/** An agent that earns a little every tick. */
class Winner extends BaseAgent {
  constructor(id: AgentId, strategyId: string, deps: AgentDeps) {
    super(id, 'scout', strategyId, deps);
  }
  override async onTick(tick: number): Promise<void> {
    this.deps.ledger.append({
      tick,
      type: 'GAIN',
      agentId: this.id,
      currency: 'SAR',
      legs: [
        { account: 'cash', amount: 200 },
        { account: 'revenue', amount: -200 },
      ],
      idempotencyKey: `gain-${this.id}-${tick}`,
      meta: {},
    });
    this.learn({ strategyId: this.strategyId, agentId: this.id, tick, netMinor: 200, success: true, meta: { kind: 'trade' } });
  }
}

const HARSH = {
  ARES_WINDOW_TICKS: '5',
  ARES_GRACE_WINDOWS: '0',
  ARES_MIN_SAMPLES: '1',
};

interface Wired {
  s: Stack;
  reg: AgentRegistry;
  treasury: TreasuryAgent;
}

async function wire(env: Record<string, string> = {}, opts: { strategies?: string[] } = {}): Promise<Wired> {
  const s = await makeStack({ ...HARSH, ...env }, { channels: [] });
  const reg = s.registry;
  reg.registerStrategies(
    'scout',
    opts.strategies ?? ['alpha', 'beta', 'gamma'],
    (id, strat, deps) => new Loser(id, strat, deps),
  );
  const treasury = new TreasuryAgent('treasury-1', 'auditor', s.depsFor('treasury-1'), {
    registry: reg,
    depsFor: (id) => s.depsFor(id),
  });
  reg.register(treasury);
  return { s, reg, treasury };
}

/* ------------------------------------------------------------- integrity */

test('a tampered ledger trips the kill switch and halts the swarm', async () => {
  const { s, treasury } = await wire();
  try {
    for (let i = 0; i < 3; i++) {
      s.ledger.append({
        tick: i,
        type: 'SALE',
        agentId: 'scout-x',
        currency: 'SAR',
        legs: [
          { account: 'cash', amount: 100 },
          { account: 'revenue', amount: -100 },
        ],
        idempotencyKey: `k${i}`,
        meta: {},
      });
    }
    assert.equal(s.ledger.verify().ok, true);
    await treasury.runTick(1);
    assert.equal(s.killSwitch.tripped, false, 'a healthy chain is left alone');

    // Rewrite history in place. `private` is erased at runtime, so this is
    // exactly what an operator with a debugger (or a bug) could do.
    const rows = (s.ledger as unknown as { rows: LedgerEntry[] }).rows;
    const victim = rows[2];
    assert.ok(victim);
    victim.legs[0]!.amount = 999_999;
    assert.equal(s.ledger.verify().ok, false);

    await treasury.runTick(2);
    assert.equal(s.killSwitch.tripped, true);
    assert.match(String(s.killSwitch.reason), /hash chain broken at seq/);
    assert.equal(treasury.crashes, 1, 'the violation is recorded as the fault it is');

    await s.bus.drain();
    const halt = s.of('HALT')[0];
    assert.ok(halt);
    assert.equal((halt.payload as { source: string }).source, 'ledger_integrity');

    // The audit snapshot of the halting tick is still published.
    const audits = s.of('AUDIT_TICK');
    assert.ok(audits.length >= 2);
    const last = audits[audits.length - 1]!.payload as { halted: boolean; tick: number };
    assert.equal(last.halted, true);
    assert.equal(last.tick, 2);
  } finally {
    s.close();
  }
});

test('a drawdown breach halts the swarm and says by how much', async () => {
  const { s, treasury } = await wire({ ARES_MAX_DRAWDOWN: '5000' });
  try {
    await treasury.runTick(1);
    assert.equal(s.killSwitch.tripped, false);

    // AMENDMENT A9 — adjusted deliberately. act() now charges a modelled compute
    // cost, so the treasury's own auditing moves cash and the drawdown is no
    // longer purely the trading loss. The DELTA is what this test is about.
    const beforeLoss = s.budget.drawdownMinor();
    assert.ok(beforeLoss > 0, 'auditing the swarm costs something, and it is on the books');
    s.ledger.append({
      tick: 2,
      type: 'LOSS',
      agentId: 'scout-x',
      currency: 'SAR',
      legs: [
        { account: 'cash', amount: -5_001 },
        { account: 'writeoff', amount: 5_001 },
      ],
      idempotencyKey: 'big-loss',
      meta: {},
    });
    assert.equal(s.budget.drawdownMinor() - beforeLoss, 5_001, 'the loss itself is exact');
    const breached = s.budget.drawdownMinor();

    await treasury.runTick(2);
    assert.equal(s.killSwitch.tripped, true);
    assert.match(String(s.killSwitch.reason), /max drawdown breached: \d+ > 5000/);
    assert.ok(s.budget.drawdownMinor() >= breached);
    assert.equal(treasury.crashes, 0, 'a risk limit is enforcement, not a crash');

    await s.bus.drain();
    const halt = s.of('HALT')[0];
    assert.ok(halt);
    assert.equal((halt.payload as { source: string }).source, 'drawdown');
    assert.ok((halt.payload as { drawdownMinor: number }).drawdownMinor >= breached);

    // And nothing may spend afterwards.
    assert.equal(s.budget.availableCash('treasury-1'), 0);
  } finally {
    s.close();
  }
});

/* -------------------------------------------------------- window boundaries */

test('survival is judged on window boundaries, against the window that just completed', async () => {
  const { s, reg, treasury } = await wire({ ARES_PROBATION_WINDOWS: '2' });
  try {
    const loser = new Loser('scout-w', 'alpha', s.depsFor('scout-w'));
    reg.register(loser);

    // Window 0 = ticks 0..4. Mid-window there must be NO verdict at all: judging
    // then would decide the window from its own first tick's (empty) data.
    for (let t = 0; t < 5; t++) {
      await loser.runTick(t);
      await treasury.runTick(t);
    }
    assert.equal(treasury.stats().lastJudgedWindow, -1, 'nothing judged inside window 0');
    assert.equal(s.survival.state('scout-w')?.verdict ?? null, null);

    // Tick 5 is the first tick of window 1: window 0 is complete and is judged.
    await loser.runTick(5);
    await treasury.runTick(5);
    assert.equal(treasury.stats().lastJudgedWindow, 0);
    const row = treasury.verdicts().find((v) => v.id === 'scout-w');
    assert.ok(row);
    assert.equal(row.verdict, 'PROBATION');
    assert.equal(row.netMinor, -500, 'the FULL window 0: five ticks at -100');
    // Six: five inside window 0 plus the one at tick 5 that the scout took
    // before the treasury ran. Sample counts are lifetime, net is per window.
    assert.equal(row.samples, 6);

    // The rest of window 1 must not re-judge anything.
    for (let t = 6; t < 10; t++) await treasury.runTick(t);
    assert.equal(treasury.stats().lastJudgedWindow, 0);
    assert.equal(treasury.stats().probations, 1, 'judged once per window, not once per tick');
  } finally {
    s.close();
  }
});

test('PROBATION halves the agent caps and a later PASS clears the status', async () => {
  const { s, reg, treasury } = await wire({ ARES_PROBATION_WINDOWS: '2' });
  try {
    const loser = new Loser('scout-p', 'alpha', s.depsFor('scout-p'));
    reg.register(loser);
    const before = s.budget.snapshot().agents.find((a) => a.agentId === 'scout-p');
    assert.ok(before);
    assert.equal(before.cashCapMinor, s.cfg.budget.perAgentCashCapMinor);

    for (let t = 0; t <= 5; t++) {
      await loser.runTick(t);
      await treasury.runTick(t);
    }
    assert.equal(loser.status, 'probation');
    const after = s.budget.snapshot().agents.find((a) => a.agentId === 'scout-p');
    assert.ok(after);
    assert.equal(after.cashCapMinor, Math.floor(before.cashCapMinor / 2));
    assert.equal(after.tokenCap, Math.floor(before.tokenCap / 2));

    // Window 1 turns a profit: the status clears (the caps stay tightened).
    // AMENDMENT A1 — changed deliberately. Posting cash used to be enough to
    // clear probation; it is not any more, and it should never have been. The
    // window has to contain REALISED outcomes, so the agent records them — which
    // is what "turning a profit" actually means. Note it also has to outweigh
    // the -100 the loser already realised at tick 5, inside this same window.
    for (let t = 6; t < 10; t++) {
      s.ledger.append({
        tick: t,
        type: 'GAIN',
        agentId: 'scout-p',
        currency: 'SAR',
        legs: [
          { account: 'cash', amount: 400 },
          { account: 'revenue', amount: -400 },
        ],
        idempotencyKey: `gain-p-${t}`,
        meta: {},
      });
      s.survival.record({
        strategyId: 'alpha',
        agentId: 'scout-p',
        tick: t,
        netMinor: 400,
        success: true,
        meta: { kind: 'trade' },
      });
      await treasury.runTick(t);
    }
    await treasury.runTick(10);
    assert.equal(treasury.stats().lastJudgedWindow, 1);
    assert.equal(loser.status, 'active', 'a passing window clears probation');
  } finally {
    s.close();
  }
});

/* ------------------------------------------ the whole succession, end to end */

test('TERMINATE runs the full terminate -> reallocate -> respawn cycle, postmortem included', async () => {
  const { s, reg, treasury } = await wire({ ARES_PROBATION_WINDOWS: '0' });
  try {
    const doomed = new Loser('scout-doomed', 'alpha', s.depsFor('scout-doomed'));
    const survivor = new Winner('scout-survivor', 'beta', s.depsFor('scout-survivor'));
    reg.register(doomed);
    reg.register(survivor);
    const doomedCapBefore = s.budget.snapshot().agents.find((a) => a.agentId === 'scout-doomed')!.cashCapMinor;
    const survivorCapBefore = s.budget.snapshot().agents.find((a) => a.agentId === 'scout-survivor')!.cashCapMinor;

    // Window 0: one loses, one wins.
    for (let t = 0; t < 5; t++) {
      await doomed.runTick(t);
      await survivor.runTick(t);
      await treasury.runTick(t);
    }
    // Tick 5: window 0 is judged. probationWindows=0 => the first failing mature
    // window is fatal.
    await treasury.runTick(5);
    await s.bus.drain();

    assert.equal(doomed.isTerminated, true);
    assert.equal(doomed.status, 'terminated');
    assert.equal(survivor.isTerminated, false, 'the profitable agent is untouched');
    assert.equal(treasury.stats().terminations, 1);

    // Reallocation: the dead agent's headroom went to the best survivor.
    const capsAfter = s.budget.snapshot().agents;
    const deadAfter = capsAfter.find((a) => a.agentId === 'scout-doomed')!;
    const survivorAfter = capsAfter.find((a) => a.agentId === 'scout-survivor')!;
    assert.equal(deadAfter.terminated, true);
    assert.ok(survivorAfter.cashCapMinor > survivorCapBefore, 'the survivor was topped up');
    assert.ok(deadAfter.cashCapMinor < doomedCapBefore, 'the dead agent kept nothing spendable');
    assert.equal(s.budget.availableCash('scout-doomed'), 0);

    const terminated = s.of('AGENT_TERMINATED')[0];
    assert.ok(terminated);
    const tp = terminated.payload as Record<string, unknown>;
    assert.equal(tp['agentId'], 'scout-doomed');
    assert.equal(tp['strategyId'], 'alpha');
    assert.equal(tp['reallocatedTo'], 'scout-survivor');

    // Respawn: a NEW agent on a strategy that has not already failed.
    assert.equal(treasury.stats().spawns, 1);
    const spawned = s.of('AGENT_SPAWNED')[0];
    assert.ok(spawned);
    const sp = spawned.payload as Record<string, unknown>;
    assert.equal(sp['replaces'], 'scout-doomed');
    assert.notEqual(sp['strategyId'], 'alpha');
    assert.deepEqual(sp['excluded'], ['alpha']);
    assert.equal(sp['inheritedPostmortem'], true, 'the lesson travelled with the id');

    const heir = reg.get(String(sp['agentId']));
    assert.ok(heir);
    assert.equal(heir.isTerminated, false);
    assert.notEqual(heir.strategyId, 'alpha');
    const pm = heir.lastPostmortem();
    assert.ok(pm);
    assert.match(pm.text, /scout-doomed \(scout\/alpha\) terminated/);
    assert.equal(pm.meta['inherited'], true);
    assert.deepEqual(s.depsFor(heir.id).memory.getFact<string[]>('avoidStrategies', []), ['alpha']);

    // The heir starts with a clean survival sheet and a live budget line.
    assert.equal(s.survival.state(heir.id), null);
    assert.equal(s.budget.has(heir.id), true);
    assert.ok(s.budget.availableCash(heir.id) > 0);
    assert.equal(s.ledger.verify().ok, true);

    // A second failure burns a second strategy; the exclusion list grows.
    const heirAgent = heir as Loser;
    for (let t = 6; t < 10; t++) {
      await heirAgent.runTick(t);
      await treasury.runTick(t);
    }
    await treasury.runTick(10);
    await s.bus.drain();
    assert.equal(heir.isTerminated, true);
    const second = s.of('AGENT_SPAWNED')[1];
    assert.ok(second);
    const excluded = (second.payload as { excluded: string[] }).excluded;
    assert.equal(excluded.length, 2);
    assert.ok(excluded.includes('alpha'));
    assert.ok(excluded.includes(heir.strategyId));
    assert.notEqual((second.payload as { strategyId: string }).strategyId, heir.strategyId);
  } finally {
    s.close();
  }
});

test('probationWindows=0 terminates on the FIRST failing mature window', async () => {
  const { s, reg, treasury } = await wire({ ARES_PROBATION_WINDOWS: '0' });
  try {
    assert.equal(s.cfg.survival.probationWindows, 0);
    const loser = new Loser('scout-zero', 'alpha', s.depsFor('scout-zero'));
    reg.register(loser);
    for (let t = 0; t < 5; t++) {
      await loser.runTick(t);
      await treasury.runTick(t);
    }
    assert.equal(loser.isTerminated, false, 'still inside window 0');
    await treasury.runTick(5);
    assert.equal(loser.isTerminated, true, 'no warning step at all');
    assert.equal(treasury.stats().probations, 0, 'PROBATION was never issued');
    const row = treasury.verdicts().find((v) => v.id === 'scout-zero');
    assert.equal(row?.verdict, 'TERMINATE');
  } finally {
    s.close();
  }
});

test('an exhausted strategy menu ends the succession instead of repeating a failure', async () => {
  const { s, reg, treasury } = await wire({ ARES_PROBATION_WINDOWS: '0' }, { strategies: ['alpha'] });
  try {
    const loser = new Loser('scout-last', 'alpha', s.depsFor('scout-last'));
    reg.register(loser);
    for (let t = 0; t < 5; t++) {
      await loser.runTick(t);
      await treasury.runTick(t);
    }
    await treasury.runTick(5);
    assert.equal(loser.isTerminated, true);
    assert.equal(treasury.stats().spawns, 0, 'nothing untried is left');
    assert.equal(treasury.crashes, 0, 'and that is an answer, not a crash');
  } finally {
    s.close();
  }
});

/* -------------------------------------------------------------- the exemption */

test('the treasury is exempt from survival termination, however negative its own net', async () => {
  const { s, reg, treasury } = await wire({ ARES_PROBATION_WINDOWS: '0' });
  try {
    // Give the auditor the worst possible record: pure cost, no revenue.
    for (let t = 0; t < 5; t++) {
      s.ledger.append({
        tick: t,
        type: 'TOKEN_SPEND',
        agentId: 'treasury-1',
        currency: 'SAR',
        legs: [
          { account: 'compute', amount: 300 },
          { account: 'cash', amount: -300 },
        ],
        idempotencyKey: `tok-${t}`,
        meta: {},
      });
      s.survival.record({ strategyId: 'auditor', agentId: 'treasury-1', tick: t, netMinor: -300, success: false, meta: {} });
      await treasury.runTick(t);
    }
    await treasury.runTick(5);

    assert.equal(treasury.isTerminated, false);
    assert.equal(treasury.status, 'active');
    assert.equal(reg.active().some((a) => a.id === 'treasury-1'), true);
    const row = treasury.verdicts().find((v) => v.id === 'treasury-1');
    assert.ok(row);
    assert.equal(row.verdict, 'EXEMPT');
    assert.match(row.reason, /exempt from survival termination by design/);
    // The reported figure is ledger cash flow over the window, which now also
    // carries the treasury's own modelled compute cost (amendment A9).
    const computeInWindow = s.ledger
      .entries({ agentId: 'treasury-1', type: 'TOKEN_SPEND' })
      // Only the charges act() made; the -300 legs above are this test's own.
      .filter((e) => e.tick >= 0 && e.tick <= 4 && e.meta['model'] === 'default')
      .reduce((a, e) => a + e.legs.filter((l) => l.account === 'cash').reduce((x, l) => x + l.amount, 0), 0);
    assert.ok(computeInWindow < 0, 'the auditor pays for its own compute');
    assert.equal(row.netMinor, -1_500 + computeInWindow, 'its loss is measured and reported, just not fatal');
    assert.equal(row.judgedNetMinor, -1_500, 'and what it realised is reported separately');
    // The evaluator was never even asked about it.
    assert.equal(s.survival.state('treasury-1')?.verdict ?? null, null);
  } finally {
    s.close();
  }
});

/* ------------------------------------------------------------------- audit */

test('AUDIT_TICK carries a full snapshot every tick', async () => {
  const { s, reg, treasury } = await wire();
  try {
    reg.register(new Winner('scout-a', 'alpha', s.depsFor('scout-a')));
    await treasury.runTick(3);
    await s.bus.drain();

    const audit = s.of('AUDIT_TICK')[0];
    assert.ok(audit);
    const p = audit.payload as Record<string, unknown>;
    assert.equal(p['tick'], 3);
    assert.equal(p['mode'], 'PAPER');
    assert.equal(p['halted'], false);
    assert.equal(p['maxDrawdownMinor'], s.cfg.budget.maxDrawdownMinor);
    assert.equal(p['cashOnHandMinor'], s.ledger.balanceOf('cash'));
    assert.equal(p['windowTicks'], 5);
    for (const key of ['balances', 'ledger', 'budget', 'bus', 'policy', 'agents', 'treasury']) {
      assert.ok(p[key] !== undefined, `AUDIT_TICK must carry ${key}`);
    }
    const agents = p['agents'] as Array<Record<string, unknown>>;
    assert.equal(agents.length, 2);
    const scoutRow = agents.find((a) => a['id'] === 'scout-a');
    assert.ok(scoutRow);
    assert.equal(scoutRow['verdict'], 'UNJUDGED', 'no window has completed yet');
    assert.equal(scoutRow['role'], 'scout');
    const led = p['ledger'] as { size: number; head: string };
    assert.equal(led.size, s.ledger.size());
    assert.equal(led.head, s.ledger.head());

    // Audits keep coming and the tick moves, so the loop guard never eats them.
    for (let t = 4; t < 9; t++) await treasury.runTick(t);
    await s.bus.drain();
    assert.equal(s.of('AUDIT_TICK').length, 6);
    assert.equal(s.bus.stats().dropReasons['loop_guard'] ?? 0, 0);
  } finally {
    s.close();
  }
});

test('a treasury without a depsFor factory still terminates but refuses to pretend it spawned', async () => {
  const s = await makeStack({ ...HARSH, ARES_PROBATION_WINDOWS: '0' }, { channels: [] });
  try {
    const reg = s.registry;
    reg.registerStrategies('scout', ['alpha', 'beta'], (id, strat, deps) => new Loser(id, strat, deps));
    const treasury = new TreasuryAgent('treasury-2', 'auditor', s.depsFor('treasury-2'), { registry: reg });
    reg.register(treasury);
    const loser = new Loser('scout-orphan', 'alpha', s.depsFor('scout-orphan'));
    reg.register(loser);
    for (let t = 0; t < 5; t++) {
      await loser.runTick(t);
      await treasury.runTick(t);
    }
    await treasury.runTick(5);
    assert.equal(loser.isTerminated, true);
    assert.equal(treasury.stats().spawns, 0);
    assert.equal(treasury.crashes, 0);
  } finally {
    s.close();
  }
});

test('a TreasuryAgent without a registry is refused at construction', async () => {
  const s = await makeStack(HARSH, { channels: [] });
  try {
    assert.throws(
      // Justified cast: deliberately omitting the required registry.
      () => new TreasuryAgent('treasury-3', 'auditor', s.depsFor('treasury-3'), undefined as unknown as never),
      /TREASURY_NO_REGISTRY|AgentRegistry is required/,
    );
  } finally {
    s.close();
  }
});

/* ============ AMENDMENT A2: skipped ticks must not skip whole windows ======= */

test('A2: windows the supervisor ticked past are still judged, oldest first', async () => {
  // The supervisor SKIPS the ticks a slow tick missed — that is documented,
  // deliberate behaviour. The treasury used to jump lastJudgedWindow straight to
  // the newest completed window, so the windows in between were never evaluated
  // and the consecutive-failure streak the whole rule turns on never grew.
  const { s, reg, treasury } = await wire({ ARES_PROBATION_WINDOWS: '1' });
  try {
    const loser = new Loser('scout-skip', 'alpha', s.depsFor('scout-skip'));
    reg.register(loser);

    // Windows 0 and 1 (ticks 0..9) both produce real, failing activity...
    for (let t = 0; t < 10; t++) await loser.runTick(t);
    assert.equal(treasury.stats().lastJudgedWindow, -1, 'the treasury has not run at all yet');

    // ...and the treasury's first wake-up is at tick 10, on the far side of BOTH
    // boundaries. Window 0 is a first failure, window 1 the fatal second.
    await treasury.runTick(10);
    await s.bus.drain();

    assert.equal(treasury.stats().lastJudgedWindow, 1, 'it caught up to the newest completed window');
    assert.equal(treasury.stats().windowsReplayed, 1, 'and it replayed the one it had skipped past');
    assert.equal(s.survival.state('scout-skip')?.failStreak, 2, 'two failing windows, two counts');
    assert.equal(loser.isTerminated, true, 'so the second one was fatal, as it always should have been');
    assert.equal(treasury.stats().terminations, 1);
  } finally {
    s.close();
  }
});

test('A2: the catch-up is bounded and says so when it truncates', async () => {
  const { s, reg, treasury } = await wire({ ARES_PROBATION_WINDOWS: '9' });
  try {
    const loser = new Loser('scout-far', 'alpha', s.depsFor('scout-far'));
    reg.register(loser);
    for (let t = 0; t < 5; t++) await loser.runTick(t);

    // Window size 5, so tick 500 is window 100: a backlog of 100 windows.
    await treasury.runTick(500);
    const st = treasury.stats();
    assert.equal(st.lastJudgedWindow, 99, 'it is caught up');
    assert.equal(st.windowsReplayed, MAX_CATCHUP_WINDOWS - 1);
    assert.equal(st.windowsDropped, 100 - MAX_CATCHUP_WINDOWS, 'and it is honest about what it skipped');
    assert.equal(treasury.crashes, 0, 'a bounded catch-up is not a crash');
  } finally {
    s.close();
  }
});

test('A2: judging is still once per window, not once per tick', async () => {
  const { s, reg, treasury } = await wire({ ARES_PROBATION_WINDOWS: '3' });
  try {
    const loser = new Loser('scout-once', 'alpha', s.depsFor('scout-once'));
    reg.register(loser);
    for (let t = 0; t <= 15; t++) {
      await loser.runTick(t);
      await treasury.runTick(t);
    }
    assert.equal(treasury.stats().lastJudgedWindow, 2, 'windows 0, 1 and 2 have completed');
    assert.equal(treasury.stats().windowsReplayed, 0, 'nothing was skipped, so nothing was replayed');
    assert.equal(s.survival.state('scout-once')?.failStreak, 3, 'three windows, three counts');
  } finally {
    s.close();
  }
});

/* ======= AMENDMENT A5: a quarantined agent is reclaimed, not stranded ======= */

test('A5: a quarantined agent is terminated, its reservations released and its caps reclaimed', async () => {
  const { s, reg, treasury } = await wire();
  try {
    const stuck = new Loser('scout-quar', 'alpha', s.depsFor('scout-quar'));
    const survivor = new Winner('scout-live', 'beta', s.depsFor('scout-live'));
    reg.register(stuck);
    reg.register(survivor);

    // It works, then it crashes enough that the supervisor quarantines it —
    // which, by design, is NOT a termination: that stays the Treasury's call.
    for (let t = 0; t < 3; t++) {
      await stuck.runTick(t);
      await survivor.runTick(t);
      await treasury.runTick(t);
    }
    const res = s.budget.reserve('scout-quar', 'cash', 3_000, 3);
    assert.equal(s.budget.openReservations('scout-quar').length, 1);
    const survivorCapBefore = s.budget.snapshot().agents.find((a) => a.agentId === 'scout-live')!.cashCapMinor;
    const availableToOthersWhileStuck = s.budget.availableCash('scout-live');

    stuck.quarantine('crashed too many times');
    assert.equal(reg.active().some((a) => a.id === 'scout-quar'), false, 'active() drops it, as the supervisor needs');
    assert.equal(reg.judgeable().some((a) => a.id === 'scout-quar'), true, 'but the Treasury can still reach it');

    // Tick 5: the first window boundary after the quarantine.
    for (let t = 3; t <= 5; t++) {
      await survivor.runTick(t);
      await treasury.runTick(t);
    }
    await s.bus.drain();

    assert.equal(stuck.isTerminated, true, 'no longer stranded alive forever');
    assert.equal(treasury.stats().terminations, 1);
    const row = treasury.verdicts().find((v) => v.id === 'scout-quar');
    assert.ok(row);
    assert.equal(row.verdict, 'TERMINATE');
    assert.match(row.reason, /quarantined/);

    // The budget it was sitting on is back in circulation.
    assert.deepEqual(s.budget.openReservations('scout-quar'), [], 'the reservation was released');
    assert.equal(s.budget.availableCash('scout-quar'), 0);
    const survivorAfter = s.budget.snapshot().agents.find((a) => a.agentId === 'scout-live')!;
    assert.ok(survivorAfter.cashCapMinor > survivorCapBefore, 'its cap was reallocated to a survivor');
    assert.ok(
      s.budget.availableCash('scout-live') > availableToOthersWhileStuck,
      'and everyone else can spend again',
    );

    // The role is restaffed rather than silently going empty.
    assert.equal(treasury.stats().spawns, 1);
    const spawned = s.of('AGENT_SPAWNED').find((e) => (e.payload as { replaces: string }).replaces === 'scout-quar');
    assert.ok(spawned, 'a replacement was born');
    assert.equal(s.ledger.verify().ok, true);
    // Releasing an already-released reservation must stay a no-op, not a throw.
    assert.throws(() => s.budget.commit(res, 3_000));
  } finally {
    s.close();
  }
});

/* ===== AMENDMENT A4: survival state is durable across a process restart ===== */

test('A4: the treasury gives the evaluator somewhere durable to keep its rows', async () => {
  const { s, reg, treasury } = await wire({ ARES_PROBATION_WINDOWS: '1' });
  try {
    const loser = new Loser('scout-durable', 'alpha', s.depsFor('scout-durable'));
    reg.register(loser);
    for (let t = 0; t <= 5; t++) {
      await loser.runTick(t);
      await treasury.runTick(t);
    }
    assert.equal(s.survival.state('scout-durable')?.failStreak, 1);
    assert.ok(treasury.run.startsWith('run:'), 'the boot is identified');

    // The shared task memory is where it went — not the agent's private scope,
    // which dies with the agent whose immunity we are trying not to re-arm.
    const rows = s.taskMemory.getFact<Record<string, { failStreak: number; samples: number }>>('survival.rows', {});
    assert.ok(rows['scout-durable'], 'the row is in the swarm-wide scope');
    assert.equal(rows['scout-durable'].failStreak, 1);
    assert.ok(rows['scout-durable'].samples >= 6);
  } finally {
    s.close();
  }
});
