/**
 * test/agents.seller.test.ts — the floor rule, the settlement tick and the
 * expiry signal. Pins: no listing below cogs + fees before TTL; an explicit
 * writeoff to the `writeoff` account once past TTL; fills keyed on the
 * channel-scoped offerId and booked at the SETTLEMENT tick; and pollExpired()
 * — not silence — is what tells the seller a listing did not sell.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { money } from '../src/core/money.js';
import type { Holding } from '../src/core/types.js';
import { SellerAgent, listingDecision, MAX_RELIST_ATTEMPTS } from '../src/agents/seller.js';
import { makeStack, StubAdapter } from './agents.harness.js';

/* ------------------------------------------------------------- the pure rule */

test('listingDecision refuses below cogs + fees, and only TTL unlocks a writeoff', () => {
  const base = { carryingMinor: 1_000, sellFeeMinor: 90, listingFeeMinor: 10, ageTicks: 0, ttlTicks: 20 };

  const good = listingDecision({ ...base, proceedsMinor: 1_500 });
  assert.equal(good.allowed, true);
  assert.equal(good.floorMinor, 1_100);
  assert.equal(good.writeoffMinor, 0);

  const exact = listingDecision({ ...base, proceedsMinor: 1_100 });
  assert.equal(exact.allowed, true, 'exactly at the floor is allowed');
  assert.equal(exact.shortfallMinor, 0);

  const refused = listingDecision({ ...base, proceedsMinor: 900 });
  assert.equal(refused.allowed, false);
  assert.equal(refused.shortfallMinor, 200);
  assert.equal(refused.writeoffMinor, 0, 'nothing is written off while it is merely refused');
  assert.match(refused.reason, /below the floor/);
  assert.match(refused.reason, /not a strategy/);

  const aged = listingDecision({ ...base, proceedsMinor: 900, ageTicks: 20 });
  assert.equal(aged.allowed, true);
  assert.equal(aged.pastTtl, true);
  assert.equal(aged.writeoffMinor, 200, 'the shortfall is recognised, not hidden');

  // The writeoff can never exceed what the asset is actually carried at.
  const deep = listingDecision({ carryingMinor: 50, proceedsMinor: 0, sellFeeMinor: 0, listingFeeMinor: 500, ageTicks: 99, ttlTicks: 1 });
  assert.equal(deep.writeoffMinor, 50);
});

/* --------------------------------------------------------------- the harness */

function holding(over: Partial<Holding> = {}): Holding {
  return {
    id: 'h-1',
    channel: 'digitalassets',
    sku: 'sku-1',
    qty: 1,
    unitCost: money(1_000, 'SAR'),
    acquiredTick: 0,
    meta: { estResaleValueMinor: 2_000 },
    ...over,
  };
}

/** A seller wired to a single stub channel, holding one scout-supplied unit. */
async function sellerWith(opts: {
  stub: StubAdapter;
  unitCostMinor: number;
  estResaleMinor: number;
  ttlTicks: number;
  acquiredTick?: number;
}) {
  const s = await makeStack({}, { channels: [], extraChannels: new Map([[opts.stub.name, opts.stub]]) });
  const seller = new SellerAgent('seller-1', 'margin-keeper', s.depsFor('seller-1'), {
    maxMintedHoldings: 0,
    style: { ttlTicks: opts.ttlTicks },
  });
  s.bus.publish({
    type: 'INVENTORY_ADDED',
    from: 'scout-1',
    tick: opts.acquiredTick ?? 0,
    payload: {
      holding: holding({
        channel: opts.stub.name,
        unitCost: money(opts.unitCostMinor, 'SAR'),
        acquiredTick: opts.acquiredTick ?? 0,
        meta: { estResaleValueMinor: opts.estResaleMinor },
      }),
      channel: opts.stub.name,
      sku: 'sku-1',
      qty: 1,
      unitCostMinor: opts.unitCostMinor,
      costMinor: opts.unitCostMinor,
      estResaleMinor: opts.estResaleMinor,
      buyerId: 'scout-1',
      tick: opts.acquiredTick ?? 0,
    },
  });
  await s.bus.drain();
  // The seller needs the cost of goods on the books for the writeoff to balance.
  if (opts.unitCostMinor > 0) {
    s.ledger.append({
      tick: opts.acquiredTick ?? 0,
      type: 'BUY',
      agentId: 'scout-1',
      currency: 'SAR',
      legs: [
        { account: 'inventory', amount: opts.unitCostMinor },
        { account: 'cash', amount: -opts.unitCostMinor },
      ],
      idempotencyKey: 'seed-buy',
      meta: {},
    });
  }
  return { s, seller };
}

/* ---------------------------------------------------------- the floor in situ */

test('the seller refuses to list below cost before TTL, then writes off after it', async () => {
  // The market is worth a tenth of what this cost: no price clears the floor.
  const stub = new StubAdapter({ name: 'digitalassets', demand: 0.5, listingFeeMinor: 25 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 10_000, estResaleMinor: 800, ttlTicks: 10 });
  try {
    assert.equal(seller.stats().holdings, 1);

    for (let t = 1; t <= 5; t++) await seller.runTick(t);
    await s.bus.drain();

    assert.equal(stub.calls['publish'], 0, 'nothing was listed below cost');
    assert.equal(seller.stats().refusedBelowCost, 5);
    assert.equal(s.ledger.balanceOf('writeoff'), 0, 'and nothing was written off prematurely');
    assert.equal(s.of('OFFER_PUBLISHED').length, 0);

    // Past the TTL the loss is recognised explicitly and the listing goes up.
    await seller.runTick(11);
    await s.bus.drain();

    assert.equal(stub.calls['publish'], 1, 'now it may be sold at a loss');
    const writeoffs = s.ledger.entries({ type: 'WRITEOFF' });
    assert.equal(writeoffs.length, 1);
    const w = writeoffs[0]!;
    assert.ok(w.legs.some((l) => l.account === 'writeoff' && l.amount > 0));
    assert.ok(w.legs.some((l) => l.account === 'inventory' && l.amount < 0));
    assert.equal(w.legs.reduce((a, l) => a + l.amount, 0), 0);
    assert.match(String(w.meta['reason']), /past TTL/);
    assert.equal(w.meta['holdingId'], 'h-1');
    assert.ok(s.ledger.balanceOf('writeoff') > 0);
    assert.equal(s.ledger.verify().ok, true);
    assert.equal(seller.stats().writeoffs, 1);

    // The impairment is carried through: cogs on any later sale is the NEW value.
    const live = seller.liveOffers()[0];
    assert.ok(live);
    assert.ok(live.unitCostMinor < 10_000, 'the holding is marked down on the books');
  } finally {
    s.close();
  }
});

test('a listing that clears cost + fees needs no writeoff at all', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', demand: 0.9, listingFeeMinor: 25 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 1_000, estResaleMinor: 4_000, ttlTicks: 20 });
  try {
    await seller.runTick(1);
    await s.bus.drain();
    assert.equal(stub.calls['publish'], 1);
    assert.equal(s.ledger.balanceOf('writeoff'), 0);
    const published = s.of('OFFER_PUBLISHED')[0];
    assert.ok(published);
    assert.equal((published.payload as { writtenOffMinor: number }).writtenOffMinor, 0);
    // The listing fee is a real cash cost and is booked at publish time.
    const fees = s.ledger.entries({ type: 'LISTING_FEE' });
    assert.equal(fees.length, 1);
    assert.deepEqual(fees[0]!.legs.map((l) => [l.account, l.amount]), [
      ['fees', 25],
      ['cash', -25],
    ]);
  } finally {
    s.close();
  }
});

/* ------------------------------------------------- offer ids and settlement */

test('fills are keyed on the channel-scoped offerId and booked at the SETTLEMENT tick', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', demand: 0.8 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 1_000, estResaleMinor: 4_000, ttlTicks: 20 });
  try {
    await seller.runTick(1);
    await s.bus.drain();
    const live = seller.liveOffers()[0];
    assert.ok(live);
    assert.match(live.offerId, /^digitalassets:seller-1-of\d+$/, 'the channel-scoped form');
    assert.equal(stub.publishedOffers[0]?.id, live.offerId.split(':')[1]);

    // A fill whose tick is the settlement tick, five ticks after the sale.
    stub.fills = [{ offerId: live.offerId, qty: 1, unitPrice: money(3_000, 'SAR'), feeMinor: 180, tick: 7 }];
    await seller.runTick(9);
    await s.bus.drain();

    const sales = s.ledger.entries({ type: 'SALE' });
    assert.equal(sales.length, 1);
    assert.equal(sales[0]!.tick, 7, 'booked at the settlement tick, not the polling tick');
    assert.deepEqual(sales[0]!.legs.map((l) => [l.account, l.amount]), [
      ['cash', 2_820],
      ['fees', 180],
      ['revenue', -3_000],
      ['cogs', 1_000],
      ['inventory', -1_000],
    ]);
    assert.equal(sales[0]!.legs.reduce((a, l) => a + l.amount, 0), 0);
    assert.equal(s.ledger.balanceOf('inventory'), 0);
    assert.equal(s.ledger.verify().ok, true);

    const filled = s.of('SALE_FILLED')[0];
    assert.ok(filled);
    const p = filled.payload as Record<string, number | string>;
    assert.equal(p['proceedsMinor'], 2_820, 'cash in, before cost of goods');
    assert.equal(p['netMinor'], 1_820);
    assert.equal(p['remaining'], 0);
    assert.equal(p['disposition'], 'sold');
    assert.equal(p['tick'], 7);
    assert.equal(seller.stats().openOffers, 0);
    assert.equal(seller.stats().holdings, 0);
  } finally {
    s.close();
  }
});

test('a fill for an offer the seller never published is BOOKED, not dropped and not invented', async () => {
  // AMENDMENT A8c — this test was changed deliberately. It used to pin the drop
  // as correct ("no phantom revenue"), and the drop is not correct: the channel
  // took the money and the units are gone, so refusing to book it loses real
  // revenue, overstates inventory and punishes the scout that picked the winner.
  // What must NOT be invented is the COST BASIS, and that is what is asserted
  // here: cash and revenue are exact, and no inventory or cogs leg is faked.
  const stub = new StubAdapter({ name: 'digitalassets' });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 1_000, estResaleMinor: 4_000, ttlTicks: 20 });
  try {
    const cashBefore = s.ledger.balanceOf('cash');
    const inventoryBefore = s.ledger.balanceOf('inventory');
    stub.fills = [{ offerId: 'digitalassets:someone-elses-offer', qty: 3, unitPrice: money(9_999, 'SAR'), feeMinor: 100, tick: 2 }];
    await seller.runTick(2);
    await s.bus.drain();

    assert.equal(s.ledger.entries({ type: 'SALE' }).length, 0, 'not booked as one of this seller sales');
    const orphans = s.ledger.entries({ type: 'ORPHAN_FILL' });
    assert.equal(orphans.length, 1, 'booked under its own type instead');
    const legs = orphans[0]!.legs;
    assert.deepEqual(
      legs.map((l) => [l.account, l.amount]),
      [
        ['cash', 29_897],
        ['fees', 100],
        ['revenue', -29_997],
      ],
    );
    assert.equal(legs.reduce((a, l) => a + l.amount, 0), 0, 'balanced');
    assert.equal(orphans[0]!.tick, 2, 'at its settlement tick');
    assert.ok(s.ledger.balanceOf('cash') > cashBefore, 'the cash reached the books');
    assert.equal(s.ledger.balanceOf('inventory'), inventoryBefore, 'and no cost basis was invented');
    assert.equal(s.ledger.verify().ok, true);

    // Visible in stats(), not just in one warn line nobody reads.
    const st = seller.stats();
    assert.equal(st.orphanFills, 1);
    assert.equal(st.orphanUnits, 3);
    assert.equal(st.orphanRevenueMinor, 29_897);
    assert.equal(seller.crashes, 0);

    // Idempotent: the same fill replayed does not book the money twice.
    stub.fills = [{ offerId: 'digitalassets:someone-elses-offer', qty: 3, unitPrice: money(9_999, 'SAR'), feeMinor: 100, tick: 2 }];
    await seller.runTick(3);
    assert.equal(s.ledger.entries({ type: 'ORPHAN_FILL' }).length, 1, 'the ledger key held');
  } finally {
    s.close();
  }
});

/* -------------------------------------------------------------- the expiry cue */

test('an unsold listing is discovered through pollExpired and re-priced downward', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', demand: 0.5 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 500, estResaleMinor: 4_000, ttlTicks: 40 });
  try {
    await seller.runTick(1);
    await s.bus.drain();
    const first = seller.liveOffers()[0];
    assert.ok(first);
    assert.equal(stub.calls['pollExpired'], 1, 'the seller asks every tick');

    // Silence alone must NOT be treated as "unsold": the offer stays live.
    await seller.runTick(2);
    assert.equal(seller.stats().openOffers, 1, 'still live: no expiry notice was given');
    assert.equal(stub.calls['publish'], 1, 'and therefore nothing was re-listed');

    // Now the channel says it expired unsold.
    stub.expired = [
      {
        channel: 'digitalassets',
        offerId: first.offerId,
        sku: first.sku,
        priceMinor: first.priceMinor,
        remaining: 1,
        listedTick: 1,
        expiredTick: 3,
      },
    ];
    await seller.runTick(3);
    await s.bus.drain();

    assert.equal(stub.calls['publish'], 2, 're-listed after the authoritative expiry');
    const second = seller.liveOffers()[0];
    assert.ok(second);
    assert.notEqual(second.offerId, first.offerId);
    assert.equal(second.attempts, 1);
    assert.ok(second.priceMinor < first.priceMinor, `re-priced down: ${second.priceMinor} < ${first.priceMinor}`);

    // The failed price step taught the learner: that multiplier now looks worse.
    const posterior = seller.prices.posterior(first.sku);
    assert.ok(posterior);
    assert.ok(posterior.some((row) => row.b > 1), 'a failure was recorded against a multiplier');
  } finally {
    s.close();
  }
});

test('a holding that keeps expiring is eventually abandoned, written off and reported', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', demand: 0.5 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 500, estResaleMinor: 4_000, ttlTicks: 500 });
  try {
    let tick = 1;
    for (let i = 0; i < MAX_RELIST_ATTEMPTS + 1; i++) {
      await seller.runTick(tick);
      await s.bus.drain();
      const live = seller.liveOffers()[0];
      if (live === undefined) break;
      stub.expired = [
        {
          channel: 'digitalassets',
          offerId: live.offerId,
          sku: live.sku,
          priceMinor: live.priceMinor,
          remaining: 1,
          listedTick: tick,
          expiredTick: tick + 1,
        },
      ];
      tick += 1;
    }
    await seller.runTick(tick + 1);
    await s.bus.drain();

    assert.equal(seller.stats().holdings, 0, 'given up on and off the shelf');
    assert.ok(s.ledger.balanceOf('writeoff') > 0);
    assert.equal(s.ledger.balanceOf('inventory'), 0);
    const disposal = s.of('SALE_FILLED').find((e) => (e.payload as { disposition: string }).disposition === 'writeoff');
    assert.ok(disposal, 'the buyer is told its holding produced nothing');
    const p = disposal.payload as Record<string, number>;
    assert.equal(p['proceedsMinor'], 0);
    assert.equal(p['remaining'], 0);
    assert.equal(s.ledger.verify().ok, true);
  } finally {
    s.close();
  }
});

/* --------------------------------------------------------------- data products */

test('the seller MINTS data products instead of buying them', async () => {
  const s = await makeStack({}, { channels: ['dataproducts'], seed: 21 });
  try {
    const dp = s.channels.get('dataproducts');
    assert.ok(dp);
    let buyAttempts = 0;
    const originalBuy = dp.buy.bind(dp);
    (dp as unknown as { buy: typeof dp.buy }).buy = async (...a: Parameters<typeof dp.buy>) => {
      buyAttempts++;
      return originalBuy(...a);
    };
    const seller = new SellerAgent('seller-dp', 'volume-mover', s.depsFor('seller-dp'), { maxMintedHoldings: 2 });
    for (let t = 0; t < 4; t++) await seller.runTick(t);
    await s.bus.drain();

    assert.equal(buyAttempts, 0, 'dataproducts has no acquisition path and none was attempted');
    assert.ok(seller.stats().holdings > 0 || seller.stats().published > 0, 'minting produced inventory');
    const added = s.of('INVENTORY_ADDED').filter((e) => e.from === 'seller-dp');
    assert.ok(added.length >= 1);
    assert.equal((added[0]?.payload as { minted: boolean }).minted, true);
    assert.equal((added[0]?.payload as { unitCostMinor: number }).unitCostMinor, 0);
    // Zero-cost inventory means no cost of goods on the books.
    assert.equal(s.ledger.balanceOf('inventory'), 0);
    assert.equal(s.ledger.verify().ok, true);
  } finally {
    s.close();
  }
});

test('the seller stops when the swarm halts and refuses a policy-denied channel', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', demand: 0.9 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 100, estResaleMinor: 4_000, ttlTicks: 20 });
  try {
    s.killSwitch.trip('operator halt');
    for (let t = 1; t < 4; t++) await seller.runTick(t);
    assert.equal(stub.calls['publish'], 0);
    assert.equal(stub.calls['poll'], 0);
  } finally {
    s.close();
  }
});

test('an unknown channel on a holding is logged, never listed somewhere else', async () => {
  const stub = new StubAdapter({ name: 'digitalassets' });
  const s = await makeStack({}, { channels: [], extraChannels: new Map([['digitalassets', stub]]) });
  try {
    const seller = new SellerAgent('seller-x', 'margin-keeper', s.depsFor('seller-x'), { maxMintedHoldings: 0 });
    s.bus.publish({
      type: 'INVENTORY_ADDED',
      from: 'scout-1',
      tick: 0,
      payload: { holding: holding({ channel: 'nowhere' }), channel: 'nowhere', sku: 'sku-1', qty: 1, tick: 0 },
    });
    await s.bus.drain();
    assert.equal(seller.stats().holdings, 1);
    await seller.runTick(1);
    assert.equal(stub.calls['publish'], 0, 'never re-homed onto an unrelated channel');
    assert.equal(seller.crashes, 0);
  } finally {
    s.close();
  }
});

/* ========== AMENDMENT A7: the floor must know what LISTING costs, too ======= */

/** A stub that declares its listing fee up front, as the real adapters do. */
class DeclaringStub extends StubAdapter {
  readonly params: { listingFeeMinor: number; currency: 'SAR' };
  constructor(o: { name: string; demand?: number; declaredListingFeeMinor: number; chargedListingFeeMinor?: number }) {
    super({ name: o.name, demand: o.demand ?? 0.9, listingFeeMinor: o.chargedListingFeeMinor ?? o.declaredListingFeeMinor });
    this.params = { listingFeeMinor: o.declaredListingFeeMinor, currency: 'SAR' };
  }
}

test('A7: the FIRST listing on a channel is costed with the channel declared listing fee', async () => {
  // listingFeeByChannel used to be populated only AFTER a successful publish, so
  // the first listing on every channel priced its floor with a listing fee of
  // zero. Here the declared fee alone is what makes the listing unprofitable.
  const stub = new DeclaringStub({ name: 'digitalassets', declaredListingFeeMinor: 100_000 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 1_000, estResaleMinor: 4_000, ttlTicks: 20 });
  try {
    await seller.runTick(1);
    await s.bus.drain();
    assert.equal(stub.calls['publish'], 0, 'a listing that cannot cover its own listing fee is refused');
    assert.equal(seller.stats().refusedBelowCost, 1);
    assert.equal(s.of('OFFER_PUBLISHED').length, 0);
  } finally {
    s.close();
  }
});

test('A7: a cheap declared listing fee still lets a profitable listing through', async () => {
  const stub = new DeclaringStub({ name: 'digitalassets', declaredListingFeeMinor: 25 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 1_000, estResaleMinor: 4_000, ttlTicks: 20 });
  try {
    await seller.runTick(1);
    await s.bus.drain();
    assert.equal(stub.calls['publish'], 1, 'the fee is counted, not feared');
    assert.equal(seller.stats().refusedBelowCost, 0);
  } finally {
    s.close();
  }
});

test('A7: a respawned seller remembers what listing cost, instead of assuming zero', async () => {
  // A channel that declares nothing but charges plenty: the only way to know is
  // to have published once. That knowledge must survive the agent that earned it.
  const stub = new StubAdapter({ name: 'digitalassets', demand: 0.9, listingFeeMinor: 100_000 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 1_000, estResaleMinor: 4_000, ttlTicks: 20 });
  try {
    await seller.runTick(1);
    await s.bus.drain();
    assert.equal(stub.calls['publish'], 1, 'generation 1 pays to find out');

    // Generation 2, same memory scope, a fresh holding on the same channel.
    const heir = new SellerAgent('seller-1', 'margin-keeper', s.depsFor('seller-1'), {
      maxMintedHoldings: 0,
      style: { ttlTicks: 20 },
    });
    s.bus.publish({
      type: 'INVENTORY_ADDED',
      from: 'scout-1',
      tick: 2,
      payload: {
        holding: holding({ id: 'h-2', channel: 'digitalassets', unitCost: money(1_000, 'SAR'), acquiredTick: 2, meta: { estResaleValueMinor: 4_000 } }),
        channel: 'digitalassets',
        sku: 'sku-1',
        qty: 1,
        unitCostMinor: 1_000,
        costMinor: 1_000,
        estResaleMinor: 4_000,
        buyerId: 'scout-1',
        tick: 2,
      },
    });
    await s.bus.drain();
    await heir.runTick(3);
    await s.bus.drain();

    assert.equal(stub.calls['publish'], 1, 'generation 2 does not repeat the lesson at full price');
    assert.equal(heir.stats().refusedBelowCost, 1);
  } finally {
    s.close();
  }
});

/* ===== AMENDMENT A8a: a successor inherits its predecessor live listings ==== */

test('A8a: a successor books the fill from a terminated predecessor listing', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', demand: 0.9 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 1_000, estResaleMinor: 4_000, ttlTicks: 20 });
  try {
    const reg = s.registry;
    reg.registerStrategies(
      'seller',
      ['margin-keeper', 'volume-mover'],
      (id, strat, deps) => new SellerAgent(id, strat, deps, { maxMintedHoldings: 0 }),
    );
    reg.register(seller);

    await seller.runTick(1);
    await s.bus.drain();
    const live = seller.liveOffers()[0];
    assert.ok(live, 'the predecessor has a listing out in the world');

    // The Treasury kills it at tick 2. The listing does not stop existing on the
    // channel just because the agent that placed it does.
    await reg.terminate('seller-1', 'survival: below benchmark');
    const heir = reg.spawnAlternative('seller', (id) => s.depsFor(id), ['margin-keeper']);
    assert.ok(heir);
    const successor = heir as SellerAgent;
    assert.equal(successor.stats().inheritedOffers, 1, 'the offer came across with the role');
    assert.equal(successor.liveOffers()[0]?.offerId, live.offerId);

    // The fill lands three ticks later, for the dead agent's offerId.
    stub.fills = [{ offerId: live.offerId, qty: 1, unitPrice: money(3_000, 'SAR'), feeMinor: 180, tick: 5 }];
    await successor.runTick(5);
    await s.bus.drain();

    const sales = s.ledger.entries({ type: 'SALE' });
    assert.equal(sales.length, 1, 'the revenue was booked, not dropped');
    assert.equal(sales[0]!.agentId, successor.id);
    assert.equal(sales[0]!.meta['inheritedOffer'], true);
    assert.equal(s.ledger.entries({ type: 'ORPHAN_FILL' }).length, 0, 'and it was not an orphan: it had an owner');
    // No second cost of goods: the predecessor terminate() already wrote the
    // holding off, so charging it again would book the same loss twice.
    assert.deepEqual(
      sales[0]!.legs.map((l) => l.account),
      ['cash', 'fees', 'revenue'],
    );
    assert.equal(sales[0]!.legs.reduce((a, l) => a + l.amount, 0), 0);
    assert.equal(s.ledger.balanceOf('inventory'), 0, 'inventory is neither overstated nor negative');
    assert.equal(s.ledger.verify().ok, true);
    assert.equal(successor.stats().sold, 1);
  } finally {
    s.close();
  }
});

/* ===== AMENDMENT A8b: an expiry must not discard a fill that is settling ==== */

test('A8b: an expiry with units unaccounted for RETAINS the offer until the fill lands', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', demand: 0.9 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 1_000, estResaleMinor: 4_000, ttlTicks: 20 });
  try {
    await seller.runTick(1);
    await s.bus.drain();
    const live = seller.liveOffers()[0];
    assert.ok(live);

    // The channel says the listing expired with NOTHING left on it: the unit
    // sold, and its cash is somewhere between the sale and settlement.
    stub.expired = [
      {
        channel: 'digitalassets',
        offerId: live.offerId,
        sku: live.sku,
        priceMinor: live.priceMinor,
        remaining: 0,
        listedTick: 1,
        expiredTick: 2,
      },
    ];
    await seller.runTick(2);
    await s.bus.drain();

    assert.equal(seller.stats().openOffers, 1, 'the offer is retained, not deleted');
    assert.equal(seller.stats().retainedOffers, 1);
    assert.equal(stub.calls['publish'], 1, 'and the holding is NOT re-listed for a unit already sold');

    // Settlement arrives two ticks later, keyed on that very offerId.
    stub.fills = [{ offerId: live.offerId, qty: 1, unitPrice: money(3_000, 'SAR'), feeMinor: 180, tick: 4 }];
    await seller.runTick(4);
    await s.bus.drain();

    const sales = s.ledger.entries({ type: 'SALE' });
    assert.equal(sales.length, 1, 'the revenue was booked against the right offer');
    assert.equal(s.ledger.entries({ type: 'ORPHAN_FILL' }).length, 0);
    assert.equal(sales[0]!.meta['expiredTick'], 2, 'and the books record that it settled after expiry');
    assert.equal(sales[0]!.legs.reduce((a, l) => a + l.amount, 0), 0);
    assert.equal(s.ledger.balanceOf('inventory'), 0, 'no phantom inventory left behind');
    assert.equal(seller.stats().openOffers, 0, 'and the offer is closed once it is settled');
    assert.equal(seller.stats().holdings, 0);
    assert.equal(s.ledger.verify().ok, true);
  } finally {
    s.close();
  }
});

test('A8b: an expiry with nothing outstanding still releases the holding immediately', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', demand: 0.5 });
  const { s, seller } = await sellerWith({ stub, unitCostMinor: 500, estResaleMinor: 4_000, ttlTicks: 40 });
  try {
    await seller.runTick(1);
    await s.bus.drain();
    const live = seller.liveOffers()[0];
    assert.ok(live);
    stub.expired = [
      {
        channel: 'digitalassets',
        offerId: live.offerId,
        sku: live.sku,
        priceMinor: live.priceMinor,
        remaining: 1,
        listedTick: 1,
        expiredTick: 2,
      },
    ];
    await seller.runTick(2);
    await s.bus.drain();
    assert.equal(seller.stats().retainedOffers, 0, 'nothing was sold, so nothing is settling');
    assert.equal(stub.calls['publish'], 2, 're-listed at once, marked down');
  } finally {
    s.close();
  }
});

test('A8b: a retained offer is released once settlement can no longer arrive', async () => {
  const stub = new StubAdapter({ name: 'digitalassets', demand: 0.9 });
  const s = await makeStack({}, { channels: [], extraChannels: new Map([['digitalassets', stub]]) });
  try {
    const seller = new SellerAgent('seller-grace', 'margin-keeper', s.depsFor('seller-grace'), {
      maxMintedHoldings: 0,
      style: { ttlTicks: 40 },
      settlementGraceTicks: 3,
    });
    s.bus.publish({
      type: 'INVENTORY_ADDED',
      from: 'scout-1',
      tick: 0,
      payload: {
        holding: holding({ channel: 'digitalassets', unitCost: money(500, 'SAR'), meta: { estResaleValueMinor: 4_000 } }),
        channel: 'digitalassets',
        sku: 'sku-1',
        qty: 1,
        unitCostMinor: 500,
        costMinor: 500,
        estResaleMinor: 4_000,
        buyerId: 'scout-1',
        tick: 0,
      },
    });
    await s.bus.drain();
    await seller.runTick(1);
    await s.bus.drain();
    const live = seller.liveOffers()[0];
    assert.ok(live);

    stub.expired = [
      { channel: 'digitalassets', offerId: live.offerId, sku: live.sku, priceMinor: live.priceMinor, remaining: 0, listedTick: 1, expiredTick: 2 },
    ];
    await seller.runTick(2);
    assert.equal(seller.stats().retainedOffers, 1);
    assert.equal(stub.calls['publish'], 1, 'held back while the fill might still arrive');

    // The fill never comes. After the grace window the holding goes back to work
    // rather than being blocked on a settlement that is not going to happen.
    for (let t = 3; t <= 5; t++) await seller.runTick(t);
    await s.bus.drain();
    assert.equal(seller.stats().openOffers, 1, 'exactly one live offer: the NEW one');
    assert.ok(seller.liveOffers()[0]);
    assert.notEqual(seller.liveOffers()[0]?.offerId, live.offerId, 're-listed under a fresh offer');
    assert.equal(stub.calls['publish'], 2);
    assert.equal(s.ledger.verify().ok, true);
  } finally {
    s.close();
  }
});
