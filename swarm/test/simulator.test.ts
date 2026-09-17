/**
 * test/simulator.test.ts — the simulator IS the market in PAPER mode, so its
 * realism is the whole value of the exercise. These tests pin the properties that
 * make it teach something true: determinism from a seed, a real (decreasing)
 * demand curve, fees that never round in the house's favour, settlement that
 * genuinely delays cash, listings that expire unsold, and a naive buy-everything
 * strategy that loses money.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../src/core/rng.js';
import { TestClock } from '../src/core/clock.js';
import { nullLogger } from '../src/core/logger.js';
import { canonicalJson } from '../src/core/hash.js';
import {
  BASE_PARAMS,
  DEFAULT_CHANNEL_PARAMS,
  MarketSimulator,
  feeOnBps,
  fillCosts,
  resolveParams,
  vatOnGross,
  type SimFill,
} from '../src/channels/simulator.js';

const CH = 'digitalassets';

/** First SKU on a channel that is not part of its permanently dead tail. */
function liveSku(s: MarketSimulator, channel: string): string {
  for (let i = 0; i < 64; i++) {
    const sku = `${channel}-sku-${String(i).padStart(3, '0')}`;
    if (!s.isDeadSku(channel, sku)) return sku;
  }
  throw new Error(`every SKU on ${channel} is dead`);
}

function sim(seed = 1337, channels: Record<string, Record<string, unknown>> = { [CH]: {} }): MarketSimulator {
  return new MarketSimulator({ rng: makeRng(seed), clock: new TestClock(), logger: nullLogger }, channels);
}

/* ------------------------------------------------------------- determinism */

test('same seed => identical opportunities and fills over 100 ticks', () => {
  const trace = (seed: number): string => {
    const s = sim(seed, { dataproducts: {}, digitalassets: {}, ksa_ecom: {} });
    const events: unknown[] = [];
    let n = 0;
    for (let t = 0; t < 100; t++) {
      for (const ch of ['dataproducts', 'digitalassets', 'ksa_ecom']) {
        const listings = s.listings(ch, t);
        events.push(listings.map((l) => [l.id, l.askMinor, l.estResaleMinor, Math.round(l.confidence * 1e6)]));
        // Trade on every third listing so buys/sells perturb the stream too.
        for (const l of listings) {
          if (n % 3 === 0) {
            const b = s.executeBuy(ch, l.sku, 2, l.askMinor, t);
            events.push(['buy', b.filledQty, b.feeMinor]);
            const r = s.listOffer(ch, `o-${ch}-${n}`, l.sku, Math.round(l.askMinor * 0.9), b.filledQty, t);
            events.push(['list', r.feeMinor, r.dead, r.expiresTick]);
          }
          n++;
        }
        events.push(s.collectFills(ch, t).map((f: SimFill) => [f.offerId, f.qty, f.unitPriceMinor, f.feeMinor, f.settleTick]));
        events.push(s.collectExpiries(ch, t).map((e) => [e.offerId, e.remaining, e.expiredTick]));
      }
    }
    events.push(s.counters());
    return canonicalJson(events);
  };
  assert.equal(trace(1337), trace(1337));
  assert.notEqual(trace(1337), trace(1338));
});

test('different seeds produce different markets', () => {
  const a = sim(1).listings(CH, 0).map((l) => l.askMinor);
  const b = sim(2).listings(CH, 0).map((l) => l.askMinor);
  assert.notDeepEqual(a, b);
});

test('advanceTo is idempotent for an already-reached tick and refuses bad input', () => {
  const s = sim(5);
  const first = s.listings(CH, 10).map((l) => l.id);
  s.advanceTo(10);
  s.advanceTo(3); // in the past: a no-op, never a rewind
  assert.deepEqual(s.listings(CH, 10).map((l) => l.id), first);
  assert.equal(s.currentTick, 10);
  assert.throws(() => s.advanceTo(-1), /non-negative integer/);
});

/* -------------------------------------------------- estimates, not the truth */

test('estResaleValue is an estimate with error, not the latent value', () => {
  const s = sim(99);
  let exact = 0;
  let total = 0;
  for (let t = 0; t < 60; t++) {
    for (const l of s.listings(CH, t)) {
      total++;
      if (l.estResaleMinor === l.latentMinor) exact++;
    }
  }
  assert.ok(total > 200, `expected a decent sample, got ${total}`);
  assert.ok(exact / total < 0.05, `estimates are suspiciously exact: ${exact}/${total}`);
});

test('higher confidence really does mean a more accurate estimate', () => {
  const s = sim(4242);
  let loErr = 0;
  let loN = 0;
  let hiErr = 0;
  let hiN = 0;
  for (let t = 0; t < 200; t++) {
    for (const l of s.listings(CH, t)) {
      const err = Math.abs(l.estResaleMinor - l.latentMinor) / l.latentMinor;
      if (l.confidence < 0.5) {
        loErr += err;
        loN++;
      } else if (l.confidence > 0.85) {
        hiErr += err;
        hiN++;
      }
    }
  }
  assert.ok(loN > 50 && hiN > 50, `sample too small: lo=${loN} hi=${hiN}`);
  assert.ok(hiErr / hiN < loErr / loN, `high-confidence error ${hiErr / hiN} should beat ${loErr / loN}`);
});

test('genuine bargains are rare; most apparent bargains are noise', () => {
  const s = sim(31337);
  let genuine = 0;
  let apparent = 0;
  let total = 0;
  for (let t = 0; t < 300; t++) {
    for (const l of s.listings(CH, t)) {
      total++;
      if (l.genuineBargain) genuine++;
      if (l.estResaleMinor > l.askMinor) apparent++;
    }
  }
  assert.ok(total > 1500, `sample too small: ${total}`);
  assert.ok(genuine / total < 0.1, `genuine bargains should be rare, got ${genuine / total}`);
  // Plenty of listings LOOK cheap; very few of them actually are.
  assert.ok(apparent > genuine * 3, `apparent=${apparent} genuine=${genuine}`);
});

/* --------------------------------------------------------- the demand curve */

test('demandSignal is strictly decreasing in price', () => {
  const s = sim(7);
  const sku = 'digitalassets-sku-004';
  const v = s.latentValueMinor(CH, sku, 25);
  let prev = Infinity;
  for (const mult of [0.6, 0.8, 1.0, 1.2, 1.5, 2.0]) {
    const p = s.sellThrough(CH, sku, Math.round(v * mult), 25);
    assert.ok(p < prev, `sell-through ${p} at x${mult} should be below ${prev}`);
    assert.ok(p >= 0 && p <= 1, `sell-through out of range: ${p}`);
    prev = p;
  }
});

test('sellThrough consumes no randomness (probing a price cannot move the market)', () => {
  const a = sim(11);
  const b = sim(11);
  const sku = 'digitalassets-sku-000';
  const v = a.latentValueMinor(CH, sku, 5);
  for (let i = 0; i < 50; i++) a.sellThrough(CH, sku, v + i, 5);
  assert.deepEqual(a.listings(CH, 6).map((l) => l.id + ':' + l.askMinor), b.listings(CH, 6).map((l) => l.id + ':' + l.askMinor));
});

test('realized sell-through at a high price multiplier is strictly lower than at a low one', () => {
  const realized = (mult: number): { filled: number; expired: number } => {
    const s = sim(555);
    const sku = 'digitalassets-sku-005';
    let n = 0;
    for (let t = 0; t < 600; t++) {
      if (t % 4 === 0) {
        const v = s.latentValueMinor(CH, sku, t);
        s.listOffer(CH, `o${n++}`, sku, Math.max(1, Math.round(v * mult)), 1, t, 10);
      }
      s.advanceTo(t);
    }
    s.advanceTo(620);
    const c = s.counters(CH);
    return { filled: c.filled, expired: c.expired };
  };
  const cheap = realized(0.8);
  const dear = realized(1.5);
  assert.ok(cheap.filled > 0 && dear.expired > 0);
  assert.ok(
    cheap.filled > dear.filled * 2,
    `cheap should clearly outsell dear: cheap=${cheap.filled} dear=${dear.filled}`,
  );
});

test('each channel has its own elasticity', () => {
  const es = new Set(
    ['dataproducts', 'digitalassets', 'ksa_ecom'].map((c) => resolveParams(c).elasticity),
  );
  assert.equal(es.size, 3, 'channels must not share one elasticity');
});

/* -------------------------------------------------------------------- fees */

test('fees are integer minor units, always rounded UP', () => {
  assert.equal(feeOnBps(1001, 250), 26); // 25.025 -> 26, never 25
  assert.equal(feeOnBps(1, 1), 1); // 0.0001 -> 1, never 0
  assert.equal(feeOnBps(10_000, 250), 250); // exact stays exact
  assert.equal(feeOnBps(0, 900), 0);
  assert.equal(feeOnBps(5_000, 0), 0);
  for (let amt = 1; amt < 500; amt++) {
    for (const bps of [1, 37, 250, 900, 1234]) {
      const fee = feeOnBps(amt, bps);
      assert.ok(Number.isInteger(fee), `fee not an integer: ${fee}`);
      assert.ok(fee >= (amt * bps) / 10_000, `fee ${fee} rounded DOWN for ${amt}@${bps}bps`);
      assert.ok(fee < (amt * bps) / 10_000 + 1, `fee ${fee} over-charged for ${amt}@${bps}bps`);
    }
  }
});

test('listing fees are charged whether or not the item sells', () => {
  const s = sim(21);
  const p = s.paramsOf(CH);
  assert.ok(p.listingFeeMinor > 0, 'this channel is supposed to charge to list');
  const before = s.counters(CH).feesMinor;
  const r = s.listOffer(CH, 'never-sells', 'digitalassets-sku-001', 10_000_000, 1, 0, 3);
  assert.equal(r.feeMinor, p.listingFeeMinor, 'listOffer reports the listing fee itself, unmixed');
  // ...and the fixed platform overhead that has accrued since the last
  // transaction falls due at the same moment, reported separately.
  assert.equal(s.counters(CH).feesMinor, before + p.listingFeeMinor + r.platformChargeMinor);
  s.advanceTo(10);
  assert.equal(s.counters(CH).expired, 1, 'an absurdly priced listing must expire unsold');
  // Fee kept, nothing sold.
  assert.equal(s.counters(CH).filled, 0);
  assert.ok(s.counters(CH).feesMinor >= p.listingFeeMinor);
});

/* ------------------------------------------------------------- settlement */

test('cash from a sale is NOT available on the tick the sale happens', () => {
  const s = sim(1234);
  const p = s.paramsOf(CH);
  assert.ok(p.settlementDelayTicks >= 1);
  const sku = 'digitalassets-sku-002';
  // Price far below latent value so it sells fast; retry until one lands.
  let soldTick = -1;
  for (let t = 0; t < 200 && soldTick < 0; t++) {
    const v = s.latentValueMinor(CH, sku, t);
    s.listOffer(CH, `o${t}`, sku, Math.max(1, Math.round(v * 0.4)), 1, t, 4);
    const before = s.counters(CH).filled;
    s.advanceTo(t + 1);
    if (s.counters(CH).filled > before) {
      soldTick = t + 1;
      // Nothing settles on the tick the sale happened...
      assert.deepEqual(s.collectFills(CH, soldTick), [], 'cash must not be available the same tick');
      // ...nor before the delay has elapsed.
      for (let k = 1; k < p.settlementDelayTicks; k++) {
        assert.deepEqual(s.collectFills(CH, soldTick + k), [], `settled ${k} ticks early`);
      }
      const due = s.collectFills(CH, soldTick + p.settlementDelayTicks);
      assert.ok(due.length > 0, 'the fill must settle exactly after the delay');
      for (const f of due) {
        assert.equal(f.settleTick, f.soldTick + p.settlementDelayTicks);
        assert.ok(f.settleTick > f.soldTick);
      }
    }
  }
  assert.ok(soldTick > 0, 'expected at least one sale in 200 ticks');
});

test('collectFills drains: a second call in the same tick returns nothing', () => {
  const s = sim(88);
  // Deadness is a property of the SKU now, so a test that needs fills must list
  // something sellable; and settlement is ~10x longer, so it must wait longer.
  const sku = liveSku(s, CH);
  for (let t = 0; t < 60; t++) s.listOffer(CH, `o${t}`, sku, Math.round(s.latentValueMinor(CH, sku, t) * 0.4), 1, t, 5);
  let sawFills = false;
  for (let t = 0; t < 60 + s.paramsOf(CH).settlementDelayTicks + 20; t++) {
    const first = s.collectFills(CH, t);
    const second = s.collectFills(CH, t);
    assert.deepEqual(second, [], 'second collect in the same tick must be empty');
    if (first.length > 0) sawFills = true;
  }
  assert.ok(sawFills, 'expected some fills in this run');
});

/* ------------------------------------------------ partial fills and expiry */

test('buys can fill partially', () => {
  const s = sim(606);
  let partial = 0;
  let full = 0;
  for (let t = 0; t < 120; t++) {
    for (const l of s.listings(CH, t)) {
      const r = s.executeBuy(CH, l.sku, 5, l.askMinor, t);
      if (r.filledQty < 5) partial++;
      else full++;
      assert.ok(r.filledQty >= 1 && r.filledQty <= 5);
    }
  }
  assert.ok(partial > 0, 'no partial fills ever happened');
  assert.ok(full > 0, 'every fill was partial, which is also wrong');
});

test('some listings simply never sell within their TTL', () => {
  const s = sim(4711);
  const sku = 'digitalassets-sku-006';
  for (let t = 0; t < 300; t++) {
    // Priced well below latent: these would all sell if dead listings did not exist.
    s.listOffer(CH, `o${t}`, sku, Math.max(1, Math.round(s.latentValueMinor(CH, sku, t) * 0.35)), 1, t, 6);
  }
  s.advanceTo(320);
  const c = s.counters(CH);
  assert.equal(c.listed, 300);
  assert.ok(c.expired > 0, 'a real market never sells everything');
  assert.equal(c.filled + c.expired, c.listed);
});

test('counters expose what an auditor needs', () => {
  const s = sim(12);
  for (let t = 0; t < 40; t++) {
    for (const l of s.listings(CH, t)) s.executeBuy(CH, l.sku, 1, l.askMinor, t);
    s.listOffer(CH, `o${t}`, 'digitalassets-sku-000', 1_000, 1, t, 5);
  }
  s.advanceTo(60);
  const c = s.counters(CH);
  for (const k of ['listed', 'filled', 'expired', 'feesMinor', 'buys', 'boughtUnits'] as const) {
    assert.ok(Number.isInteger(c[k]), `${k} must be an integer, got ${c[k]}`);
    assert.ok(c[k] >= 0);
  }
  assert.equal(c.listed, 40);
  assert.ok(c.buys > 0 && c.feesMinor > 0);
  // The aggregate view sums the per-channel views.
  assert.deepEqual(s.counters(), c);
});

test('expiries are reported once and then drained', () => {
  const s = sim(63);
  s.listOffer(CH, 'dead-one', 'digitalassets-sku-000', 50_000_000, 2, 0, 3);
  s.advanceTo(3);
  const first = s.collectExpiries(CH, 3);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.offerId, 'dead-one');
  assert.equal(first[0]?.remaining, 2);
  assert.deepEqual(s.collectExpiries(CH, 3), []);
});

/* ------------------------------------------------ the lesson the sim teaches */

test('a naive buy-anything-that-looks-cheap strategy loses money', () => {
  const naiveNet = (seed: number): number => {
    const s = sim(seed);
    const p = s.paramsOf(CH);
    let cash = 0;
    let n = 0;
    const attempts = new Map<string, number>();
    const step = (t: number, buying: boolean): void => {
      for (const f of s.collectFills(CH, t)) cash += f.unitPriceMinor * f.qty - f.feeMinor;
      for (const e of s.collectExpiries(CH, t)) {
        const a = attempts.get(e.offerId) ?? 1;
        if (a >= 8) continue; // give up: a write-off
        const id = `r${n++}`;
        const r = s.listOffer(CH, id, e.sku, Math.max(1, Math.round(e.priceMinor * 0.93)), e.remaining, t, 10);
        cash -= r.feeMinor;
        attempts.set(id, a + 1);
      }
      if (!buying) return;
      for (const l of s.listings(CH, t)) {
        // The naive rule: if the estimate beats the ask, buy it. No confidence
        // threshold, no allowance for the round trip.
        if (l.estResaleMinor <= l.askMinor) continue;
        const b = s.executeBuy(CH, l.sku, 1, l.askMinor, t);
        cash -= l.askMinor * b.filledQty + b.feeMinor;
        const id = `b${n++}`;
        const lr = s.listOffer(CH, id, l.sku, Math.round(l.estResaleMinor * 1.0), b.filledQty, t, 10);
        cash -= lr.feeMinor;
        attempts.set(id, 1);
      }
    };
    for (let t = 0; t < 250; t++) step(t, true);
    for (let t = 250; t < 420; t++) step(t, false);
    void p;
    return cash;
  };
  for (const seed of [4242, 777, 20]) {
    const net = naiveNet(seed);
    assert.ok(net < 0, `the naive strategy must lose money (seed ${seed} netted ${net})`);
  }
});

/* --------------------------------------------------------------- parameters */

test('parameter presets exist for all three channels and reject nonsense', () => {
  for (const ch of ['dataproducts', 'digitalassets', 'ksa_ecom']) {
    assert.ok(DEFAULT_CHANNEL_PARAMS[ch], `missing preset for ${ch}`);
    const p = resolveParams(ch);
    assert.ok(p.settlementDelayTicks >= 1, `${ch} must not settle instantly`);
    assert.ok(p.baseSellThrough > 0 && p.baseSellThrough < 1);
    assert.ok(Number.isInteger(p.listingFeeMinor) && p.listingFeeMinor >= 0);
  }
  assert.throws(() => resolveParams('digitalassets', { settlementDelayTicks: 0 }), /settlementDelayTicks/);
  assert.throws(() => resolveParams('digitalassets', { skuCount: 0 }), /skuCount/);
  assert.equal(BASE_PARAMS.currency, 'SAR');
});

test('unknown channels are refused rather than silently invented', () => {
  const s = sim(3);
  assert.throws(() => s.listings('nope', 0), /not registered/);
  assert.equal(s.hasChannel('nope'), false);
  assert.equal(s.hasChannel(CH), true);
});

test('registering a channel twice keeps the first registration', () => {
  const s = sim(3);
  const a = s.paramsOf(CH);
  const b = s.registerChannel(CH, { elasticity: 99 });
  assert.equal(b.elasticity, a.elasticity);
});

test('duplicate listing ids are refused', () => {
  const s = sim(3);
  s.listOffer(CH, 'dup', 'digitalassets-sku-000', 1000, 1, 0, 5);
  assert.throws(() => s.listOffer(CH, 'dup', 'digitalassets-sku-000', 1000, 1, 0, 5), /already listed/);
});

test('the simulator reads wall time only through the injected clock', () => {
  const clock = new TestClock(999);
  const s = new MarketSimulator({ rng: makeRng(1), clock, logger: nullLogger }, { [CH]: {} });
  assert.equal(s.nowMs(), 999);
  clock.advance(500);
  assert.equal(s.nowMs(), 1499);
});

/* ------------------------------------------------ the honest cost of an order */

test('every real cost of an order is charged in the fill path, itemised', () => {
  const p = resolveParams('ksa_ecom');
  assert.ok(p.fulfilmentPerOrderMinor >= 1_500, 'the shipping label must be on the books');
  const gross = 5_000; // SAR 50.00, inside this channel's SAR 32-65 band
  const c = fillCosts(p, gross, 1, 0);

  assert.equal(c.commissionMinor, feeOnBps(gross, p.sellCommissionBps));
  assert.equal(c.fulfilmentMinor, p.fulfilmentPerOrderMinor, 'charged ONCE per order');
  assert.equal(c.packagingMinor, p.packagingPerUnitMinor, 'charged per unit');
  assert.equal(c.paymentMinor, feeOnBps(gross, p.paymentFeeBps) + p.paymentFeeFlatMinor);
  assert.equal(
    c.sellerCostMinor,
    c.commissionMinor + c.fulfilmentMinor + c.packagingMinor + c.paymentMinor + c.platformMinor,
  );
  assert.equal(c.totalMinor, c.sellerCostMinor + c.vatMinor + c.vatOnFeesMinor);

  // The council's benchmark: real KSA per-order cost at this price band is
  // 40-70% of order value. Anything below that band means a cost is missing.
  const share = c.sellerCostMinor / gross;
  assert.ok(share >= 0.4 && share <= 0.7, `per-order cost is ${(share * 100).toFixed(1)}% of gross, expected 40-70%`);

  // Packaging really is per UNIT, fulfilment really is per ORDER.
  const three = fillCosts(p, gross * 3, 3, 0);
  assert.equal(three.fulfilmentMinor, c.fulfilmentMinor);
  assert.equal(three.packagingMinor, c.packagingMinor * 3);
});

test('VAT is DEDUCTED, not just displayed: proceeds = gross - vat - fees*(1+vatRate)', () => {
  const p = resolveParams('ksa_ecom');
  assert.ok(p.vatRateBps > 0);
  for (const gross of [3_200, 5_000, 6_500, 12_345]) {
    const c = fillCosts(p, gross, 1, 0);
    const proceeds = gross - c.totalMinor;
    const net = Math.round((gross * 10_000) / (10_000 + p.vatRateBps));
    assert.equal(c.vatMinor, gross - net, 'VAT is the inclusive component of the displayed price');
    assert.equal(c.vatOnFeesMinor, feeOnBps(c.sellerCostMinor, p.vatRateBps), 'the platform charges VAT on its fees');
    // The identity the reviewer asked for, in integer arithmetic.
    assert.equal(proceeds, gross - c.vatMinor - (c.sellerCostMinor + c.vatOnFeesMinor));
    assert.ok(proceeds < gross - c.vatMinor);
  }
  // A channel with no VAT degenerates cleanly: no VAT, no VAT on fees.
  const noVat = resolveParams('digitalassets');
  assert.equal(noVat.vatRateBps, 0);
  const c0 = fillCosts(noVat, 5_000, 1, 0);
  assert.equal(c0.vatMinor, 0);
  assert.equal(c0.vatOnFeesMinor, 0);
  assert.equal(c0.totalMinor, c0.sellerCostMinor);
});

test('vatRateBps is validated: a negative rate no longer divides by zero', () => {
  // -10000 made the VAT-inclusive divisor (10000 + rate) zero.
  assert.throws(() => resolveParams('ksa_ecom', { vatRateBps: -10_000 }), /vatRateBps/);
  assert.throws(() => resolveParams('ksa_ecom', { vatRateBps: -1 }), /vatRateBps/);
  assert.throws(() => resolveParams('ksa_ecom', { vatRateBps: 10_001 }), /vatRateBps/);
  assert.throws(() => resolveParams('ksa_ecom', { vatRateBps: Number.NaN }), /vatRateBps/);
  // The boundaries are legal: 0% and 100% are both arithmetically sound.
  assert.equal(resolveParams('ksa_ecom', { vatRateBps: 0 }).vatRateBps, 0);
  assert.equal(resolveParams('ksa_ecom', { vatRateBps: 10_000 }).vatRateBps, 10_000);
  assert.equal(vatOnGross(10_000, 10_000), 5_000);
  assert.equal(vatOnGross(10_000, 0), 0);
});

test('THE EXPERIMENT: adding the shipping label alone flips ksa_ecom from profit to loss', () => {
  // A merchant that sources each unit at a fixed share of the market's own
  // latent value, lists at that latent value, marks down 12% on every expiry and
  // gives up after five attempts — i.e. it buys well, prices perfectly and works
  // its unsold stock. Same seed, same draws, ONE knob: the per-order cost of
  // actually delivering the thing.
  const run = (overrides: Record<string, unknown>, cogsShare: number): number => {
    const s = new MarketSimulator(
      { rng: makeRng(4242), clock: new TestClock(), logger: nullLogger },
      { ksa_ecom: overrides },
    );
    const sku = 'ksa_ecom-sku-000';
    let cash = 0;
    let n = 0;
    let bought = 0;
    const attempts = new Map<string, number>();
    for (let t = 0; t < 500; t++) {
      for (const f of s.collectFills('ksa_ecom', t)) cash += f.unitPriceMinor * f.qty - f.feeMinor;
      for (const e of s.collectExpiries('ksa_ecom', t)) {
        const a = attempts.get(e.offerId) ?? 1;
        if (a >= 5) continue; // written off
        const id = `r${n++}`;
        const r = s.listOffer('ksa_ecom', id, e.sku, Math.max(1, Math.round(e.priceMinor * 0.88)), e.remaining, t, 14);
        cash -= r.feeMinor + r.platformChargeMinor;
        attempts.set(id, a + 1);
      }
      if (t < 250 && bought < 120) {
        const v = s.latentValueMinor('ksa_ecom', sku, t);
        cash -= Math.round(v * cogsShare); // cost of goods: a human sources the unit
        bought++;
        const id = `o${n++}`;
        const r = s.listOffer('ksa_ecom', id, sku, v, 1, t, 14);
        cash -= r.feeMinor + r.platformChargeMinor;
        attempts.set(id, 1);
      }
    }
    return cash;
  };
  const noShip = { fulfilmentPerOrderMinor: 0, packagingPerUnitMinor: 0 };

  // A 55% gross margin, which is a good retail margin, not a marginal one.
  const withoutShipping = run(noShip, 0.45);
  const withShipping = run({}, 0.45);
  assert.ok(withoutShipping > 0, `without a per-order shipping cost this merchant profits: ${withoutShipping}`);
  assert.ok(
    withShipping < 0,
    `with the real per-order cost it must lose money, got ${withShipping} (vs ${withoutShipping} without)`,
  );

  // And the stronger statement: even a 75% gross margin cannot pay the label.
  const fatWithout = run(noShip, 0.25);
  const fatWith = run({}, 0.25);
  assert.ok(fatWithout > 0);
  assert.ok(fatWith < 0, `even at a 75% gross margin the shipping label wins: ${fatWith} vs ${fatWithout}`);
});

test('a listing below the per-order cost of serving it can never be profitable', () => {
  const p = resolveParams('ksa_ecom');
  // Break-even gross for a sale with ZERO cost of goods. Below this the order
  // loses money before anyone has paid for the item itself.
  let breakEven = 0;
  for (let g = 1; g <= 20_000; g++) {
    if (g - fillCosts(p, g, 1, 0).totalMinor > 0) { breakEven = g; break; }
  }
  assert.ok(breakEven > 3_000, `break-even is only ${breakEven} halalas — a cost is missing`);
  // The channel's own price band starts at roughly SAR 32 (baseValueMinor with
  // dispersion), so a real part of the assortment cannot be sold at a profit.
  assert.ok(breakEven > p.baseValueMinor * 0.6, 'break-even must land inside the channel price band');
  assert.equal(3_000 - fillCosts(p, 3_000, 1, 0).totalMinor < 0, true, 'a SAR 30 order loses money');
});

test('the dataproducts channel is no longer structurally incapable of losing money', () => {
  const p = resolveParams('dataproducts');
  // The old preset: unitCost 0, listingFee 0, buyCommission 0. The seller's
  // floor rule then reduced to "price >= 9% of price", true for every price.
  assert.ok(p.listingFeeMinor > 0, 'an unsold listing must cost real money');
  assert.ok(p.fulfilmentPerOrderMinor + p.paymentFeeFlatMinor > 0, 'a sale must carry a per-order cost');
  const s = sim(99, { dataproducts: {} });
  const before = s.counters('dataproducts').feesMinor;
  // List something absurd so it certainly never sells, then let it expire.
  s.listOffer('dataproducts', 'never', 'dataproducts-sku-000', 50_000_000, 1, 0, 4);
  s.advanceTo(10);
  const after = s.counters('dataproducts');
  assert.equal(after.filled, 0);
  assert.equal(after.expired, 1);
  assert.ok(after.feesMinor - before >= p.listingFeeMinor, 'the listing fee is a realised loss');
  // And at a plausible price, a FILL still costs the seller something.
  const c = fillCosts(p, 6_500, 1, 0);
  assert.ok(c.totalMinor > 0 && c.totalMinor < 6_500, `a data product sale must cost something: ${c.totalMinor}`);
});

test('fixed platform overhead accrues every tick, whether or not anything is sold', () => {
  const s = sim(31, { ksa_ecom: {} });
  const p = s.paramsOf('ksa_ecom');
  assert.ok(p.platformFeePerTickMinor > 0, 'a seller account is not free');
  s.advanceTo(9); // ticks 0..9 inclusive => 10 ticks
  assert.equal(s.counters('ksa_ecom').platformAccruedMinor, p.platformFeePerTickMinor * 10);
  assert.equal(s.platformAccrual('ksa_ecom'), p.platformFeePerTickMinor * 10);
  assert.equal(s.counters('ksa_ecom').platformChargedMinor, 0, 'not collected until the swarm transacts');

  // The next transaction collects everything accrued, exactly once.
  const r = s.listOffer('ksa_ecom', 'p1', 'ksa_ecom-sku-000', 5_000, 1, 9, 4);
  assert.equal(r.platformChargeMinor, p.platformFeePerTickMinor * 10);
  assert.equal(s.platformAccrual('ksa_ecom'), 0);
  assert.equal(s.counters('ksa_ecom').platformChargedMinor, p.platformFeePerTickMinor * 10);
  const r2 = s.listOffer('ksa_ecom', 'p2', 'ksa_ecom-sku-000', 5_000, 1, 9, 4);
  assert.equal(r2.platformChargeMinor, 0, 'overhead is never charged twice for the same ticks');
});

/* ------------------------------------------------- obsolescence and dead stock */

test('deadness is a property of the SKU, not of the listing: relisting a dud never works', () => {
  const s = sim(5150, { dataproducts: {} });
  const p = s.paramsOf('dataproducts');
  assert.ok(p.deadListingProb > 0);
  const skus = Array.from({ length: p.skuCount }, (_, i) => `dataproducts-sku-${String(i).padStart(3, '0')}`);
  const dead = skus.filter((k) => s.isDeadSku('dataproducts', k));
  assert.ok(dead.length > 0, 'a fraction of the assortment must be permanently dead');
  assert.ok(dead.length < skus.length, 'but not all of it');

  // Relist the same dud twelve times, always well below latent value. Under the
  // old per-listing draw, P(dead twelve times) was ~0.000005% and every dud
  // eventually sold — teaching "relist and it will sell".
  const dud = dead[0] as string;
  let fees = 0;
  for (let i = 0; i < 12; i++) {
    const t = i * 20;
    const v = s.latentValueMinor('dataproducts', dud, t);
    const r = s.listOffer('dataproducts', `relist-${i}`, dud, Math.max(1, Math.round(v * 0.2)), 1, t, 16);
    fees += r.feeMinor + r.platformChargeMinor;
    s.advanceTo(t + 18);
  }
  assert.equal(s.counters('dataproducts').filled, 0, 'a dead SKU must never sell, however often it is relisted');
  assert.equal(s.counters('dataproducts').expired, 12);
  assert.ok(fees > 0, 'and every relist burned a real listing fee');
});

test('holding is not free optionality: value drifts down and can collapse permanently', () => {
  const p = resolveParams('digitalassets');
  assert.ok(p.valueDriftBps < 0, 'without negative drift, "wait it out" strictly dominates selling');
  assert.ok(p.obsolescenceProb > 0 && p.obsolescenceFactor < 1);

  // With no shocks and no mean reversion to fight it, the mean must decay.
  const s = new MarketSimulator(
    { rng: makeRng(1), clock: new TestClock(), logger: nullLogger },
    { digitalassets: { ouSigma: 0, demandNoiseSigma: 0, seasonAmplitude: 0, obsolescenceProb: 0, skuCount: 4 } },
  );
  const sku = 'digitalassets-sku-000';
  const v0 = s.latentValueMinor('digitalassets', sku, 0);
  const v200 = s.latentValueMinor('digitalassets', sku, 200);
  assert.ok(v200 < v0, `latent value must decay without drift support: ${v0} -> ${v200}`);

  // Obsolescence is PERMANENT: forced to certainty, one tick destroys the mean.
  const c = new MarketSimulator(
    { rng: makeRng(2), clock: new TestClock(), logger: nullLogger },
    { digitalassets: { ouSigma: 0, demandNoiseSigma: 0, seasonAmplitude: 0, obsolescenceProb: 1, obsolescenceFactor: 0.5, skuCount: 2 } },
  );
  const before = c.latentValueMinor('digitalassets', 'digitalassets-sku-000', 0);
  const after = c.latentValueMinor('digitalassets', 'digitalassets-sku-000', 3);
  assert.ok(after < before / 4, `an obsoleted SKU must not recover: ${before} -> ${after}`);
  assert.ok(c.counters('digitalassets').obsoleted > 0);
});

test('settlement is slow enough to matter: cash conversion is not a couple of ticks', () => {
  for (const ch of ['dataproducts', 'digitalassets', 'ksa_ecom']) {
    const p = resolveParams(ch);
    // The old values (2, 5, 3) let a naive strategy recycle capital almost
    // instantly — the simulator's own comment called that "exactly the
    // unrealistic behaviour this simulator exists to deny", and was off by ~10x.
    assert.ok(p.settlementDelayTicks >= 20, `${ch} settles in ${p.settlementDelayTicks} ticks, far too fast`);
  }
});
