/**
 * test/supervisor.test.ts — the failure modes of the 24/7 loop, all of them
 * driven by TestClock so nothing here depends on wall time.
 * Covers: drift-corrected scheduling and missed-tick SKIPPING, the watchdog
 * latching the kill switch after three consecutive overruns, crash quarantine
 * that never terminates, a halt mid-tick stopping the later phases, snapshots,
 * and a graceful shutdown that is idempotent and forceable by a second signal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { BaseAgent, type AgentDeps } from '../src/agents/base.js';
import type { AgentId, AgentRole } from '../src/core/types.js';
import { Supervisor, PHASES, WATCHDOG_TRIP_AFTER } from '../src/runtime/supervisor.js';
import { makeStack, type Stack } from './agents.harness.js';

/** An agent whose entire behaviour is one injected function. */
class FakeAgent extends BaseAgent {
  readonly calls: number[] = [];
  behaviour: (tick: number) => void | Promise<void>;

  constructor(id: AgentId, role: AgentRole, deps: AgentDeps, behaviour: (tick: number) => void | Promise<void>) {
    super(id, role, `fake-${role}`, deps);
    this.behaviour = behaviour;
  }

  override async onTick(tick: number): Promise<void> {
    this.calls.push(tick);
    await this.behaviour(tick);
  }
}

function makeSupervisor(
  s: Stack,
  opts: { snapshotEveryTicks?: number; maxTicks?: number; onShutdown?: () => Promise<void>; exit?: (c: number) => void } = {},
): Supervisor {
  return new Supervisor(
    {
      cfg: s.cfg,
      clock: s.clock,
      logger: s.logger,
      bus: s.bus,
      ledger: s.ledger,
      budget: s.budget,
      killSwitch: s.killSwitch,
      registry: s.registry,
      memories: () => [s.taskMemory, ...s.memories.values()],
      ...(opts.onShutdown ? { onShutdown: opts.onShutdown } : {}),
      ...(opts.exit ? { exit: opts.exit } : {}),
    },
    {
      snapshotEveryTicks: opts.snapshotEveryTicks ?? 0,
      ...(opts.maxTicks !== undefined ? { maxTicks: opts.maxTicks } : {}),
    },
  );
}

/** Let every pending microtask/immediate run so the loop reaches its next park. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

test('phases run in order and the treasury is always last', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000' });
  try {
    const order: string[] = [];
    const mk = (id: string, role: AgentRole): FakeAgent =>
      new FakeAgent(id, role, s.depsFor(id), () => {
        order.push(role);
      });
    // Registered in the WRONG order on purpose: the supervisor's phase order,
    // not the registration order, is what must decide.
    s.registry.register(mk('treasury-1', 'treasury'));
    s.registry.register(mk('seller-1', 'seller'));
    s.registry.register(mk('scout-1', 'scout'));

    const sup = makeSupervisor(s);
    await sup.runTick(0);
    assert.deepEqual(order, ['scout', 'seller', 'treasury']);
    assert.deepEqual([...PHASES], ['scout', 'seller', 'treasury']);
  } finally {
    s.close();
  }
});

test('a halt mid-tick stops every later phase in the same tick', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000' });
  try {
    const scout = new FakeAgent('scout-1', 'scout', s.depsFor('scout-1'), () => {
      s.killSwitch.trip('tripped by the scout phase');
    });
    const seller = new FakeAgent('seller-1', 'seller', s.depsFor('seller-1'), () => undefined);
    const treasury = new FakeAgent('treasury-1', 'treasury', s.depsFor('treasury-1'), () => undefined);
    s.registry.register(scout);
    s.registry.register(seller);
    s.registry.register(treasury);

    const sup = makeSupervisor(s);
    await sup.runTick(0);

    assert.deepEqual(scout.calls, [0], 'the scout phase ran');
    assert.deepEqual(seller.calls, [], 'the seller phase must NOT run after the halt');
    assert.deepEqual(treasury.calls, [], 'the treasury phase must NOT run after the halt');
    assert.ok(sup.snapshot().phaseHalts >= 1);
    assert.equal(sup.snapshot().halted, true);
  } finally {
    s.close();
  }
});

test('the watchdog warns on an overrun and trips the kill switch on the third consecutive one', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000', ARES_TICK_WATCHDOG_MS: '50' });
  try {
    // Every tick burns 120 virtual ms against a 50ms watchdog.
    const slow = new FakeAgent('scout-1', 'scout', s.depsFor('scout-1'), () => {
      s.clock.advance(120);
    });
    s.registry.register(slow);
    const sup = makeSupervisor(s);

    await sup.runTick(0);
    assert.equal(s.killSwitch.tripped, false, 'one overrun is a warning, not a halt');
    await sup.runTick(1);
    assert.equal(s.killSwitch.tripped, false, 'two overruns are still only a warning');
    assert.equal(sup.snapshot().consecutiveOverruns, 2);

    await sup.runTick(2);
    assert.equal(sup.snapshot().consecutiveOverruns, WATCHDOG_TRIP_AFTER);
    assert.equal(s.killSwitch.tripped, true, 'the third consecutive overrun halts the swarm');
    assert.match(String(s.killSwitch.reason), /watchdog/i);
    assert.equal(sup.snapshot().overruns, 3);
  } finally {
    s.close();
  }
});

test('a fast tick resets the consecutive-overrun counter', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000', ARES_TICK_WATCHDOG_MS: '50' });
  try {
    let slow = true;
    const a = new FakeAgent('scout-1', 'scout', s.depsFor('scout-1'), () => {
      if (slow) s.clock.advance(120);
    });
    s.registry.register(a);
    const sup = makeSupervisor(s);
    await sup.runTick(0);
    await sup.runTick(1);
    assert.equal(sup.snapshot().consecutiveOverruns, 2);
    slow = false;
    await sup.runTick(2);
    assert.equal(sup.snapshot().consecutiveOverruns, 0);
    slow = true;
    await sup.runTick(3);
    await sup.runTick(4);
    assert.equal(s.killSwitch.tripped, false, 'the streak restarted, so no halt yet');
  } finally {
    s.close();
  }
});

test('an agent that keeps crashing is quarantined, skipped thereafter, and NOT terminated', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000', ARES_MAX_CRASHES: '2' });
  try {
    const bad = new FakeAgent('scout-1', 'scout', s.depsFor('scout-1'), () => {
      throw new Error('deliberate agent failure');
    });
    const good = new FakeAgent('seller-1', 'seller', s.depsFor('seller-1'), () => undefined);
    s.registry.register(bad);
    s.registry.register(good);
    const sup = makeSupervisor(s);

    await sup.runTick(0);
    assert.equal(bad.status, 'active', 'one crash is not a quarantine');
    await sup.runTick(1);
    assert.equal(bad.status, 'quarantined');
    assert.equal(bad.isTerminated, false, 'quarantine must NOT terminate — that is the Treasury decision');
    assert.deepEqual(sup.snapshot().quarantined, ['scout-1']);

    const callsAtQuarantine = bad.calls.length;
    await sup.runTick(2);
    await sup.runTick(3);
    assert.equal(bad.calls.length, callsAtQuarantine, 'a quarantined agent is never ticked again');
    assert.deepEqual(good.calls, [0, 1, 2, 3], 'its sibling keeps running');
    assert.equal(sup.snapshot().agentCrashes, 2);
    // It is still in the roster, still not terminated: history is not deleted.
    assert.equal(s.registry.get('scout-1')?.status, 'quarantined');
  } finally {
    s.close();
  }
});

test('scheduling is drift-corrected off a fixed epoch and missed ticks are SKIPPED, not burst', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000', ARES_TICK_WATCHDOG_MS: '100000' });
  try {
    const seen: number[] = [];
    // Tick 0 overruns by 3.5 intervals; everything after it is instant.
    const a = new FakeAgent('scout-1', 'scout', s.depsFor('scout-1'), (t) => {
      seen.push(t);
      if (t === 0) s.clock.advance(3_500);
    });
    s.registry.register(a);
    const sup = makeSupervisor(s, { maxTicks: 2 });

    sup.start();
    await settle();
    await sup.done();

    // Tick 0 ran at the epoch. By the time it finished the clock said tick 3
    // was due, so ticks 1 and 2 are SKIPPED — never executed late in a burst.
    assert.deepEqual(seen, [0, 3], 'the loop resumes at the tick that is due now');
    const snap = sup.snapshot();
    assert.equal(snap.ticksSkipped, 2);
    assert.equal(snap.skipEvents, 1);
    assert.equal(snap.ticksExecuted, 2);
    // Drift correction: tick 3's deadline is still epoch + 3*interval exactly.
    assert.equal(snap.epoch !== null && snap.nextTickDueAt === snap.epoch + 4 * 1000, true);
    await sup.stop('test over');
  } finally {
    s.clock.releaseAll();
    s.close();
  }
});

test('the loop sleeps to each deadline and does not run a tick early', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000' });
  try {
    const seen: number[] = [];
    const a = new FakeAgent('scout-1', 'scout', s.depsFor('scout-1'), (t) => {
      seen.push(t);
    });
    s.registry.register(a);
    const sup = makeSupervisor(s);
    sup.start();
    await settle();
    assert.deepEqual(seen, [0], 'tick 0 is due at the epoch');

    s.clock.advance(400);
    await settle();
    assert.deepEqual(seen, [0], 'less than an interval has passed: no tick');

    s.clock.advance(700); // now 1100ms past the epoch
    await settle();
    assert.deepEqual(seen, [0, 1]);

    await sup.stop('test over');
    const before = seen.length;
    s.clock.advance(10_000);
    await settle();
    assert.equal(seen.length, before, 'a stopped supervisor never ticks again, whatever the clock does');
  } finally {
    s.clock.releaseAll();
    s.close();
  }
});

test('start() twice does not start a second loop, and stop() twice is one shutdown', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000' });
  try {
    let shutdowns = 0;
    const seen: number[] = [];
    const a = new FakeAgent('scout-1', 'scout', s.depsFor('scout-1'), (t) => {
      seen.push(t);
    });
    s.registry.register(a);
    const sup = makeSupervisor(s, {
      onShutdown: async () => {
        shutdowns += 1;
      },
    });

    sup.start();
    sup.start(); // must be a logged no-op
    await settle();
    assert.deepEqual(seen, [0], 'exactly one tick 0 — a second loop would have doubled it');

    const p1 = sup.stop('first');
    const p2 = sup.stop('second');
    assert.equal(p1, p2, 'both callers await the SAME shutdown');
    await p1;
    await p2;
    assert.equal(shutdowns, 1, 'the shutdown hook ran exactly once');
    assert.equal(sup.snapshot().stopped, true);
    assert.equal(sup.snapshot().running, false);

    sup.start(); // refused after a stop
    await settle();
    assert.equal(sup.isRunning, false);
    assert.deepEqual(seen, [0]);
  } finally {
    s.clock.releaseAll();
    s.close();
  }
});

test('graceful shutdown drains the bus, flushes memory and verifies the ledger', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000' });
  try {
    const a = new FakeAgent('scout-1', 'scout', s.depsFor('scout-1'), () => undefined);
    s.registry.register(a);
    const mem = s.memories.get('scout-1');
    assert.ok(mem);
    mem.setFact('written-before-shutdown', 42);
    const flushesBefore = mem.flushCount;

    const sup = makeSupervisor(s);
    sup.start();
    await settle();
    await sup.stop('graceful');

    assert.ok(mem.flushCount > flushesBefore, 'memory reached disk on shutdown');
    assert.equal(s.ledger.verify().ok, true, 'the final ledger verify passes');
    assert.equal(s.bus.stats().depth, 0, 'the bus was drained');
    // The bus is closed: further publishes are dropped, not delivered.
    const before = s.bus.stats().dropped;
    s.bus.publish({ type: 'AUDIT_TICK', from: 'system', tick: 0, payload: {} });
    assert.equal(s.bus.stats().dropped, before + 1, 'the bus stopped accepting new traffic');
  } finally {
    s.clock.releaseAll();
    s.close();
  }
});

test('a shutdown that hangs is forced down by a SECOND signal', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000' });
  try {
    const exits: number[] = [];
    let release = (): void => {};
    const hang = new Promise<void>((r) => {
      release = r;
    });
    const sup = makeSupervisor(s, {
      onShutdown: () => hang, // a shutdown hook that will not finish
      exit: (c) => {
        exits.push(c);
      },
    });
    sup.start();
    await settle();

    sup.onSignal('SIGTERM');
    await settle();
    assert.deepEqual(exits, [], 'the first signal starts a graceful stop and does not exit yet');
    assert.equal(sup.snapshot().shuttingDown, true);

    sup.onSignal('SIGTERM'); // the operator is out of patience
    assert.deepEqual(exits, [1], 'the second signal forces the process down immediately');

    release();
    await sup.stop('cleanup');
    await settle();
    assert.deepEqual(exits, [1, 0], 'the graceful path still finishes and reports exit 0');
  } finally {
    s.clock.releaseAll();
    s.close();
  }
});

test('a single signal shuts down gracefully and exits 0', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000' });
  try {
    const exits: number[] = [];
    const sup = makeSupervisor(s, {
      exit: (c) => {
        exits.push(c);
      },
    });
    sup.start();
    await settle();
    sup.onSignal('SIGINT');
    await settle(12);
    assert.deepEqual(exits, [0]);
    assert.equal(sup.snapshot().stopped, true);
    assert.equal(s.ledger.verify().ok, true);
  } finally {
    s.clock.releaseAll();
    s.close();
  }
});

test('state is snapshotted every N ticks and every memory store is flushed with it', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000' });
  try {
    const a = new FakeAgent('scout-1', 'scout', s.depsFor('scout-1'), () => undefined);
    s.registry.register(a);
    const sup = makeSupervisor(s, { snapshotEveryTicks: 2 });

    await sup.runTick(0);
    assert.equal(sup.snapshot().snapshots, 0, 'not yet');
    await sup.runTick(1);
    assert.equal(sup.snapshot().snapshots, 1);

    const dir = join(s.dir, 'snapshots');
    assert.equal(existsSync(dir), true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const body = JSON.parse(readFileSync(join(dir, files[0] as string), 'utf8')) as Record<string, unknown>;
    assert.equal(body['mode'], 'PAPER');
    assert.equal(body['tick'], 1);
    assert.ok((body['memoriesFlushed'] as number) >= 1);
    assert.ok(typeof (body['ledger'] as Record<string, unknown>)['head'] === 'string');
    // No temp file left behind: the write is tmp+rename.
    assert.equal(
      readdirSync(dir).some((f) => f.endsWith('.tmp')),
      false,
    );
  } finally {
    s.close();
  }
});

test('an agent whose runTick somehow throws does not take the loop down', async () => {
  const s = await makeStack({ ARES_TICK_MS: '1000' });
  try {
    const rogue = new FakeAgent('scout-1', 'scout', s.depsFor('scout-1'), () => undefined);
    // Break the contract on purpose: runTick() is documented never to throw.
    (rogue as unknown as { runTick: () => Promise<boolean> }).runTick = () => {
      throw new Error('contract violated');
    };
    const after = new FakeAgent('seller-1', 'seller', s.depsFor('seller-1'), () => undefined);
    s.registry.register(rogue);
    s.registry.register(after);

    const sup = makeSupervisor(s);
    await sup.runTick(0);
    assert.deepEqual(after.calls, [0], 'the seller phase still ran');
    assert.equal(sup.snapshot().ticksExecuted, 1);
  } finally {
    s.close();
  }
});
