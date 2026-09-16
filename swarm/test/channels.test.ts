/**
 * test/channels.test.ts — the adapter contract, adversarially.
 * Pins: init-before-use, close-twice safety, idempotent buy/publish on replay,
 * poll-once-per-tick, ksa_ecom's unconditional ToS refusal, fee rounding
 * direction, single-currency discipline, delayed settlement and determinism.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeRng } from '../src/core/rng.js';
import { TestClock } from '../src/core/clock.js';
import { nullLogger } from '../src/core/logger.js';
import { loadConfig } from '../src/core/config.js';
import { canonicalJson } from '../src/core/hash.js';
import { AdapterError, PolicyDenied } from '../src/core/errors.js';
import { money, type Money } from '../src/core/money.js';
import type { Offer, Opportunity } from '../src/core/types.js';
import type { ChannelContext } from '../src/channels/adapter.js';
import { MarketSimulator, feeOnBps } from '../src/channels/simulator.js';
import { DataProductsAdapter } from '../src/channels/dataproducts.js';
import { DigitalAssetsAdapter } from '../src/channels/digitalassets.js';
import { KsaEcomAdapter, VAT_ASSUMPTION_NOTE } from '../src/channels/ksa_ecom.js';

const cfg = loadConfig({});

interface Stack {
  sim: MarketSimulator;
  dp: DataProductsAdapter;
  da: DigitalAssetsAdapter;
  ke: KsaEcomAdapter;
  ctx: ChannelContext;
}

function stack(seed = 1337): Stack {
  const clock = new TestClock(0);
  const sim = new MarketSimulator({ rng: makeRng(seed), clock, logger: nullLogger });
  const dp = new DataProductsAdapter(sim);
  const da = new DigitalAssetsAdapter(sim);
  const ke = new KsaEcomAdapter(sim);
  const ctx: ChannelContext = { cfg, rng: makeRng(seed), clock, logger: nullLogger };
  return { sim, dp, da, ke, ctx };
}

async function ready(seed = 1337): Promise<Stack> {
  const s = stack(seed);
  await s.dp.init(s.ctx);
  await s.da.init(s.ctx);
  await s.ke.init(s.ctx);
  return s;
}

function offerFor(channel: string, sku: string, price: Money, tick: number, id = 'of1'): Offer {
  return {
    id,
    holdingId: null,
    channel,
    sku,
    title: `${sku} offer`,
    price,
    qty: 1,
    createdTick: tick,
    variant: 'plain',
    meta: {},
  };
}

/* ------------------------------------------------------------ capabilities */

test('each channel declares exactly the capabilities the spec requires', async () => {
  const { dp, da, ke } = await ready();

  assert.equal(dp.name, 'dataproducts');
  assert.deepEqual(
    { ...dp.capabilities, tosNote: undefined },
    { canBuy: false, canSell: true, buyRequiresHumanApproval: false, jurisdiction: 'GLOBAL', tosNote: undefined },
  );
  assert.match(dp.capabilities.tosNote, /no acquisition path|minted/i);

  assert.equal(da.name, 'digitalassets');
  assert.deepEqual(
    { ...da.capabilities, tosNote: undefined },
    { canBuy: true, canSell: true, buyRequiresHumanApproval: false, jurisdiction: 'GLOBAL', tosNote: undefined },
  );

  assert.equal(ke.name, 'ksa_ecom');
  assert.equal(ke.capabilities.canBuy, true);
  assert.equal(ke.capabilities.buyRequiresHumanApproval, true);
  assert.equal(ke.capabilities.canSell, true);
  assert.equal(ke.capabilities.jurisdiction, 'SA');
  assert.match(ke.capabilities.tosNote, /terms of service/i);
  assert.match(ke.capabilities.tosNote, /human in the loop/i);
});

/* --------------------------------------------------------------- lifecycle */

test('init() is required before scan/quote/buy/publish/poll/demandSignal', async () => {
  const { dp, da, ke, ctx } = stack();
  const budget = money(50_000, 'SAR');
  const opp: Opportunity = {
    id: 'x',
    channel: 'digitalassets',
    sku: 'digitalassets-sku-000',
    title: 't',
    askPrice: money(1000, 'SAR'),
    estResaleValue: money(1200, 'SAR'),
    confidence: 0.9,
    ttlTicks: 3,
    meta: {},
  };

  await assert.rejects(() => da.scan(0, budget), AdapterError);
  await assert.rejects(() => da.quote(opp, 0), AdapterError);
  await assert.rejects(() => da.buy(opp, 1, 0, 'k'), AdapterError);
  await assert.rejects(() => da.poll(0), AdapterError);
  await assert.rejects(() => da.demandSignal('s', money(1, 'SAR'), 0), AdapterError);
  await assert.rejects(() => da.publish(offerFor('digitalassets', 'digitalassets-sku-000', money(1000, 'SAR'), 0), 0, 'k'), AdapterError);
  await assert.rejects(() => dp.scan(0, budget), AdapterError);
  await assert.rejects(() => ke.scan(0, budget), AdapterError);
  await assert.rejects(() => dp.mint(opp, 1, 0, 'k'), AdapterError);

  await da.init(ctx);
  assert.equal(da.isReady, true);
  assert.ok(Array.isArray(await da.scan(0, budget)));
});

test('init() twice is a no-op; close() twice is safe; re-init after close is refused', async () => {
  const { da, ctx } = stack();
  await da.init(ctx);
  await da.init(ctx);
  assert.equal(da.isReady, true);
  await da.close();
  await da.close(); // must not throw
  assert.equal(da.isReady, false);
  await assert.rejects(() => da.init(ctx), AdapterError);
  await assert.rejects(() => da.scan(0, money(1000, 'SAR')), AdapterError);
});

/* ------------------------------------------------------------ idempotency */

test('buy() is idempotent on the idem key: one holding, one fee, same result', async () => {
  const { sim, da } = await ready(909);
  let opp: Opportunity | undefined;
  for (let t = 0; t < 20 && !opp; t++) opp = (await da.scan(t, money(90_000, 'SAR')))[0];
  assert.ok(opp, 'expected at least one digitalassets opportunity');

  const before = sim.counters('digitalassets');
  const first = await da.buy(opp, 3, 5, 'idem-buy-1');
  const replay = await da.buy(opp, 3, 5, 'idem-buy-1');
  const after = sim.counters('digitalassets');

  assert.deepEqual(replay, first, 'a replay must return the identical prior result');
  assert.equal(replay.holding.id, first.holding.id);
  assert.equal(after.buys, before.buys + 1, 'a replay must not execute a second purchase');
  assert.equal(after.boughtUnits, before.boughtUnits + first.holding.qty);
  assert.equal(after.feesMinor, before.feesMinor + first.feeMinor, 'a replay must not charge a second fee');

  // A different key IS a different purchase.
  const other = await da.buy(opp, 3, 5, 'idem-buy-2');
  assert.notEqual(other.holding.id, first.holding.id);
  assert.equal(sim.counters('digitalassets').buys, before.buys + 2);
});

test('publish() is idempotent on the idem key: one listing, one fee', async () => {
  const { sim, da } = await ready(4242);
  const price = money(2_500, 'SAR');
  const offer = offerFor('digitalassets', 'digitalassets-sku-001', price, 1, 'offer-A');

  const before = sim.counters('digitalassets');
  const first = await da.publish(offer, 1, 'idem-pub-1');
  const replay = await da.publish(offer, 1, 'idem-pub-1');
  const after = sim.counters('digitalassets');

  assert.deepEqual(replay, first);
  assert.equal(after.listed, before.listed + 1, 'a replay must not create a second listing');
  assert.equal(after.feesMinor, before.feesMinor + first.feeMinor, 'a replay must not charge a second listing fee');
  assert.equal(sim.activeListings('digitalassets'), 1);
});

test('mint() on dataproducts is idempotent and costs nothing', async () => {
  const { dp } = await ready(31);
  let opp: Opportunity | undefined;
  for (let t = 0; t < 20 && !opp; t++) opp = (await dp.scan(t, money(10_000, 'SAR')))[0];
  assert.ok(opp);
  assert.equal(opp.askPrice.amount, 0, 'data products have zero acquisition cost');
  assert.equal(opp.meta['productionCostMinor'], 0);

  const a = await dp.mint(opp, 4, 2, 'idem-mint-1');
  const b = await dp.mint(opp, 4, 2, 'idem-mint-1');
  assert.deepEqual(b, a);
  assert.equal(a.feeMinor, 0);
  assert.equal(a.holding.unitCost.amount, 0);
  assert.equal(a.holding.qty, 4);
  assert.equal(a.holding.channel, 'dataproducts');
});

/* --------------------------------------------------------------- poll-once */

test('poll() returns each fill exactly once; a second poll in the same tick is empty', async () => {
  const { sim, dp } = await ready(2024);
  const sku = 'dataproducts-sku-000';
  let sawFills = false;
  for (let t = 0; t < 120; t++) {
    // Keep a steady stream of cheap listings so fills definitely occur.
    const v = sim.latentValueMinor('dataproducts', sku, t);
    await dp.publish(offerFor('dataproducts', sku, money(Math.max(1, Math.round(v * 0.4)), 'SAR'), t, `o${t}`), t, `pub-${t}`);
    const first = await dp.poll(t);
    const second = await dp.poll(t);
    assert.deepEqual(second, [], `poll twice in tick ${t} returned ${second.length} fills the second time`);
    if (first.length > 0) sawFills = true;
  }
  assert.ok(sawFills, 'expected at least one fill over 120 ticks');
});

test('pollExpired() also reports each expiry exactly once', async () => {
  const { dp } = await ready(64);
  await dp.publish(offerFor('dataproducts', 'dataproducts-sku-000', money(9_999_999, 'SAR'), 0, 'dead'), 0, 'pub-dead');
  const status = dp.listingStatus('dataproducts:dead');
  assert.ok(status, 'a freshly published listing must be live');
  assert.equal(status.remaining, 1);

  let expiries = 0;
  for (let t = 1; t <= 40; t++) expiries += (await dp.pollExpired(t)).length;
  assert.equal(expiries, 1, 'the listing must expire unsold, exactly once');
  assert.equal(dp.listingStatus('dataproducts:dead'), null);
  assert.equal(dp.counters().expired, 1);
});

/* ------------------------------------------------- ksa_ecom: the ToS refusal */

test('ksa_ecom.buy() ALWAYS throws PolicyDenied, initialised or not', async () => {
  const cold = stack(7);
  const dummy: Opportunity = {
    id: 'x',
    channel: 'ksa_ecom',
    sku: 'ksa_ecom-sku-000',
    title: 't',
    askPrice: money(1000, 'SAR'),
    estResaleValue: money(1200, 'SAR'),
    confidence: 0.99,
    ttlTicks: 3,
    meta: {},
  };
  // Defence in depth: refused before init, so no wiring mistake can slip past.
  await assert.rejects(
    () => cold.ke.buy(dummy, 1, 0, 'k'),
    (e: unknown) => {
      assert.ok(e instanceof PolicyDenied, `expected PolicyDenied, got ${String(e)}`);
      assert.match(e.message, /terms of service/i);
      assert.match(e.message, /human in the loop/i);
      assert.equal(e.code, 'TOS_AUTOMATED_PURCHASE_PROHIBITED');
      return true;
    },
  );

  const { sim, ke } = await ready(7);
  const before = sim.counters('ksa_ecom');
  let opp: Opportunity | undefined;
  for (let t = 0; t < 20 && !opp; t++) opp = (await ke.scan(t, money(100_000, 'SAR')))[0];
  assert.ok(opp);

  for (const attempt of [1, 2, 3]) {
    await assert.rejects(() => ke.buy(opp, attempt, 5, `replayed-key`), PolicyDenied);
  }
  assert.deepEqual(sim.counters('ksa_ecom'), { ...before, listed: before.listed, buys: before.buys });
  assert.equal(sim.counters('ksa_ecom').buys, before.buys, 'no purchase may ever be recorded on ksa_ecom');
});

test('ksa_ecom sells normally in SAR with a VAT-inclusive display convention', async () => {
  const { ke } = await ready(77);
  const price = money(11_500, 'SAR');
  const offer = offerFor('ksa_ecom', 'ksa_ecom-sku-000', price, 1, 'ksa-offer');
  const res = await ke.publish(offer, 1, 'ksa-pub');
  assert.equal(res.offerId, 'ksa_ecom:ksa-offer');
  assert.equal(res.feeMinor, ke.params.listingFeeMinor);

  assert.equal(offer.meta['priceDisplay'], 'VAT_INCLUSIVE');
  assert.equal(offer.meta['jurisdiction'], 'SA');
  const vat = ke.vatBreakdown(price.amount);
  assert.equal(vat.grossMinor, price.amount);
  assert.equal(vat.netMinor + vat.vatMinor, vat.grossMinor, 'net + VAT must reconstruct the gross exactly');
  assert.equal(vat.vatRateBps, ke.params.vatRateBps);
  assert.equal(vat.vatInclusive, true);
  // The rate is an ASSUMPTION carried in data, not a legal claim baked into code.
  assert.match(vat.assumption, /ASSUMPTION/i);
  assert.match(VAT_ASSUMPTION_NOTE, /legal reviewer/i);

  // A zero rate degenerates cleanly.
  const zeroRate = new KsaEcomAdapter(new MarketSimulator({ rng: makeRng(1), clock: new TestClock(), logger: nullLogger }), { vatRateBps: 0 });
  assert.equal(zeroRate.vatBreakdown(10_000).vatMinor, 0);
});

test('ksa_ecom opportunities carry the human-approval constraint in their meta', async () => {
  const { ke } = await ready(78);
  let opp: Opportunity | undefined;
  for (let t = 0; t < 20 && !opp; t++) opp = (await ke.scan(t, money(100_000, 'SAR')))[0];
  assert.ok(opp);
  assert.equal(opp.meta['buyRequiresHumanApproval'], true);
  assert.equal(opp.meta['automatedPurchaseProhibited'], true);
  assert.match(String(opp.meta['tosNote']), /terms of service/i);
});

/* ---------------------------------------------------- dataproducts specifics */

test('dataproducts cannot buy and says so clearly', async () => {
  const { dp, sim } = await ready(11);
  let opp: Opportunity | undefined;
  for (let t = 0; t < 20 && !opp; t++) opp = (await dp.scan(t, money(10_000, 'SAR')))[0];
  assert.ok(opp);
  await assert.rejects(
    () => dp.buy(opp, 1, 1, 'nope'),
    (e: unknown) => {
      assert.ok(e instanceof AdapterError);
      assert.equal(e.code, 'CHANNEL_CANNOT_BUY');
      assert.match(e.message, /mint/);
      return true;
    },
  );
  assert.equal(sim.counters('dataproducts').buys, 0);
});

test('dataproducts is high margin but low and slow: revenue depends on price', async () => {
  const { sim, dp } = await ready(2);
  const sku = 'dataproducts-sku-002';
  const v = sim.latentValueMinor('dataproducts', sku, 10);
  const cheap = await dp.demandSignal(sku, money(Math.round(v * 0.7), 'SAR'), 10);
  const dear = await dp.demandSignal(sku, money(Math.round(v * 1.4), 'SAR'), 10);
  assert.ok(cheap > dear, `demand must fall with price: ${cheap} vs ${dear}`);
  // "Low and slow": at fair value this channel still sells well under half its stock.
  const fair = await dp.demandSignal(sku, money(v, 'SAR'), 10);
  assert.ok(fair < 0.5, `dataproducts demand should be slow, got ${fair}`);
});

/* ------------------------------------------------------- fees and currency */

test('quoted fees round UP and never in the house favour', async () => {
  const { da } = await ready(5);
  const bps = da.params.buyCommissionBps;
  assert.ok(bps > 0);
  const opp: Opportunity = {
    id: 'q',
    channel: 'digitalassets',
    sku: 'digitalassets-sku-000',
    title: 't',
    askPrice: money(1001, 'SAR'),
    estResaleValue: money(1200, 'SAR'),
    confidence: 0.9,
    ttlTicks: 3,
    meta: {},
  };
  const q = await da.quote(opp, 0);
  assert.equal(q.feeMinor, feeOnBps(1001, bps));
  assert.ok(Number.isInteger(q.feeMinor));
  assert.ok(q.feeMinor >= (1001 * bps) / 10_000, 'fee must never round down');
  assert.equal(q.unitCost.amount, 1001);
  assert.equal(q.unitCost.currency, 'SAR');
});

test('no adapter ever emits Money in a currency other than the one it declares', async () => {
  const { sim, dp, da, ke } = await ready(13);
  for (const a of [dp, da, ke] as const) {
    const cur = a.currency;
    const budget = money(100_000, cur);
    for (let t = 0; t < 15; t++) {
      for (const o of await a.scan(t, budget)) {
        assert.equal(o.askPrice.currency, cur);
        assert.equal(o.estResaleValue.currency, cur);
        const q = await a.quote(o, t);
        assert.equal(q.unitCost.currency, cur);
      }
      const sku = `${a.name}-sku-000`;
      const v = sim.latentValueMinor(a.name, sku, t);
      await a.publish(offerFor(a.name, sku, money(Math.max(1, Math.round(v * 0.5)), cur), t, `o-${a.name}-${t}`), t, `p-${a.name}-${t}`);
      for (const f of await a.poll(t)) assert.equal(f.unitPrice.currency, cur);
    }
  }
  assert.equal(ke.currency, 'SAR', 'ksa_ecom is always SAR');
});

test('a budget or price in the wrong currency is rejected, not silently coerced', async () => {
  const { da } = await ready(14);
  await assert.rejects(() => da.scan(0, money(1000, 'USD')), (e: unknown) => {
    assert.ok(e instanceof AdapterError);
    assert.equal(e.code, 'ADAPTER_CURRENCY_MISMATCH');
    return true;
  });
  await assert.rejects(
    () => da.publish(offerFor('digitalassets', 'digitalassets-sku-000', money(1000, 'USD'), 0), 0, 'k'),
    AdapterError,
  );
  await assert.rejects(() => da.demandSignal('digitalassets-sku-000', money(1, 'USD'), 0), AdapterError);
});

/* ------------------------------------------------------------- settlement */

test('a fill is never reported on the tick the sale happened', async () => {
  const { sim, da } = await ready(1717);
  const delay = da.params.settlementDelayTicks;
  assert.ok(delay >= 1);
  const sku = 'digitalassets-sku-002';
  let seen = 0;
  for (let t = 0; t < 150; t++) {
    const v = sim.latentValueMinor('digitalassets', sku, t);
    await da.publish(offerFor('digitalassets', sku, money(Math.max(1, Math.round(v * 0.4)), 'SAR'), t, `s${t}`), t, `sp${t}`);
    for (const f of await da.poll(t)) {
      seen++;
      // Fill.tick is the settlement tick: the tick the cash is actually available.
      assert.equal(f.tick, t);
      // It can never be the tick its listing was published on.
      const listedAt = Number(f.offerId.replace('digitalassets:s', ''));
      assert.ok(t >= listedAt + delay, `fill settled ${t - listedAt} ticks after listing, delay is ${delay}`);
    }
  }
  assert.ok(seen > 0, 'expected settled fills');
});

/* ------------------------------------------------------------ determinism */

test('two identical stacks with the same seed produce identical adapter traces', async () => {
  const trace = async (seed: number): Promise<string> => {
    const { sim, dp, da, ke, ctx } = stack(seed);
    await dp.init(ctx);
    await da.init(ctx);
    await ke.init(ctx);
    const events: unknown[] = [];
    let n = 0;
    for (let t = 0; t < 100; t++) {
      for (const a of [dp, da, ke] as const) {
        const budget = money(80_000, a.currency);
        const opps = await a.scan(t, budget);
        events.push(opps.map((o) => [o.id, o.askPrice.amount, o.estResaleValue.amount, Math.round(o.confidence * 1e6)]));
        const first = opps[0];
        if (first && a instanceof DigitalAssetsAdapter) {
          const r = await a.buy(first, 2, t, `b${n}`);
          events.push(['buy', r.holding.id, r.holding.qty, r.feeMinor]);
        }
        if (first) {
          const p = await a.publish(
            offerFor(a.name, first.sku, money(Math.max(1, Math.round(first.estResaleValue.amount * 0.8)), a.currency), t, `o${n}`),
            t,
            `p${n}`,
          );
          events.push(['pub', p.offerId, p.feeMinor]);
        }
        events.push((await a.poll(t)).map((f) => [f.offerId, f.qty, f.unitPrice.amount, f.feeMinor, f.tick]));
        events.push((await a.pollExpired(t)).map((e) => [e.offerId, e.remaining, e.expiredTick]));
        n++;
      }
    }
    events.push(sim.counters());
    return canonicalJson(events);
  };
  const a = await trace(1337);
  const b = await trace(1337);
  assert.equal(a, b, 'the same seed must reproduce the market exactly');
  assert.notEqual(a, await trace(2024));
});

/* -------------------------------------------------------- hermetic sources */

test('channel sources use no Math.random, Date.now, timers, network or filesystem', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, '..', '..', 'src', 'channels');
  const banned: [RegExp, string][] = [
    [/Math\.random/, 'Math.random'],
    [/Date\.now/, 'Date.now'],
    [/\bsetTimeout\b|\bsetInterval\b/, 'real timers'],
    [/\bfetch\s*\(/, 'network'],
    [/node:https?|node:net|node:dgram/, 'network module'],
    [/node:fs\b/, 'filesystem'],
  ];
  for (const f of ['simulator.ts', 'dataproducts.ts', 'digitalassets.ts', 'ksa_ecom.ts']) {
    const text = readFileSync(join(src, f), 'utf8');
    for (const [re, label] of banned) {
      assert.ok(!re.test(text), `${f} must not use ${label}`);
    }
  }
});
