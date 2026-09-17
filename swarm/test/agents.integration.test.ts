/**
 * test/agents.integration.test.ts — scout + seller + treasury, wired to the real
 * simulated channels, run for many ticks in supervisor order. This is the test
 * that catches what unit tests cannot: that the three agents actually compose,
 * that the ledger stays verifiable under real traffic, that the agents' own
 * bookkeeping never drifts from the books, and that no ToS-refusing path is
 * ever reached. Fully deterministic: TestClock + makeRng(seed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ScoutAgent, SCOUT_STRATEGIES } from '../src/agents/scout.js';
import { SellerAgent, SELLER_STRATEGIES } from '../src/agents/seller.js';
import { TreasuryAgent } from '../src/agents/treasury.js';
import { makeStack, type Stack } from './agents.harness.js';

const TICKS = 60;

async function runSwarm(seed: number): Promise<{
  s: Stack;
  scout: ScoutAgent;
  seller: SellerAgent;
  treasury: TreasuryAgent;
  ksaBuyAttempts: number;
  dpBuyAttempts: number;
}> {
  const s = await makeStack({ ARES_WINDOW_TICKS: '10', ARES_MAX_ACTIONS: '6' }, { seed });
  const reg = s.registry;
  reg.registerStrategies('scout', [...SCOUT_STRATEGIES], (id, strat, deps) => new ScoutAgent(id, strat, deps));
  reg.registerStrategies('seller', [...SELLER_STRATEGIES], (id, strat, deps) => new SellerAgent(id, strat, deps));

  // Instrument the two paths that must NEVER be entered.
  let ksaBuyAttempts = 0;
  let dpBuyAttempts = 0;
  const ke = s.channels.get('ksa_ecom');
  const dp = s.channels.get('dataproducts');
  assert.ok(ke && dp);
  const keBuy = ke.buy.bind(ke);
  (ke as unknown as { buy: typeof ke.buy }).buy = async (...a: Parameters<typeof ke.buy>) => {
    ksaBuyAttempts++;
    return keBuy(...a);
  };
  const dpBuy = dp.buy.bind(dp);
  (dp as unknown as { buy: typeof dp.buy }).buy = async (...a: Parameters<typeof dp.buy>) => {
    dpBuyAttempts++;
    return dpBuy(...a);
  };

  const scout = new ScoutAgent('scout-1', 'edge-hunter', s.depsFor('scout-1'));
  const seller = new SellerAgent('seller-1', 'margin-keeper', s.depsFor('seller-1'));
  const treasury = new TreasuryAgent('treasury-1', 'auditor', s.depsFor('treasury-1'), {
    registry: reg,
    depsFor: (id) => s.depsFor(id),
  });
  reg.register(scout);
  reg.register(seller);
  reg.register(treasury);

  for (let t = 0; t < TICKS; t++) {
    // The supervisor's ordering: scouts, then sellers, then the treasury last.
    for (const a of reg.activeByRole('scout')) await a.runTick(t);
    for (const a of reg.activeByRole('seller')) await a.runTick(t);
    for (const a of reg.activeByRole('treasury')) await a.runTick(t);
    await s.bus.drain();
    s.clock.advance(5_000);
  }
  return { s, scout, seller, treasury, ksaBuyAttempts, dpBuyAttempts };
}

test('the three agents compose for 60 ticks without breaking the ledger or each other', async () => {
  const run = await runSwarm(1337);
  const { s, scout, seller, treasury } = run;
  try {
    // 1. The books are intact, whatever else happened.
    assert.equal(s.ledger.verify().ok, true, 'the hash chain survived real traffic');
    assert.ok(s.ledger.size() > 1, 'something actually happened');
    for (const e of s.ledger.entries()) {
      assert.equal(e.legs.reduce((a, l) => a + l.amount, 0), 0, `entry ${e.seq} (${e.type}) must balance`);
      assert.equal(e.currency, 'SAR');
    }

    // 2. The refusals held for the whole run.
    assert.equal(run.ksaBuyAttempts, 0, 'ksa_ecom.buy() must never be entered');
    assert.equal(run.dpBuyAttempts, 0, 'dataproducts has no buy path and none was attempted');

    // 3. Nobody crashed.
    assert.equal(scout.crashes, 0, `scout crashed: ${String(scout.snapshot().lastError)}`);
    assert.equal(seller.crashes, 0, `seller crashed: ${String(seller.snapshot().lastError)}`);
    assert.equal(treasury.crashes, 0, `treasury crashed: ${String(treasury.snapshot().lastError)}`);

    // 4. If the swarm halted, it was a risk limit doing its job — not corruption.
    if (s.killSwitch.tripped) {
      assert.match(String(s.killSwitch.reason), /drawdown/, 'the only acceptable halt here');
    }

    // 5. No cash was left promised to a reservation nobody settled.
    assert.deepEqual(s.budget.openReservations(), []);

    // 6. The agents' own bookkeeping matches the books exactly. This is the
    //    phantom-inventory check: the inventory account must equal the carrying
    //    value the seller thinks it is holding.
    const carrying = seller.holdings().reduce((a, h) => a + h.remaining * h.unitCostMinor, 0);
    assert.equal(s.ledger.balanceOf('inventory'), carrying, 'no phantom (or missing) inventory');

    // 7. The accounting identity: cash = equity credits - everything spent.
    const b = s.ledger.balances();
    assert.equal(
      b.cash + b.inventory + b.cogs + b.fees + b.compute + b.writeoff + b.revenue + b.equity,
      0,
      'every account together must still sum to zero',
    );

    // 8. The treasury audited every tick it was allowed to.
    assert.ok(treasury.stats().audits >= 1);
    assert.ok(s.of('AUDIT_TICK').length >= 1);
    assert.ok(treasury.stats().lastJudgedWindow >= 0, 'at least one window was judged');
  } finally {
    s.close();
  }
});

test('the same seed produces the same run, twice', async () => {
  const a = await runSwarm(4242);
  const b = await runSwarm(4242);
  try {
    const fingerprint = (s: Stack): string =>
      s.ledger
        .entries()
        .map((e) => `${e.tick}|${e.type}|${e.agentId}|${e.legs.map((l) => `${l.account}:${l.amount}`).join(',')}`)
        .join('\n');
    assert.equal(fingerprint(a.s), fingerprint(b.s), 'a seeded run must replay byte for byte');
    assert.equal(a.s.ledger.head(), b.s.ledger.head(), 'identical chains must have identical heads');
    assert.deepEqual(a.scout.learner.weights(), b.scout.learner.weights());
    assert.deepEqual(a.seller.stats(), b.seller.stats());
    assert.deepEqual(a.treasury.stats(), b.treasury.stats());
  } finally {
    a.s.close();
    b.s.close();
  }
});

test('the swarm stops dead the moment the kill switch is pulled mid-run', async () => {
  const s = await makeStack({ ARES_WINDOW_TICKS: '10' }, { seed: 7 });
  try {
    const reg = s.registry;
    const scout = new ScoutAgent('scout-1', 'edge-hunter', s.depsFor('scout-1'));
    const seller = new SellerAgent('seller-1', 'volume-mover', s.depsFor('seller-1'));
    const treasury = new TreasuryAgent('treasury-1', 'auditor', s.depsFor('treasury-1'), { registry: reg });
    reg.register(scout);
    reg.register(seller);
    reg.register(treasury);

    for (let t = 0; t < 12; t++) {
      for (const a of [scout, seller, treasury]) await a.runTick(t);
      await s.bus.drain();
      s.clock.advance(5_000);
    }
    const sizeBefore = s.ledger.size();
    s.killSwitch.trip('operator pulled the halt file');

    for (let t = 12; t < 20; t++) {
      for (const a of [scout, seller, treasury]) await a.runTick(t);
      await s.bus.drain();
      s.clock.advance(5_000);
    }
    assert.equal(s.ledger.size(), sizeBefore, 'not one further entry after the halt');
    assert.equal(s.budget.availableCash('scout-1'), 0);
    assert.equal(s.ledger.verify().ok, true);
    assert.equal(scout.crashes + seller.crashes + treasury.crashes, 0);
  } finally {
    s.close();
  }
});
