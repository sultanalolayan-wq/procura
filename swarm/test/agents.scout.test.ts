/**
 * test/agents.scout.test.ts — the buyer's two bars and its one learning rule.
 * Pins: a high-apparent-margin, low-confidence opportunity is refused; ksa_ecom's
 * buy() is NEVER reached because policy denies it first; a purchase is booked as
 * a balanced double entry under an idempotency key; and the bandit's reward is
 * the REALISED margin correlated by traceId, never the estimate at buy time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { money } from '../src/core/money.js';
import type { Envelope } from '../src/bus/protocol.js';
import {
  ScoutAgent,
  SCOUT_ARMS,
  passesThresholds,
  scoreOpportunity,
  type ScoutArm,
} from '../src/agents/scout.js';
import { makeStack, StubAdapter } from './agents.harness.js';

const ONE: ScoutArm = { id: 'only', minMarginRatio: 0.2, minConfidence: 0.8, qty: 1 };
const LOOSE: ScoutArm = { id: 'only', minMarginRatio: 0.0, minConfidence: 0.0, qty: 1 };

/* --------------------------------------------------------- the scoring rule */

test('scoreOpportunity prices the WHOLE round trip, not just the ask', () => {
  const o = {
    id: 'o',
    channel: 'c',
    sku: 's',
    title: 't',
    askPrice: money(1_000, 'SAR'),
    estResaleValue: money(2_000, 'SAR'),
    confidence: 0.9,
    ttlTicks: 3,
    meta: {},
  };
  const s = scoreOpportunity(o, 25, 900);
  assert.equal(s.allInMinor, 1_025, 'ask + buy commission');
  assert.equal(s.expectedNetMinor, 2_000 - 180 - 1_025, 'sell commission comes out too');
  assert.equal(Number(s.marginRatio.toFixed(6)), Number((795 / 1_025).toFixed(6)));

  // A zero-cost (mintable) opportunity has no buy margin ratio at all.
  const free = scoreOpportunity({ ...o, askPrice: money(0, 'SAR') }, 0, 900);
  assert.equal(free.marginRatio, 0);
  assert.equal(passesThresholds(free, LOOSE, { margin: 1, confidence: 1 }), true);
});

test('BOTH bars must clear: apparent margin alone is never enough', () => {
  const base = { allInMinor: 1_000, expectedNetMinor: 900, marginRatio: 0.9, confidence: 0.95 };
  const t = { margin: 1, confidence: 1 };
  assert.equal(passesThresholds(base, ONE, t), true);
  // Enormous apparent margin, but the estimate behind it is barely better than
  // a guess. This is exactly the trade the simulator is built to punish.
  assert.equal(passesThresholds({ ...base, confidence: 0.2 }, ONE, t), false);
  // Rock-solid estimate, but no edge left after fees.
  assert.equal(passesThresholds({ ...base, expectedNetMinor: 10, marginRatio: 0.01 }, ONE, t), false);
  assert.equal(passesThresholds({ ...base, expectedNetMinor: 0, marginRatio: 0 }, ONE, t), false);
  // A tighter strategy raises both bars on the same arm.
  assert.equal(passesThresholds({ ...base, marginRatio: 0.25 }, ONE, { margin: 1.6, confidence: 1.06 }), false);
});

/* ------------------------------------------------------- the refusal in situ */

test('the scout refuses a low-confidence, high-apparent-margin opportunity', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', quoteFeeMinor: 25 });
  // A 200% apparent margin — and a confidence of 0.10, i.e. nearly no signal.
  stub.opportunities = [
    stub.opportunity({ askPrice: money(1_000, 'SAR'), estResaleValue: money(3_000, 'SAR'), confidence: 0.1 }),
  ];
  const s = await makeStack({}, { channels: [], extraChannels: new Map([['digitalassets', stub]]) });
  try {
    const scout = new ScoutAgent('scout-1', 'edge-hunter', s.depsFor('scout-1'), { arms: [ONE] });
    for (let t = 0; t < 5; t++) await scout.runTick(t);
    await s.bus.drain();

    assert.equal(stub.calls['buy'], 0, 'the scout must not buy on a guess');
    assert.equal(s.of('OPPORTUNITY_FOUND').length, 0, 'it was not even surfaced as a candidate');
    assert.ok(scout.stats().refusals >= 5);
    assert.equal(s.ledger.entries({ type: 'BUY' }).length, 0);

    // Raise the confidence alone and the SAME opportunity is now taken.
    stub.opportunities = [
      stub.opportunity({ askPrice: money(1_000, 'SAR'), estResaleValue: money(3_000, 'SAR'), confidence: 0.95 }),
    ];
    await scout.runTick(5);
    await s.bus.drain();
    assert.equal(stub.calls['buy'], 1, 'confidence was the only thing missing');
  } finally {
    s.close();
  }
});

/* ---------------------------------------------------- the ToS-refusing channel */

test('the scout never calls ksa_ecom.buy(): policy denies it first', async () => {
  const s = await makeStack({}, { channels: ['ksa_ecom'], seed: 9 });
  try {
    const ke = s.channels.get('ksa_ecom');
    assert.ok(ke);
    let buyAttempts = 0;
    const original = ke.buy.bind(ke);
    // Justified cast: instrumenting the method to prove it is NEVER entered.
    (ke as unknown as { buy: typeof ke.buy }).buy = async (...args: Parameters<typeof ke.buy>) => {
      buyAttempts++;
      return original(...args);
    };

    // A completely unfiltered arm: nothing but policy can stop this scout.
    const scout = new ScoutAgent('scout-ksa', 'edge-hunter', s.depsFor('scout-ksa'), { arms: [LOOSE] });
    for (let t = 0; t < 12; t++) await scout.runTick(t);
    await s.bus.drain();

    assert.equal(buyAttempts, 0, 'ksa_ecom.buy() was never entered');
    assert.equal(s.ledger.entries({ type: 'BUY' }).length, 0);
    assert.equal(scout.crashes, 0, 'a policy refusal is not a crash');

    const denials = s.policy.decisions().filter((d) => !d.allowed);
    assert.ok(denials.length >= 1, 'policy recorded the refusal');
    assert.equal(denials[0]?.rule, 'buy.human_approval');
    assert.match(String(denials[0]?.reason), /terms of service/i);
    assert.deepEqual(scout.stats().policyBlocked, ['ksa_ecom']);

    const emitted = s.of('POLICY_DENIED').filter((e) => e.from === 'scout-ksa');
    assert.equal(emitted.length, 1, 'denied once, then the channel is remembered as blocked');
    assert.equal((emitted[0]?.payload as { stage: string }).stage, 'buy');
  } finally {
    s.close();
  }
});

test('the scout skips dataproducts entirely: that channel has no buy path at all', async () => {
  const s = await makeStack({}, { channels: ['dataproducts'], seed: 5 });
  try {
    const dp = s.channels.get('dataproducts');
    assert.ok(dp);
    assert.equal(dp.capabilities.canBuy, false);
    let scans = 0;
    const originalScan = dp.scan.bind(dp);
    (dp as unknown as { scan: typeof dp.scan }).scan = async (...a: Parameters<typeof dp.scan>) => {
      scans++;
      return originalScan(...a);
    };
    const scout = new ScoutAgent('scout-dp', 'edge-hunter', s.depsFor('scout-dp'), { arms: [LOOSE] });
    for (let t = 0; t < 6; t++) await scout.runTick(t);
    assert.equal(scans, 0, 'a sell-only channel is not even scanned for buying');
    assert.equal(scout.stats().buys, 0);
  } finally {
    s.close();
  }
});

/* ---------------------------------------------------------------- the buy path */

test('a purchase reserves, books a balanced entry and hands the holding on', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', quoteFeeMinor: 40 });
  stub.opportunities = [
    stub.opportunity({ askPrice: money(1_000, 'SAR'), estResaleValue: money(2_500, 'SAR'), confidence: 0.96 }),
  ];
  const s = await makeStack({}, { channels: [], extraChannels: new Map([['digitalassets', stub]]) });
  try {
    const scout = new ScoutAgent('scout-buy', 'edge-hunter', s.depsFor('scout-buy'), { arms: [ONE] });
    await scout.runTick(1);
    await s.bus.drain();

    assert.equal(stub.calls['buy'], 1);
    const buys = s.ledger.entries({ type: 'BUY' });
    assert.equal(buys.length, 1);
    const legs = buys[0]!.legs;
    assert.deepEqual(
      legs.map((l) => [l.account, l.amount]),
      [
        ['inventory', 1_000],
        ['fees', 40],
        ['cash', -1_040],
      ],
    );
    assert.equal(legs.reduce((a, l) => a + l.amount, 0), 0);
    assert.equal(buys[0]!.meta['arm'], 'only');
    assert.ok(String(buys[0]!.idempotencyKey).length > 0);

    assert.equal(s.budget.openReservations('scout-buy').length, 0, 'the reservation was committed');
    const added = s.of('INVENTORY_ADDED');
    assert.equal(added.length, 1);
    assert.equal((added[0]?.payload as { costMinor: number }).costMinor, 1_040);
    assert.equal(scout.trades().length, 1);
    assert.equal(scout.trades()[0]?.costMinor, 1_040);
    assert.equal(s.ledger.verify().ok, true);

    // One purchase per tick: capital is finite and the cap is deliberate.
    stub.opportunities = [
      stub.opportunity({ askPrice: money(900, 'SAR'), estResaleValue: money(2_500, 'SAR'), confidence: 0.96 }),
      stub.opportunity({ askPrice: money(950, 'SAR'), estResaleValue: money(2_500, 'SAR'), confidence: 0.96 }),
    ];
    await scout.runTick(2);
    assert.equal(stub.calls['buy'], 2);
  } finally {
    s.close();
  }
});

test('a halted swarm stops the scout before any adapter is touched', async () => {
  const stub = new StubAdapter({ name: 'digitalassets' });
  stub.opportunities = [stub.opportunity({ confidence: 0.99 })];
  const s = await makeStack({}, { channels: [], extraChannels: new Map([['digitalassets', stub]]) });
  try {
    const scout = new ScoutAgent('scout-halt', 'edge-hunter', s.depsFor('scout-halt'), { arms: [LOOSE] });
    s.killSwitch.trip('operator halt');
    for (let t = 0; t < 4; t++) await scout.runTick(t);
    assert.equal(stub.calls['scan'], 0);
    assert.equal(stub.calls['buy'], 0);
  } finally {
    s.close();
  }
});

/* --------------------------------------- the single most important learning bug */

test('the bandit learns from the REALISED margin, not the estimate at purchase time', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', quoteFeeMinor: 0 });
  // Apparent margin: +1,000 on a 1,000 outlay. The estimate is pure optimism.
  stub.opportunities = [
    stub.opportunity({ askPrice: money(1_000, 'SAR'), estResaleValue: money(2_000, 'SAR'), confidence: 0.99 }),
  ];
  const s = await makeStack({}, { channels: [], extraChannels: new Map([['digitalassets', stub]]) });
  try {
    const scout = new ScoutAgent('scout-learn', 'edge-hunter', s.depsFor('scout-learn'), { arms: [ONE] });
    await scout.runTick(1);
    await s.bus.drain();

    const trade = scout.trades()[0];
    assert.ok(trade);
    assert.equal(trade.costMinor, 1_000);
    assert.equal(trade.estMarginMinor, 1_000, 'the optimistic estimate is recorded...');
    const before = scout.learner.weights()['only'];
    assert.ok(before);
    assert.equal(before.n, 0, '...but nothing has been learned from it yet');

    // The market disagrees: it actually resold for 600, net of a 40 fee -> 560.
    const inv = s.of('INVENTORY_ADDED')[0];
    assert.ok(inv);
    s.bus.publish({
      type: 'SALE_FILLED',
      from: 'seller-x',
      tick: 9,
      traceId: inv.traceId,
      payload: {
        channel: 'digitalassets',
        holdingId: trade.holdingId,
        sku: trade.sku,
        qty: 1,
        grossMinor: 600,
        feeMinor: 40,
        cogsMinor: 1_000,
        proceedsMinor: 560,
        netMinor: -440,
        remaining: 0,
        disposition: 'sold',
        traceId: inv.traceId,
        tick: 9,
      },
    });
    await s.bus.drain();

    const after = scout.learner.weights()['only'];
    assert.ok(after);
    assert.equal(after.n, 1, 'the arm was updated exactly once');
    assert.equal(after.b, before.b + 1, 'a FAILURE was recorded');
    assert.equal(after.a, before.a, 'the optimistic estimate earned no credit at all');

    // And the survival evaluator saw the realised loss, not the estimate.
    const outcomes = s.survival.outcomes('scout-learn');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.netMinor, 560 - 1_000, 'proceeds minus the all-in cost');
    assert.equal(outcomes[0]?.success, false);
    assert.equal(outcomes[0]?.meta['estMarginMinor'], 1_000, 'the estimate is kept, for audit only');
    assert.equal(outcomes[0]?.meta['realisedMinor'], -440);
    assert.equal(scout.trades().length, 0, 'the trade is closed');
  } finally {
    s.close();
  }
});

test('a genuinely profitable round trip rewards the arm', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', quoteFeeMinor: 0 });
  stub.opportunities = [
    stub.opportunity({ askPrice: money(1_000, 'SAR'), estResaleValue: money(2_000, 'SAR'), confidence: 0.99 }),
  ];
  const s = await makeStack({}, { channels: [], extraChannels: new Map([['digitalassets', stub]]) });
  try {
    const scout = new ScoutAgent('scout-win', 'edge-hunter', s.depsFor('scout-win'), { arms: [ONE] });
    await scout.runTick(1);
    await s.bus.drain();
    const inv = s.of('INVENTORY_ADDED')[0];
    assert.ok(inv);
    const trade = scout.trades()[0];
    assert.ok(trade);
    s.bus.publish({
      type: 'SALE_FILLED',
      from: 'seller-x',
      tick: 9,
      traceId: inv.traceId,
      payload: { qty: 1, proceedsMinor: 1_400, remaining: 0, holdingId: trade.holdingId, traceId: inv.traceId, tick: 9 },
    });
    await s.bus.drain();
    const after = scout.learner.weights()['only'];
    assert.equal(after?.a, 2, 'prior 1 plus one success');
    assert.equal(after?.b, 1);
    assert.equal(s.survival.outcomes('scout-win')[0]?.netMinor, 400);
  } finally {
    s.close();
  }
});

test('a trade that never sells is still learned from, as the loss it is', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', quoteFeeMinor: 0 });
  stub.opportunities = [
    stub.opportunity({ askPrice: money(1_000, 'SAR'), estResaleValue: money(2_000, 'SAR'), confidence: 0.99 }),
  ];
  const s = await makeStack({}, { channels: [], extraChannels: new Map([['digitalassets', stub]]) });
  try {
    const scout = new ScoutAgent('scout-stale', 'edge-hunter', s.depsFor('scout-stale'), {
      arms: [ONE],
      tradeResolutionTicks: 3,
    });
    await scout.runTick(1);
    await s.bus.drain();
    assert.equal(scout.trades().length, 1);
    stub.opportunities = [];
    await scout.runTick(5);
    await s.bus.drain();
    assert.equal(scout.trades().length, 0, 'force-resolved after the timeout');
    const o = s.survival.outcomes('scout-stale')[0];
    assert.equal(o?.netMinor, -1_000, 'the whole outlay, lost');
    assert.equal(o?.meta['how'], 'unresolved_timeout');
    assert.equal(scout.learner.weights()['only']?.b, 2);
  } finally {
    s.close();
  }
});

test('the default arms span a real range and the bandit knows all of them', async () => {
  const s = await makeStack({}, { channels: ['digitalassets'] });
  try {
    const scout = new ScoutAgent('scout-arms', 'edge-hunter', s.depsFor('scout-arms'));
    assert.deepEqual(scout.learner.armNames(), SCOUT_ARMS.map((a) => a.id));
    assert.ok(SCOUT_ARMS.length >= 2);
    for (const a of SCOUT_ARMS) {
      assert.ok(a.minMarginRatio > 0 && a.minConfidence > 0, 'no arm may drop a bar to zero');
    }
  } finally {
    s.close();
  }
});

test('the scout survives an adapter that throws and opens its circuit', async () => {
  const stub = new StubAdapter({ name: 'digitalassets' });
  stub.opportunities = [stub.opportunity({ confidence: 0.99 })];
  stub.buyThrows = new Error('marketplace down');
  const s = await makeStack({}, { channels: [], extraChannels: new Map([['digitalassets', stub]]) });
  try {
    const scout = new ScoutAgent('scout-circuit', 'edge-hunter', s.depsFor('scout-circuit'), {
      arms: [LOOSE],
      circuit: { failureThreshold: 2, cooldownMs: 60_000, halfOpenMax: 1 },
    });
    for (let t = 0; t < 5; t++) await scout.runTick(t);
    await s.bus.drain();
    assert.ok(scout.crashes >= 2, 'the failures were counted, not swallowed silently');
    assert.equal(s.budget.openReservations('scout-circuit').length, 0, 'every failed buy gave its cash back');
    assert.ok(stub.calls['buy']! <= 2, 'the circuit stopped hammering a dead channel');
    const results = s.of('BUY_RESULT').filter((e: Envelope) => (e.payload as { ok: boolean }).ok === false);
    assert.ok(results.length >= 1);
  } finally {
    s.close();
  }
});
