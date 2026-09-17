/**
 * test/agents.registry.test.ts — the roster and the succession rule. A
 * replacement must never run a strategy that has already failed, and it must
 * start from its predecessor's postmortem rather than rediscover the failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AresError } from '../src/core/errors.js';
import type { AgentId } from '../src/core/types.js';
import { BaseAgent, type AgentDeps } from '../src/agents/base.js';
import { AgentRegistry } from '../src/agents/registry.js';
import { makeStack } from './agents.harness.js';

class Toy extends BaseAgent {
  /** What this generation read out of its inherited memory at birth. */
  readonly inheritedAtBirth: number;
  readonly avoidAtBirth: string[];

  constructor(id: AgentId, strategyId: string, deps: AgentDeps) {
    super(id, 'scout', strategyId, deps);
    this.inheritedAtBirth = deps.memory.postmortems().length;
    this.avoidAtBirth = deps.memory.getFact<string[]>('avoidStrategies', []);
  }

  override async onTick(): Promise<void> {
    /* nothing */
  }
}

async function stackWithRegistry() {
  const s = await makeStack();
  const reg = new AgentRegistry();
  reg.registerStrategies('scout', ['alpha', 'beta', 'gamma'], (id, strat, deps) => new Toy(id, strat, deps));
  return { s, reg };
}

test('the roster tracks registration, roles and liveness', async () => {
  const { s, reg } = await stackWithRegistry();
  try {
    const a = new Toy('scout-a', 'alpha', s.depsFor('scout-a'));
    const b = new Toy('scout-b', 'beta', s.depsFor('scout-b'));
    reg.register(a);
    reg.register(b);
    assert.equal(reg.size(), 2);
    assert.equal(reg.get('scout-a'), a);
    assert.equal(reg.get('nobody'), undefined);
    assert.deepEqual(reg.byRole('scout').map((x) => x.id), ['scout-a', 'scout-b']);
    assert.deepEqual(reg.byRole('seller'), []);
    assert.throws(() => reg.register(a), (e: unknown) => {
      assert.ok(e instanceof AresError);
      assert.equal(e.code, 'REGISTRY_DUPLICATE_AGENT');
      return true;
    });

    await reg.terminate('scout-a', 'test');
    assert.deepEqual(reg.active().map((x) => x.id), ['scout-b']);
    assert.equal(reg.all().length, 2, 'history is kept, not deleted');
    b.quarantine('crashy');
    assert.deepEqual(reg.active(), []);
  } finally {
    s.close();
  }
});

test('terminating an unknown or already-dead agent is a no-op, not a throw', async () => {
  const { s, reg } = await stackWithRegistry();
  try {
    await reg.terminate('ghost', 'nothing to do');
    const a = new Toy('scout-a', 'alpha', s.depsFor('scout-a'));
    reg.register(a);
    await reg.terminate('scout-a', 'first');
    await reg.terminate('scout-a', 'second');
    assert.equal(reg.gravesFor('scout').length, 1, 'buried exactly once');
  } finally {
    s.close();
  }
});

test('spawnAlternative never picks an excluded strategy and carries the postmortem forward', async () => {
  const { s, reg } = await stackWithRegistry();
  try {
    const first = new Toy('scout-a', 'alpha', s.depsFor('scout-a'));
    reg.register(first);
    await first.runTick(4);
    await reg.terminate('scout-a', 'net below benchmark for 2 consecutive windows');

    const born = reg.spawnAlternative('scout', (id) => s.depsFor(id), ['alpha']);
    assert.ok(born instanceof Toy);
    assert.notEqual(born.strategyId, 'alpha');
    assert.ok(['beta', 'gamma'].includes(born.strategyId));
    assert.equal(reg.get(born.id), born, 'the replacement is on the roster');

    // The lesson reached the successor BEFORE its constructor ran.
    assert.equal(born.inheritedAtBirth, 1, 'the postmortem was already there at birth');
    assert.deepEqual(born.avoidAtBirth, ['alpha']);

    const inherited = born.lastPostmortem();
    assert.ok(inherited);
    assert.match(inherited.text, /scout-a \(scout\/alpha\) terminated/);
    assert.equal(inherited.meta['inherited'], true);
    assert.equal(inherited.meta['inheritedFrom'], 'scout-a');
    assert.equal(inherited.meta['inheritedStrategy'], 'alpha');

    const deps = s.depsFor(born.id);
    assert.equal(deps.memory.getFact<number>('generation', 0), 2);
    const from = deps.memory.getFact<Array<{ strategyId: string }>>('inheritedFrom', []);
    assert.deepEqual(from.map((f) => f.strategyId), ['alpha']);
  } finally {
    s.close();
  }
});

test('spawnAlternative prefers a strategy no live agent is already running', async () => {
  const { s, reg } = await stackWithRegistry();
  try {
    reg.register(new Toy('scout-b', 'beta', s.depsFor('scout-b')));
    const born = reg.spawnAlternative('scout', (id) => s.depsFor(id), ['alpha']);
    assert.ok(born);
    assert.equal(born.strategyId, 'gamma', 'beta is taken, alpha is banned');
  } finally {
    s.close();
  }
});

test('an exhausted strategy menu returns null rather than repeating a failure', async () => {
  const { s, reg } = await stackWithRegistry();
  try {
    assert.equal(reg.spawnAlternative('scout', (id) => s.depsFor(id), ['alpha', 'beta', 'gamma']), null);
    assert.equal(reg.spawnAlternative('seller', (id) => s.depsFor(id), []), null, 'undeclared role');
    assert.deepEqual(reg.strategies('scout'), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(reg.strategies('seller'), []);
  } finally {
    s.close();
  }
});

test('spawnAlternative also accepts a plain AgentDeps', async () => {
  const { s, reg } = await stackWithRegistry();
  try {
    const born = reg.spawnAlternative('scout', s.depsFor('shared-deps'), ['alpha', 'beta']);
    assert.ok(born);
    assert.equal(born.strategyId, 'gamma');
  } finally {
    s.close();
  }
});

test('registerStrategies refuses a menu with no strategies and a missing factory', async () => {
  const s = await makeStack();
  try {
    const reg = new AgentRegistry();
    assert.throws(() => reg.registerStrategies('scout', [], () => {
      throw new Error('unreachable');
    }), /REGISTRY_NO_STRATEGIES|at least one strategy/);
    assert.throws(
      // Justified cast: deliberately passing a non-function to the factory slot.
      () => reg.registerStrategies('scout', ['a'], undefined as unknown as never),
      /REGISTRY_NO_FACTORY|factory function/,
    );
  } finally {
    s.close();
  }
});
