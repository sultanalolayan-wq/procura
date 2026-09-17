/**
 * test/agents.base.test.ts — the agent chassis, adversarially. The action cap,
 * the halt gate that must fire FIRST, crash containment between siblings, an
 * idempotent terminate() that gives back every reservation, and the refusal to
 * build an agent on a PolicyEngine whose kill switch was never wired.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AresError } from '../src/core/errors.js';
import { money } from '../src/core/money.js';
import { nullLogger } from '../src/core/logger.js';
import { PolicyEngine } from '../src/governance/policy.js';
import { KillSwitch } from '../src/governance/killswitch.js';
import {
  ACTION_TOKENS,
  BaseAgent,
  assertPolicyWired,
  makeAgentDeps,
  policyKillSwitch,
  type AgentDeps,
} from '../src/agents/base.js';
import type { AgentId, Holding } from '../src/core/types.js';
import { makeStack } from './agents.harness.js';

/** A minimal agent whose per-tick behaviour each test dictates. */
class ProbeAgent extends BaseAgent {
  plan: (a: ProbeAgent, tick: number) => Promise<void> = async () => {};
  readonly ran: string[] = [];

  constructor(id: AgentId, deps: AgentDeps, strategy = 'probe-a') {
    super(id, 'scout', strategy, deps);
  }

  override async onTick(tick: number): Promise<void> {
    await this.plan(this, tick);
  }

  /** Test-visible wrappers around the protected chassis. */
  async doAct<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    return this.act(name, fn);
  }

  takeCash(amount: number, tick: number): void {
    this.reserve('cash', amount, tick);
  }

  stock(h: Holding): void {
    this.addInventory(h);
  }

  teach(netMinor: number, tick: number): void {
    this.learn({
      strategyId: this.strategyId,
      agentId: this.id,
      tick,
      netMinor,
      success: netMinor > 0,
      meta: { kind: 'probe' },
    });
  }

  left(): number {
    return this.actionsLeft;
  }
}

/* ----------------------------------------------------------- the wiring gate */

test('an AgentDeps whose PolicyEngine has no kill switch is refused, not silently permissive', async () => {
  const s = await makeStack();
  try {
    const bare = new PolicyEngine(s.cfg, nullLogger);
    assert.equal(policyKillSwitch(bare), null, 'the engine really is unwired');

    // Proof that the danger is real: an unwired engine permits a buy even though
    // the swarm is halted, because its halt rule can never evaluate.
    const halted = new KillSwitch(nullLogger, s.clock);
    halted.trip('test halt');
    const adapter = s.channels.get('digitalassets');
    assert.ok(adapter);
    const opp = {
      id: 'o1',
      channel: 'digitalassets',
      sku: 'digitalassets-sku-000',
      title: 't',
      askPrice: money(1_000, 'SAR'),
      estResaleValue: money(2_000, 'SAR'),
      confidence: 0.9,
      ttlTicks: 3,
      meta: {},
    };
    assert.doesNotThrow(
      () => bare.checkBuy(adapter, opp, 1, money(1_000, 'SAR'), 1),
      'an unwired engine is exactly as permissive as this test fears',
    );

    // So constructing an agent on it must be impossible.
    const deps: AgentDeps = { ...s.depsFor('probe-unwired'), policy: bare };
    assert.throws(
      () => new ProbeAgent('probe-unwired-2', deps),
      (e: unknown) => {
        assert.ok(e instanceof AresError);
        assert.equal(e.code, 'POLICY_KILLSWITCH_UNWIRED');
        assert.match(e.message, /silent no-op/);
        return true;
      },
    );
    assert.throws(() => assertPolicyWired(bare, s.killSwitch), /POLICY_KILLSWITCH_UNWIRED|no kill switch/);

    // A DIFFERENT kill switch is just as dangerous and is caught separately.
    const other = new PolicyEngine(s.cfg, nullLogger, { killSwitch: new KillSwitch(nullLogger, s.clock) });
    assert.throws(
      () => assertPolicyWired(other, s.killSwitch),
      (e: unknown) => {
        assert.ok(e instanceof AresError);
        assert.equal(e.code, 'POLICY_KILLSWITCH_MISMATCH');
        return true;
      },
    );

    // makeAgentDeps is the blessed path: it wires and then verifies.
    const fixed = makeAgentDeps({ ...s.depsFor('probe-fixed'), policy: bare });
    assert.equal(policyKillSwitch(fixed.policy), s.killSwitch);
    assert.doesNotThrow(() => new ProbeAgent('probe-fixed-2', fixed));
  } finally {
    s.close();
  }
});

test('the stack harness always hands agents a wired policy engine', async () => {
  const s = await makeStack();
  try {
    assert.equal(policyKillSwitch(s.policy), null, 'unwired before any deps are built');
    const deps = s.depsFor('scout-1');
    assert.equal(policyKillSwitch(deps.policy), s.killSwitch, 'wired by makeAgentDeps');
  } finally {
    s.close();
  }
});

/* --------------------------------------------------------------- action cap */

test('act() enforces maxActionsPerAgentPerTick and the budget resets each tick', async () => {
  const s = await makeStack({ ARES_MAX_ACTIONS: '3' });
  try {
    const a = new ProbeAgent('scout-cap', s.depsFor('scout-cap'));
    const done: number[] = [];
    a.plan = async (self, tick) => {
      for (let i = 0; i < 10; i++) {
        const r = await self.doAct(`step-${i}`, async () => {
          done.push(tick * 100 + i);
          return i;
        });
        if (r === null) break;
      }
    };
    await a.runTick(0);
    assert.deepEqual(done, [0, 1, 2], 'exactly three actions, then refusal');
    assert.equal(a.snapshot().actionsRefused, 1);
    assert.equal(a.left(), 0);

    await a.runTick(1);
    assert.deepEqual(done, [0, 1, 2, 100, 101, 102], 'the cap resets on the next tick');
    assert.equal(a.snapshot().actionsTaken, 6);
    assert.equal(a.snapshot().crashes, 0, 'a refusal is not a crash');
  } finally {
    s.close();
  }
});

/* -------------------------------------------------------------- the halt gate */

test('a kill switch tripped mid-tick stops the rest of that tick immediately', async () => {
  const s = await makeStack({ ARES_MAX_ACTIONS: '8' });
  try {
    const a = new ProbeAgent('scout-halt', s.depsFor('scout-halt'));
    const ran: string[] = [];
    a.plan = async (self) => {
      await self.doAct('one', async () => {
        ran.push('one');
      });
      s.killSwitch.trip('operator pulled the plug');
      for (const n of ['two', 'three', 'four']) {
        const r = await self.doAct(n, async () => {
          ran.push(n);
        });
        assert.equal(r, null, `${n} must be refused while halted`);
      }
    };
    await a.runTick(0);
    assert.deepEqual(ran, ['one'], 'nothing after the trip ran');
    assert.equal(a.snapshot().haltRefusals, 3);
    assert.equal(a.snapshot().crashes, 0, 'a halt is a refusal, not a crash');

    // And the next tick does not even enter onTick.
    let entered = false;
    a.plan = async () => {
      entered = true;
    };
    assert.equal(await a.runTick(1), false);
    assert.equal(entered, false);
  } finally {
    s.close();
  }
});

test('the halt gate is checked BEFORE the action cap, so a halted agent burns no budget', async () => {
  const s = await makeStack({ ARES_MAX_ACTIONS: '2' });
  try {
    const a = new ProbeAgent('scout-order', s.depsFor('scout-order'));
    s.killSwitch.trip('halted before the tick');
    a.plan = async (self) => {
      for (let i = 0; i < 5; i++) await self.doAct(`x${i}`, async () => i);
    };
    // runTick short-circuits a halted agent, so drive act() directly.
    for (let i = 0; i < 5; i++) assert.equal(await a.doAct(`x${i}`, async () => i), null);
    const snap = a.snapshot();
    assert.equal(snap.haltRefusals, 5);
    assert.equal(snap.actionsTaken, 0, 'no action was ever consumed');
    assert.equal(snap.actionsRefused, 0, 'the cap never even got a say');
  } finally {
    s.close();
  }
});

/* ------------------------------------------------------- crash containment */

test('an agent whose onTick throws does not break its siblings', async () => {
  const s = await makeStack();
  try {
    const bad = new ProbeAgent('scout-bad', s.depsFor('scout-bad'));
    const goodA = new ProbeAgent('scout-good-a', s.depsFor('scout-good-a'));
    const goodB = new ProbeAgent('scout-good-b', s.depsFor('scout-good-b'));
    const ran: string[] = [];
    bad.plan = async () => {
      throw new Error('deliberate explosion');
    };
    goodA.plan = async () => {
      ran.push('a');
    };
    goodB.plan = async () => {
      ran.push('b');
    };

    // The supervisor's ordering, imitated: nothing is wrapped in a try/catch here.
    for (const agent of [goodA, bad, goodB]) await agent.runTick(0);

    assert.deepEqual(ran, ['a', 'b'], 'both healthy siblings ran');
    assert.equal(bad.crashes, 1);
    assert.equal(bad.snapshot().lastError, 'deliberate explosion');
    assert.equal(goodA.crashes, 0);
    assert.equal(goodB.crashes, 0);

    // Repeated crashes accumulate and can be quarantined without terminating.
    for (let t = 1; t <= 3; t++) await bad.runTick(t);
    assert.equal(bad.crashes, 4);
    bad.quarantine('too many crashes');
    assert.equal(bad.status, 'quarantined');
    assert.equal(await bad.runTick(9), false, 'a quarantined agent is not ticked');
  } finally {
    s.close();
  }
});

test('an action that throws is contained and counted, and the tick carries on', async () => {
  const s = await makeStack({ ARES_MAX_ACTIONS: '4' });
  try {
    const a = new ProbeAgent('scout-contain', s.depsFor('scout-contain'));
    const ran: string[] = [];
    a.plan = async (self) => {
      const bad = await self.doAct('bad', async () => {
        throw new AresError('BOOM', 'adapter exploded');
      });
      assert.equal(bad, null, 'act() returns null instead of throwing');
      const ok = await self.doAct('ok', async () => {
        ran.push('ok');
        return 42;
      });
      assert.equal(ok, 42);
    };
    assert.equal(await a.runTick(0), true, 'the tick itself completed');
    assert.deepEqual(ran, ['ok']);
    assert.equal(a.crashes, 1);
  } finally {
    s.close();
  }
});

/* ------------------------------------------------------------------- learn */

test('learn() feeds survival, memory and the bus from one call', async () => {
  const s = await makeStack();
  try {
    const a = new ProbeAgent('scout-learn', s.depsFor('scout-learn'));
    await a.runTick(0);
    a.teach(750, 3);
    a.teach(-250, 4);
    await s.bus.drain();

    assert.equal(s.survival.state('scout-learn')?.samples, 2);
    assert.equal(s.survival.state('scout-learn')?.successes, 1);
    const episodes = s.depsFor('scout-learn').memory.recall('probe');
    assert.equal(episodes.length, 2);
    // recall() is most-recent-first.
    assert.deepEqual(episodes.map((e) => e.net), [-250, 750]);
    const stat = s.depsFor('scout-learn').memory.stat('net:agent');
    assert.equal(stat?.n, 2);
    assert.equal(stat?.mean, 250);

    const outcomes = s.of('STRATEGY_OUTCOME');
    assert.equal(outcomes.length, 2);
    assert.equal((outcomes[0]?.payload as { netMinor: number }).netMinor, 750);
  } finally {
    s.close();
  }
});

/* --------------------------------------------------------------- terminate */

test('terminate() releases every outstanding reservation, liquidates stock and is idempotent', async () => {
  const s = await makeStack();
  try {
    const deps = s.depsFor('scout-term');
    const a = new ProbeAgent('scout-term', deps);
    await a.runTick(5);

    a.takeCash(1_200, 5);
    a.takeCash(800, 5);
    assert.equal(s.budget.openReservations('scout-term').length, 2);
    assert.equal(a.outstandingReservations().length, 2);
    const availableWhileHeld = s.budget.availableCash('scout-term');

    a.stock({
      id: 'h1',
      channel: 'digitalassets',
      sku: 'sku-1',
      qty: 2,
      unitCost: money(900, 'SAR'),
      acquiredTick: 5,
      meta: {},
    });
    // Put the matching inventory on the books so the liquidation balances out.
    s.ledger.append({
      tick: 5,
      type: 'BUY',
      agentId: 'scout-term',
      currency: 'SAR',
      legs: [
        { account: 'inventory', amount: 1_800 },
        { account: 'cash', amount: -1_800 },
      ],
      idempotencyKey: 'seed-inventory',
      meta: {},
    });
    assert.equal(s.ledger.balanceOf('inventory'), 1_800);

    await a.terminate('survival: net below benchmark');

    assert.equal(s.budget.openReservations('scout-term').length, 0, 'nothing left promised');
    assert.equal(a.outstandingReservations().length, 0);
    assert.ok(
      s.budget.availableCash('scout-term') > availableWhileHeld,
      'released headroom is available again',
    );
    assert.equal(s.ledger.balanceOf('inventory'), 0, 'paper stock is off the books');
    assert.equal(s.ledger.balanceOf('writeoff'), 1_800);
    assert.equal(a.status, 'terminated');
    assert.equal(a.isTerminated, true);
    assert.equal(a.snapshot().holdings, 0);

    const pm = a.lastPostmortem();
    assert.ok(pm);
    assert.match(pm.text, /terminated at tick 5/);
    assert.match(pm.text, /net below benchmark/);
    assert.equal(pm.meta['reservationsReleased'], 2);
    assert.equal(pm.meta['writtenOffMinor'], 1_800);

    const sizeAfterFirst = s.ledger.size();
    const postmortemsAfterFirst = deps.memory.postmortems().length;

    // Twice must be safe: the registry and the supervisor can race.
    await a.terminate('again, from the supervisor');
    await a.terminate('and again');
    assert.equal(s.ledger.size(), sizeAfterFirst, 'no second liquidation entry');
    assert.equal(deps.memory.postmortems().length, postmortemsAfterFirst, 'no second postmortem');
    assert.equal(s.ledger.verify().ok, true);
    assert.equal(a.status, 'terminated');
  } finally {
    s.close();
  }
});

test('terminate() writes the postmortem to the shared task memory too', async () => {
  const s = await makeStack();
  try {
    const a = new ProbeAgent('scout-shared', s.depsFor('scout-shared'), 'probe-b');
    await a.runTick(2);
    await a.terminate('bored');
    const shared = s.taskMemory.postmortems(5);
    assert.ok(shared.length >= 1);
    assert.match(String(shared[0]?.text), /scout\/probe-b died: bored/);
  } finally {
    s.close();
  }
});

test('an agent registers itself with the budget governor exactly once', async () => {
  const s = await makeStack();
  try {
    assert.equal(s.budget.has('scout-reg'), false);
    const deps = s.depsFor('scout-reg');
    const a = new ProbeAgent('scout-reg', deps);
    assert.equal(s.budget.has('scout-reg'), true);
    // A second agent on the same id must not double-register (which throws).
    assert.doesNotThrow(() => new ProbeAgent('scout-reg', deps));
    assert.equal(a.id, 'scout-reg');
  } finally {
    s.close();
  }
});

/* ============ AMENDMENT A9: the compute budget must actually be charged ===== */

test('A9: every act() charges a modelled compute cost to the ledger', async () => {
  // Before this, chargeTokens() had NO caller anywhere: balanceOf('compute') was
  // permanently 0, so ANY gross trading margin read as profit and the survival
  // rule could never see the cost of running the swarm at all.
  const s = await makeStack({ ARES_MAX_ACTIONS: '3' });
  try {
    assert.equal(s.ledger.balanceOf('compute'), 0, 'nothing has run yet');
    const cashBefore = s.ledger.balanceOf('cash');

    const a = new ProbeAgent('scout-compute', s.depsFor('scout-compute'));
    a.plan = async (self) => {
      for (let i = 0; i < 3; i++) await self.doAct(`step-${i}`, async () => i);
    };
    await a.runTick(0);
    await a.runTick(1);

    const spends = s.ledger.entries({ type: 'TOKEN_SPEND', agentId: 'scout-compute' });
    // Accrued per action, BOOKED once per tick: six actions over two ticks is two
    // entries of three actions each. One entry per action would have made compute
    // ~96% of every ledger entry in a run, on a chain that never rotates.
    assert.equal(spends.length, 2, 'one entry per agent per tick');
    assert.deepEqual(spends.map((e) => e.tick), [0, 1]);
    for (const e of spends) {
      assert.deepEqual(e.legs.map((l) => l.account), ['compute', 'cash']);
      assert.equal(e.legs.reduce((x, l) => x + l.amount, 0), 0, 'a charge is a balanced double entry');
      assert.equal(e.meta['tokens'], ACTION_TOKENS * 3, 'the whole tick worth of actions, in one entry');
    }
    assert.ok(s.ledger.balanceOf('compute') > 0, 'the compute account is real now');
    assert.equal(
      s.ledger.balanceOf('compute'),
      cashBefore - s.ledger.balanceOf('cash'),
      'every halala of compute came out of cash',
    );
    assert.equal(a.snapshot().tokensCharged, ACTION_TOKENS * 6);
    assert.ok(s.budget.snapshot().tokens.used >= ACTION_TOKENS * 6, 'and the token governor saw it');
    assert.equal(s.ledger.verify().ok, true);
  } finally {
    s.close();
  }
});

test('A9: the per-agent token cap is load-bearing: an exhausted agent is refused', async () => {
  // ARES_AGENT_TOKEN_CAP advertised a brake that nothing was connected to.
  const s = await makeStack({ ARES_MAX_ACTIONS: '8', ARES_AGENT_TOKEN_CAP: '2500', ARES_TOKEN_CAP: '5000' });
  try {
    const a = new ProbeAgent('scout-capped', s.depsFor('scout-capped'));
    const ran: number[] = [];
    a.plan = async (self) => {
      for (let i = 0; i < 8; i++) {
        const r = await self.doAct(`step-${i}`, async () => {
          ran.push(i);
          return i;
        });
        if (r === null) break;
      }
    };
    await a.runTick(0);

    assert.deepEqual(ran, [0, 1], 'two actions at 1,000 modelled tokens each, then the cap bites');
    assert.equal(a.snapshot().tokenRefusals, 1);
    assert.equal(a.snapshot().crashes, 0, 'running out of budget is a refusal, not a crash');
    assert.equal(s.budget.availableTokens('scout-capped'), 500, 'and the remainder is visibly short');
  } finally {
    s.close();
  }
});

test('A9: the charge is skippable, deliberately and auditably', async () => {
  const s = await makeStack();
  try {
    const a = new ProbeAgent('scout-free', { ...s.depsFor('scout-free'), tokensPerAction: 0 });
    a.plan = async (self) => {
      await self.doAct('one', async () => 1);
    };
    await a.runTick(0);
    assert.equal(s.ledger.entries({ type: 'TOKEN_SPEND', agentId: 'scout-free' }).length, 0);
    assert.equal(a.snapshot().tokensCharged, 0);
  } finally {
    s.close();
  }
});
