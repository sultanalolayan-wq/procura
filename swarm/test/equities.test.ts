/**
 * test/equities.test.ts — the paper trading channel, and the run report.
 *
 * THE TEST THIS FILE EXISTS FOR is "a limit that D0's range contains and D1's
 * range does not MUST NOT fill": it is constructed so that same-bar execution
 * would pass every other test in this file and fail only this one. No-lookahead is
 * the single most common way a backtest lies, and if it is wrong every number this
 * system produces is worthless, so it is tested from four directions — a trap feed
 * that throws if the decision path so much as reads tomorrow, a gap that makes the
 * fill price unmistakable, a mutation that must move the fill and must not move the
 * decision, and a lying feed that the channel refuses even when it is handed the
 * wrong bar.
 *
 * Also pinned: orders cannot reach a socket (asserted against the BUILT JavaScript,
 * not against a comment), money stays integer, costs are parameterised, sale
 * proceeds are unavailable until T+2 SESSIONS, and shorting is impossible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestClock } from '../src/core/clock.js';
import { makeRng } from '../src/core/rng.js';
import { nullLogger } from '../src/core/logger.js';
import { loadConfig } from '../src/core/config.js';
import { AdapterError, AresError } from '../src/core/errors.js';
import { money, type Money } from '../src/core/money.js';
import type { Offer, Opportunity } from '../src/core/types.js';
import type { ChannelContext } from '../src/channels/adapter.js';
import {
  COST_ASSUMPTION_NOTE,
  DEFAULT_COSTS,
  EquitiesChannel,
  FX_ASSUMPTION_NOTE,
  commissionMinor,
  modelFill,
  toCurrency,
  type EquityTrade,
} from '../src/channels/equities.js';
import { SessionCalendar } from '../src/market/calendar.js';
import { MemoryFeed } from '../src/market/csv.js';
import { cmpDay, type Bar, type PriceFeed, type Venue } from '../src/market/feed.js';
import {
  buildRunReport,
  computeBuyAndHold,
  computeSwarmMetrics,
  maxDrawdown,
  renderReport,
  summariseVenue,
  windowDistribution,
} from '../src/market/report.js';

const cfg = loadConfig({});

/* ------------------------------------------------------------------ fixtures */

/** Prices given in MAJOR units for readability; stored as integer minor units. */
function bar(day: string, o: number, h: number, l: number, c: number, symbol = 'AAPL', venue: Venue = 'US'): Bar {
  return {
    symbol,
    venue,
    dayUtc: day,
    openMinor: Math.round(o * 100),
    highMinor: Math.round(h * 100),
    lowMinor: Math.round(l * 100),
    closeMinor: Math.round(c * 100),
    volume: 1_000,
    currency: venue === 'US' ? 'USD' : 'SAR',
  };
}

const US_SESSIONS = ['2025-01-06', '2025-01-07', '2025-01-08', '2025-01-09', '2025-01-10'];

function ctx(): ChannelContext {
  return { cfg, rng: makeRng(1337), clock: new TestClock(0), logger: nullLogger };
}

interface Stack {
  ch: EquitiesChannel;
  feed: PriceFeed;
}

async function stack(bars: Bar[], over: Partial<ConstructorParameters<typeof EquitiesChannel>[0]> = {}): Promise<Stack> {
  const feed = new MemoryFeed(bars);
  const ch = new EquitiesChannel({
    venue: 'US',
    feed,
    calendar: new SessionCalendar(),
    startDay: US_SESSIONS[0] as string,
    symbols: ['AAPL'],
    logger: nullLogger,
    ...over,
  });
  await ch.init(ctx());
  return { ch, feed };
}

const USD = (major: number): Money => money(Math.round(major * 100), 'USD');

async function failure(fn: () => Promise<unknown>): Promise<AresError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AresError, `expected AresError, got ${String(err)}`);
    return err;
  }
  throw new Error('expected a throw, got none');
}

/**
 * A feed that THROWS if anything reads a bar dated after the seal. Sealed during
 * the decision phase, it turns "the strategy peeked" from a subtle P&L distortion
 * into a loud test failure.
 */
class LookaheadTrapFeed implements PriceFeed {
  readonly name = 'trap';
  private seal: string | null = null;
  readonly reads: string[] = [];
  constructor(private readonly inner: PriceFeed) {}
  sealAt(day: string): void {
    this.seal = day;
  }
  unseal(): void {
    this.seal = null;
  }
  private check(to: string): void {
    this.reads.push(to);
    if (this.seal !== null && cmpDay(to, this.seal) > 0) {
      throw new AresError(
        'TEST_LOOKAHEAD',
        `the decision path read ${to}, which is after the sealed decision day ${this.seal}`,
        { to, seal: this.seal },
      );
    }
  }
  async bars(symbol: string, venue: Venue, fromDay: string, toDay: string): Promise<Bar[]> {
    this.check(toDay);
    return this.inner.bars(symbol, venue, fromDay, toDay);
  }
  async latest(symbol: string, venue: Venue): Promise<Bar | null> {
    this.check('9999-12-31');
    return this.inner.latest(symbol, venue);
  }
  async close(): Promise<void> {
    await this.inner.close();
  }
}

/* ============================== NO LOOKAHEAD ============================== */

test('LOOKAHEAD: a limit inside the DECISION bar but outside the EXECUTION bar does not fill', async () => {
  // D0 range [99.00, 101.00], close 100.00.  D1 range [104.00, 110.00], open 105.
  // 99.50 is reachable on D0 and unreachable on D1.
  // 106.00 is unreachable on D0 and reachable on D1.
  // A same-bar backtest fills the first and refuses the second. The truth is the
  // exact opposite, and that is what this asserts.
  const { ch } = await stack([
    bar('2025-01-06', 100, 101, 99, 100),
    bar('2025-01-07', 105, 110, 104, 108),
  ]);
  const [opp] = await ch.scan(0, USD(10_000));
  assert.ok(opp);
  assert.equal(opp.askPrice.amount, 10_000); // decided at D0's close, 100.00

  const inDecisionBarOnly: Opportunity = { ...opp, meta: { ...opp.meta, limitMinor: 9_950 } };
  const err = await failure(() => ch.buy(inDecisionBarOnly, 1, 0, 'idem-a'));
  assert.equal(err.code, 'MARKET_LIMIT_NOT_FILLED');
  assert.match(err.message, /2025-01-07/, 'the refusal must name the execution session, not the decision one');
  assert.match(err.message, /below the session low/);
  assert.equal(ch.positionOf('AAPL').qty, 0, 'a refused limit must leave no position behind');

  const inExecutionBarOnly: Opportunity = { ...opp, meta: { ...opp.meta, limitMinor: 10_600 } };
  const filled = await ch.buy(inExecutionBarOnly, 1, 0, 'idem-b');
  assert.equal(filled.holding.meta['fillDay'], '2025-01-07');
  assert.equal(filled.holding.meta['decisionDay'], '2025-01-06');
  assert.ok(filled.holding.unitCost.amount >= 10_400 && filled.holding.unitCost.amount <= 11_000);
  await ch.close();
});

test('LOOKAHEAD: the decision path cannot read tomorrow, even if it tries', async () => {
  const trap = new LookaheadTrapFeed(
    new MemoryFeed([
      bar('2025-01-06', 100, 101, 99, 100),
      bar('2025-01-07', 200, 210, 195, 205),
      bar('2025-01-08', 205, 206, 204, 205),
    ]),
  );
  const ch = new EquitiesChannel({
    venue: 'US',
    feed: trap,
    calendar: new SessionCalendar(),
    startDay: '2025-01-06',
    symbols: ['AAPL'],
    logger: nullLogger,
  });
  await ch.init(ctx());

  // Decision phase: nothing may look past D0.
  trap.sealAt('2025-01-06');
  const [opp] = await ch.scan(0, USD(10_000));
  assert.ok(opp);
  await ch.quote(opp, 0);
  await ch.demandSignal('AAPL', USD(101), 0);
  assert.deepEqual(opp.meta['closes'], [10_000], 'history handed to the agent must stop at the decision close');

  // Execution phase: the future is allowed to exist now, because time has passed.
  trap.unseal();
  const { holding } = await ch.buy(opp, 1, 0, 'idem');
  // The gap is 100 -> 200. A same-bar fill would be ~100.
  assert.ok(holding.unitCost.amount >= 20_000, `filled at ${holding.unitCost.amount}, i.e. on the decision bar`);
  assert.equal(holding.meta['barOpenMinor'], 20_000);
  await ch.close();
});

test('LOOKAHEAD: changing tomorrow changes the fill and CANNOT change the decision', async () => {
  const build = async (d1Open: number): Promise<{ opp: Opportunity; fillMinor: number }> => {
    const { ch } = await stack([
      bar('2025-01-06', 100, 101, 99, 100),
      bar('2025-01-07', d1Open, d1Open + 5, d1Open - 5, d1Open),
    ]);
    const [opp] = await ch.scan(0, USD(100_000));
    assert.ok(opp);
    const { holding } = await ch.buy(opp, 1, 0, 'idem');
    await ch.close();
    return { opp, fillMinor: holding.unitCost.amount };
  };
  const a = await build(120);
  const b = await build(180);
  // The decision is identical...
  assert.equal(a.opp.askPrice.amount, b.opp.askPrice.amount);
  assert.deepEqual(a.opp.meta['closes'], b.opp.meta['closes']);
  assert.equal(a.opp.id, b.opp.id);
  // ...and the fill is not.
  assert.notEqual(a.fillMinor, b.fillMinor);
  assert.ok(a.fillMinor >= 12_000 && b.fillMinor >= 18_000);
});

test('LOOKAHEAD: a feed that hands back the decision bar is refused by the channel', async () => {
  const inner = new MemoryFeed([bar('2025-01-06', 100, 101, 99, 100), bar('2025-01-07', 105, 110, 104, 108)]);
  const lying: PriceFeed = {
    name: 'lying',
    async bars(symbol, venue, fromDay, toDay) {
      // Always answers with D0's bar, whatever it was asked for.
      const got = await inner.bars(symbol, venue, '2025-01-06', '2025-01-06');
      return got.map((b) => ({ ...b }));
    },
    async latest(symbol, venue) {
      return inner.latest(symbol, venue);
    },
    async close() {
      await inner.close();
    },
  };
  const ch = new EquitiesChannel({
    venue: 'US',
    feed: lying,
    calendar: new SessionCalendar(),
    startDay: '2025-01-06',
    symbols: ['AAPL'],
    logger: nullLogger,
  });
  await ch.init(ctx());
  const [opp] = await ch.scan(0, USD(10_000));
  assert.ok(opp);
  const err = await failure(() => ch.buy(opp, 1, 0, 'idem'));
  assert.equal(err.code, 'MARKET_LOOKAHEAD_REFUSED');
  await ch.close();
});

test('LOOKAHEAD: an agent cannot decide again after seeing its own fill', async () => {
  const { ch } = await stack([bar('2025-01-06', 100, 101, 99, 100), bar('2025-01-07', 105, 110, 104, 108)]);
  const [opp] = await ch.scan(0, USD(100_000));
  assert.ok(opp);
  await ch.buy(opp, 1, 0, 'idem');
  const err = await failure(() => ch.scan(0, USD(100_000)));
  assert.equal(err.code, 'MARKET_DECISION_AFTER_EXECUTION');
  // The next session's decisions are fine: by then the price is genuinely known.
  assert.equal((await ch.scan(1, USD(100_000))).length, 1);
  await ch.close();
});

test('LOOKAHEAD: a market order fills at the next OPEN, never at the close it was decided on', async () => {
  const { ch } = await stack(
    [bar('2025-01-06', 100, 150, 90, 140), bar('2025-01-07', 95, 96, 94, 95)],
    { costs: { halfSpreadBps: 0, slippageBps: 0 } },
  );
  const [opp] = await ch.scan(0, USD(100_000));
  assert.ok(opp);
  const { holding } = await ch.buy(opp, 1, 0, 'idem');
  assert.equal(holding.unitCost.amount, 9_500, 'must be D+1 open (95.00), not D close (140.00) or D open (100.00)');
  await ch.close();
});

/* =================== ORDERS CANNOT REACH THE NETWORK ==================== */

test('no write verb, and no socket, exists anywhere on the BUILT execution path', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = resolve(here, '../src/channels/equities.js');
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1] as string;
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec));
    }
  };
  walk(entry);
  assert.ok(seen.size >= 6, `the walker found only ${seen.size} modules; it is not walking the graph`);

  const NETWORK = ['node:https', 'node:http', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'fetch('];
  // An HTTP write verb as a string literal (method:'POST'), or a client-shaped
  // call. Set.delete/Map.delete are not HTTP verbs, so .delete( is not in here.
  const WRITE_VERBS = /['"`](?:POST|PUT|PATCH|DELETE)['"`]|\.post\(|\.put\(|\.patch\(|\brequest\(/i;
  for (const file of seen) {
    const src = readFileSync(file, 'utf8');
    for (const n of NETWORK) {
      assert.ok(!src.includes(n), `${file} reaches the network via ${n}`);
    }
    assert.ok(!WRITE_VERBS.test(src), `${file} contains a write verb on the order path`);
  }
  // The HTTP feed is deliberately NOT on this graph.
  assert.ok(![...seen].some((f) => f.endsWith('market/http.js')), 'the order path must not import the HTTP feed');
});

/* ============================ INTEGER MONEY ============================= */

test('no float price survives anywhere in a fill', async () => {
  const { ch } = await stack([
    bar('2025-01-06', 100, 101, 99, 100),
    bar('2025-01-07', 100.07, 100.5, 99.5, 100.2),
  ]);
  const [opp] = await ch.scan(0, USD(100_000));
  assert.ok(opp);
  const { holding, feeMinor } = await ch.buy(opp, 3, 0, 'idem');
  assert.equal(Number.isSafeInteger(holding.unitCost.amount), true);
  assert.equal(Number.isSafeInteger(feeMinor), true);
  for (const [k, v] of Object.entries(holding.meta)) {
    if (typeof v === 'number') assert.equal(Number.isSafeInteger(v), true, `meta.${k} is a float: ${v}`);
  }
  for (const t of ch.tradeLog()) {
    for (const [k, v] of Object.entries(t)) {
      if (typeof v === 'number') assert.equal(Number.isSafeInteger(v), true, `trade.${k} is a float: ${String(v)}`);
    }
  }
  await ch.close();
});

/* ============================== COST MODEL ============================== */

test('every cost parameter is named, and each one moves the fill in the trader\'s disfavour', () => {
  const b = bar('2025-01-07', 100, 110, 90, 105);
  const free = { ...DEFAULT_COSTS.US, halfSpreadBps: 0, slippageBps: 0 };
  assert.equal(modelFill('BUY', b, null, free).priceMinor, 10_000);
  assert.equal(modelFill('SELL', b, null, free).priceMinor, 10_000);
  // Half-spread alone: buy above the open, sell below it.
  const spread = { ...free, halfSpreadBps: 50 };
  assert.equal(modelFill('BUY', b, null, spread).priceMinor, 10_050);
  assert.equal(modelFill('SELL', b, null, spread).priceMinor, 9_950);
  // Slippage stacks on top, in the same direction.
  const both = { ...free, halfSpreadBps: 50, slippageBps: 50 };
  assert.equal(modelFill('BUY', b, null, both).priceMinor, 10_100);
  assert.equal(modelFill('SELL', b, null, both).priceMinor, 9_900);
  // Commission: bps of notional, floored at the minimum, rounded UP.
  assert.equal(commissionMinor(100_000, { ...free, commissionBps: 10, minCommissionMinor: 0 }), 100);
  assert.equal(commissionMinor(1, { ...free, commissionBps: 10, minCommissionMinor: 0 }), 1); // never rounds to zero
  assert.equal(commissionMinor(100, { ...free, commissionBps: 10, minCommissionMinor: 500 }), 500);
  assert.match(COST_ASSUMPTION_NOTE, /UNVERIFIED ASSUMPTION/);
});

test('a fill is always inside the real bar, and a limit is never breached', () => {
  const b = bar('2025-01-07', 100, 101, 99, 100);
  const wild = { ...DEFAULT_COSTS.US, halfSpreadBps: 5_000, slippageBps: 5_000 };
  const buy = modelFill('BUY', b, null, wild);
  assert.ok(buy.priceMinor <= b.highMinor, 'a fill above the session high did not happen');
  const sell = modelFill('SELL', b, null, wild);
  assert.ok(sell.priceMinor >= b.lowMinor, 'a fill below the session low did not happen');
  // A limit order cannot be filled through its limit by slippage.
  const lim = modelFill('BUY', b, 9_950, wild);
  assert.equal(lim.filled, true);
  assert.ok(lim.priceMinor <= 9_950, `filled at ${lim.priceMinor}, through a 99.50 limit`);
  const limSell = modelFill('SELL', b, 10_050, wild);
  assert.equal(limSell.filled, true);
  assert.ok(limSell.priceMinor >= 10_050);
});

test('price improvement is real: a buy limit above the open fills at the open', () => {
  const b = bar('2025-01-07', 100, 110, 95, 105);
  const free = { ...DEFAULT_COSTS.US, halfSpreadBps: 0, slippageBps: 0 };
  assert.equal(modelFill('BUY', b, 10_500, free).priceMinor, 10_000);
  assert.equal(modelFill('SELL', b, 9_800, free).priceMinor, 10_000);
});

/* ========================= SETTLEMENT AND SHORTING ======================= */

test('sale proceeds are unavailable until T+2 SESSIONS have passed', async () => {
  const bars = US_SESSIONS.map((d, i) => bar(d, 100 + i, 120 + i, 90 + i, 100 + i));
  const { ch } = await stack(bars, { costs: { halfSpreadBps: 0, slippageBps: 0, settlementSessions: 2 } });
  const [opp] = await ch.scan(0, USD(100_000));
  assert.ok(opp);
  await ch.buy(opp, 2, 0, 'buy');
  assert.equal(ch.positionOf('AAPL').qty, 2);

  const offer: Offer = {
    id: 'o1',
    holdingId: null,
    channel: ch.name,
    sku: 'AAPL',
    title: 'AAPL',
    price: USD(100), // reachable limit
    qty: 2,
    createdTick: 1,
    variant: 'a',
    meta: {},
  };
  await ch.publish(offer, 1, 'sell');
  assert.equal(await ch.poll(1).then((f) => f.length), 0, 'a sale cannot fill on the session it was decided on');

  // Fills on session 2; settles on session 4.
  assert.equal((await ch.poll(2)).length, 0, 'filled, but the cash has not settled');
  assert.equal((await ch.poll(3)).length, 0);
  const settled = await ch.poll(4);
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.tick, 4, 'Fill.tick must be the SETTLEMENT tick');
  assert.equal(ch.positionOf('AAPL').qty, 0);
  const sale = ch.tradeLog().find((t) => t.side === 'SELL') as EquityTrade;
  assert.equal(sale.fillDay, '2025-01-08');
  assert.equal(sale.settleDay, '2025-01-10');
  assert.equal(sale.decisionDay, '2025-01-07');
  await ch.close();
});

test('shorting, margin and leverage are impossible by construction', async () => {
  const bars = US_SESSIONS.map((d, i) => bar(d, 100 + i, 120 + i, 90 + i, 100 + i));
  const { ch } = await stack(bars);
  const mkOffer = (qty: number, id: string): Offer => ({
    id,
    holdingId: null,
    channel: ch.name,
    sku: 'AAPL',
    title: 'AAPL',
    price: USD(100),
    qty,
    createdTick: 1,
    variant: 'a',
    meta: {},
  });
  // Nothing held: any sale is a short, and it is refused.
  const e1 = await failure(() => ch.publish(mkOffer(1, 'o0'), 0, 'i0'));
  assert.equal(e1.code, 'MARKET_NO_SHORTING');

  const [opp] = await ch.scan(0, USD(100_000));
  assert.ok(opp);
  await ch.buy(opp, 2, 0, 'buy');
  // Two resting sells cannot together exceed the position.
  await ch.publish(mkOffer(2, 'o1'), 1, 'i1');
  const e2 = await failure(() => ch.publish(mkOffer(1, 'o2'), 1, 'i2'));
  assert.equal(e2.code, 'MARKET_NO_SHORTING');
  assert.match(e2.message, /already committed to resting orders/);
  assert.ok(ch.positionOf('AAPL').qty >= 0);
  await ch.close();
});

test('an untouched sell limit expires and gives its shares back', async () => {
  const bars = US_SESSIONS.map((d) => bar(d, 100, 101, 99, 100));
  const { ch } = await stack(bars);
  const [opp] = await ch.scan(0, USD(100_000));
  assert.ok(opp);
  await ch.buy(opp, 1, 0, 'buy');
  const offer: Offer = {
    id: 'o1',
    holdingId: null,
    channel: ch.name,
    sku: 'AAPL',
    title: 'AAPL',
    price: USD(500), // never reached
    qty: 1,
    createdTick: 1,
    variant: 'a',
    meta: { ttlSessions: 1 },
  };
  await ch.publish(offer, 1, 'sell');
  assert.equal((await ch.poll(2)).length, 0);
  assert.deepEqual(ch.drainExpired(), [`${ch.name}:o1`]);
  assert.equal(ch.openOrders().length, 0);
  // The shares are free again, so a new order can use them.
  await ch.publish({ ...offer, id: 'o2', price: USD(100) }, 2, 'sell2');
  assert.equal(ch.openOrders().length, 1);
  await ch.close();
});

/* ============================== PLUMBING =============================== */

test('capabilities are honest, and the ToS note is not a claim about a venue', async () => {
  const { ch } = await stack([bar('2025-01-06', 100, 101, 99, 100)]);
  assert.equal(ch.capabilities.canBuy, true);
  assert.equal(ch.capabilities.canSell, true);
  assert.equal(ch.capabilities.buyRequiresHumanApproval, false);
  assert.equal(ch.capabilities.jurisdiction, 'US');
  assert.match(ch.capabilities.tosNote, /PAPER ONLY/);
  assert.match(ch.capabilities.tosNote, /no broker, no exchange/);
  assert.equal(ch.name, 'equities_us');
  assert.equal(ch.currency, 'USD');
  await ch.close();
});

test('the two venues count their own sessions, and the Tadawul one trades SAR', async () => {
  const tadBars = ['2025-01-05', '2025-01-06', '2025-01-07'].map((d) => bar(d, 25, 26, 24, 25, '2222.SR', 'TADAWUL'));
  const ch = new EquitiesChannel({
    venue: 'TADAWUL',
    feed: new MemoryFeed(tadBars),
    calendar: new SessionCalendar(),
    startDay: '2025-01-05',
    symbols: ['2222.SR'],
    logger: nullLogger,
  });
  await ch.init(ctx());
  assert.equal(ch.name, 'equities_tadawul');
  assert.equal(ch.currency, 'SAR');
  assert.equal(ch.capabilities.jurisdiction, 'SA');
  assert.equal(ch.sessionDay(0), '2025-01-05'); // Sunday: not a US session at all
  assert.equal(ch.sessionDay(1), '2025-01-06');
  const [opp] = await ch.scan(0, money(500_000, 'SAR'));
  assert.equal(opp?.askPrice.currency, 'SAR');
  // A US-currency budget is refused outright.
  const err = await failure(() => ch.scan(0, USD(5_000)));
  assert.equal(err.code, 'ADAPTER_CURRENCY_MISMATCH');
  await ch.close();
});

test('FX is a configured assumption, labelled like the VAT note, not a constant', () => {
  assert.match(FX_ASSUMPTION_NOTE, /CONFIGURABLE ASSUMPTION/);
  assert.match(FX_ASSUMPTION_NOTE, /not a constant/);
  assert.match(FX_ASSUMPTION_NOTE, /ARES_MARKET_FX_SAR_PER_USD/);
  assert.equal(toCurrency(money(10_000, 'USD'), 'SAR', 3.75).amount, 37_500);
  assert.equal(toCurrency(money(37_500, 'SAR'), 'USD', 3.75).amount, 10_000);
  assert.equal(toCurrency(money(100, 'SAR'), 'SAR', 3.75).amount, 100);
  // The config block carries the same note, so an operator reading either finds it.
  assert.match(cfg.market.fx.note, /CONFIGURABLE ASSUMPTION/);
  assert.equal(cfg.market.fx.sarPerUsdMicros, 3_750_000);
  assert.equal(cfg.market.fx.sarPerUsd, 3.75);
});

test('config ships an empty holiday list, an empty host allowlist and the market off', () => {
  assert.equal(cfg.market.enabled, false);
  assert.deepEqual(cfg.market.holidays.US, []);
  assert.deepEqual(cfg.market.holidays.TADAWUL, []);
  assert.deepEqual(cfg.market.http.hosts, []);
  assert.deepEqual(cfg.market.symbols.US, []);
  assert.equal(cfg.market.sessions, 10);
  assert.equal(cfg.market.costs.US.settlementSessions, 2);
  assert.equal(cfg.market.costs.TADAWUL.settlementSessions, 2);
  assert.equal(Object.isFrozen(cfg.market), true);
  // Enabling it without instruments or a start day is refused at boot.
  assert.throws(() => loadConfig({ ARES_MARKET_ENABLED: 'true' }), /ARES_MARKET_START_DAY is required/);
  const c = loadConfig({
    ARES_MARKET_ENABLED: 'true',
    ARES_MARKET_START_DAY: '2025-01-06',
    ARES_MARKET_US_SYMBOLS: 'AAPL,MSFT',
    ARES_MARKET_US_HOLIDAYS: '2025-01-09',
    ARES_MARKET_HOSTS: 'stooq.com',
    ARES_MARKET_FX_SAR_PER_USD: '3.751234',
  });
  assert.deepEqual(c.market.symbols.US, ['AAPL', 'MSFT']);
  assert.deepEqual(c.market.holidays.US, ['2025-01-09']);
  assert.equal(c.market.fx.sarPerUsdMicros, 3_751_234);
  assert.throws(() => loadConfig({ ARES_MARKET_FX_SAR_PER_USD: '3.7512345' }), /at most 6 decimal places/);
  assert.throws(() => loadConfig({ ARES_MARKET_US_HOLIDAYS: '2025-02-30' }), /not a real YYYY-MM-DD/);
  assert.throws(() => loadConfig({ ARES_MARKET_HOSTS: 'https://stooq.com' }), /bare hostname/);
});

test('buy is idempotent on replay and refuses a fractional or oversized lot', async () => {
  const { ch } = await stack([bar('2025-01-06', 100, 101, 99, 100), bar('2025-01-07', 100, 101, 99, 100)]);
  const [opp] = await ch.scan(0, USD(100_000));
  assert.ok(opp);
  const a = await ch.buy(opp, 1, 0, 'same-key');
  const b = await ch.buy(opp, 1, 0, 'same-key');
  assert.equal(a.holding.id, b.holding.id, 'a replayed buy must not mint a second holding');
  assert.equal(ch.positionOf('AAPL').qty, 1);
  assert.equal((await failure(() => ch.buy(opp, 0, 0, 'k2'))).code, 'MARKET_BAD_QTY');
  assert.equal((await failure(() => ch.buy(opp, 1.5, 0, 'k3'))).code, 'MARKET_BAD_QTY');
  await ch.close();
});

test('a missing next session is an explicit, explained refusal — not a silent zero', async () => {
  const { ch } = await stack([bar('2025-01-06', 100, 101, 99, 100)]);
  const [opp] = await ch.scan(0, USD(100_000));
  assert.ok(opp);
  const err = await failure(() => ch.buy(opp, 1, 0, 'k'));
  assert.equal(err.code, 'MARKET_NEXT_BAR_UNAVAILABLE');
  assert.match(err.message, /has not happened yet/);
  await ch.close();
});

test('init is required, close is idempotent', async () => {
  const ch = new EquitiesChannel({
    venue: 'US',
    feed: new MemoryFeed([bar('2025-01-06', 100, 101, 99, 100)]),
    calendar: new SessionCalendar(),
    startDay: '2025-01-06',
    symbols: ['AAPL'],
  });
  const err = await failure(() => ch.scan(0, USD(1_000)));
  assert.equal(err.code, 'ADAPTER_NOT_INITIALISED');
  await ch.init(ctx());
  await ch.close();
  await ch.close();
  await assert.rejects(() => ch.init(ctx()), (e: unknown) => (e as AdapterError).code === 'ADAPTER_CLOSED');
});

/* ================================ REPORT ================================ */

/** A 40-session series that trends up, so buy-and-hold is a real opponent. */
function trending(symbol = 'AAPL', venue: Venue = 'US'): { bars: Bar[]; sessions: string[] } {
  const cal = new SessionCalendar();
  const sessions = cal.sessionWindow(venue, '2025-01-01', 40);
  const bars = sessions.map((d, i) => {
    const px = 100 + i;
    return bar(d, px, px + 2, px - 2, px + 1, symbol, venue);
  });
  return { bars, sessions };
}

test('buy-and-hold is computed under the SAME rules the swarm plays by', async () => {
  const { bars, sessions } = trending();
  const feed = new MemoryFeed(bars);
  const bh = await computeBuyAndHold({
    feed,
    instruments: [{ symbol: 'AAPL', venue: 'US' }],
    sessionsByVenue: { US: sessions.slice(0, 10) },
    startingCapital: money(500_000, 'SAR'), // SAR 5,000
    sarPerUsd: 3.75,
  });
  const leg = bh.legs[0];
  assert.ok(leg);
  // Entry is the SECOND session's open — the same no-lookahead rule as a live order.
  assert.equal(leg.entryDay, sessions[1]);
  assert.equal(leg.exitDay, sessions[9]);
  assert.ok(leg.qty > 0);
  assert.ok(leg.costsMinor > 0, 'the benchmark pays the same costs, or it is not a benchmark');
  assert.ok(bh.netBaseMinor > 0, 'a rising market should make buy-and-hold money');
  assert.ok(bh.uninvestedBaseMinor >= 0, 'whole lots leave residual cash, as they would in reality');
  assert.equal(Number.isSafeInteger(bh.netBaseMinor), true);
  // A window too short to buy at the second open is refused rather than fudged.
  await assert.rejects(
    () =>
      computeBuyAndHold({
        feed,
        instruments: [{ symbol: 'AAPL', venue: 'US' }],
        sessionsByVenue: { US: sessions.slice(0, 1) },
        startingCapital: money(500_000, 'SAR'),
        sarPerUsd: 3.75,
      }),
    /at least 2 sessions/,
  );
});

test('the swarm metrics are the ones the spec names, and drawdown is peak-to-trough', () => {
  const trades: EquityTrade[] = [
    {
      symbol: 'AAPL', venue: 'US', side: 'BUY', qty: 1, priceMinor: 10_000, commissionMinor: 100,
      implicitCostMinor: 5, decisionDay: '2025-01-06', fillDay: '2025-01-07', decisionTick: 0, fillTick: 1,
      settleTick: 1, settleDay: '2025-01-07', currency: 'USD', realisedMinor: null,
    },
    {
      symbol: 'AAPL', venue: 'US', side: 'SELL', qty: 1, priceMinor: 11_000, commissionMinor: 100,
      implicitCostMinor: 5, decisionDay: '2025-01-08', fillDay: '2025-01-09', decisionTick: 2, fillTick: 3,
      settleTick: 5, settleDay: '2025-01-13', currency: 'USD', realisedMinor: 800,
    },
    {
      symbol: 'MSFT', venue: 'US', side: 'SELL', qty: 1, priceMinor: 9_000, commissionMinor: 100,
      implicitCostMinor: 5, decisionDay: '2025-01-09', fillDay: '2025-01-10', decisionTick: 3, fillTick: 4,
      settleTick: 6, settleDay: '2025-01-14', currency: 'USD', realisedMinor: -2_000,
    },
  ];
  const m = computeSwarmMetrics({ trades, startingCapital: money(500_000, 'SAR'), sarPerUsd: 3.75 });
  assert.equal(m.tradeCount, 3);
  assert.equal(m.closedTradeCount, 2);
  assert.equal(m.wins, 1);
  assert.equal(m.losses, 1);
  assert.equal(m.winRate, 0.5);
  assert.equal(m.largestSingleLossBaseMinor, -7_500); // -20.00 USD at 3.75
  assert.equal(m.realisedNetBaseMinor, 3_000 - 7_500);
  assert.equal(m.commissionBaseMinor, 1_125); // 3.00 USD of commission
  assert.ok(m.totalCostsBaseMinor > m.commissionBaseMinor, 'spread and slippage must be counted as costs too');
  assert.ok(m.maxDrawdownBaseMinor < 0);
  const dd = maxDrawdown([100, 120, 80, 130, 60]);
  assert.equal(dd.amountMinor, -70);
  assert.equal(maxDrawdown([100, 110, 120]).amountMinor, 0);
});

test('the report states the verdict in words, and NO EDGE is not buried', async () => {
  const { bars, sessions } = trending();
  const feed = new MemoryFeed(bars);
  const cal = new SessionCalendar();
  const window = sessions.slice(0, 10);
  const bh = await computeBuyAndHold({
    feed,
    instruments: [{ symbol: 'AAPL', venue: 'US' }],
    sessionsByVenue: { US: window },
    startingCapital: money(500_000, 'SAR'),
    sarPerUsd: 3.75,
  });
  const swarm = computeSwarmMetrics({
    // A swarm that made money, but less than doing nothing would have.
    trades: [
      {
        symbol: 'AAPL', venue: 'US', side: 'SELL', qty: 1, priceMinor: 10_100, commissionMinor: 100,
        implicitCostMinor: 10, decisionDay: window[2] as string, fillDay: window[3] as string, decisionTick: 2,
        fillTick: 3, settleTick: 5, settleDay: window[5] as string, currency: 'USD', realisedMinor: 100,
      },
    ],
    startingCapital: money(500_000, 'SAR'),
    sarPerUsd: 3.75,
  });
  const dist = await windowDistribution(feed, { symbol: 'AAPL', venue: 'US' }, 10);
  const report = buildRunReport({
    runId: 'test-run',
    startedAt: 0,
    finishedAt: 1,
    startingCapital: money(500_000, 'SAR'),
    sarPerUsd: 3.75,
    swarm,
    benchmark: bh,
    venues: [summariseVenue(cal, 'US', window), summariseVenue(cal, 'TADAWUL', cal.sessionWindow('TADAWUL', '2025-01-01', 10))],
    distributions: [dist],
    instruments: [{ symbol: 'AAPL', venue: 'US' }],
    costs: { US: DEFAULT_COSTS.US },
  });
  assert.equal(report.mode, 'PAPER');
  assert.equal(report.edge.verdict, 'NO EDGE');
  assert.match(report.edge.verdictText, /NO EDGE/);
  assert.match(report.edge.verdictText, /did not earn it/);

  const text = renderReport(report);
  // The verdict must be near the TOP, above the numbers it judges.
  const verdictAt = text.indexOf('VERDICT:');
  assert.ok(verdictAt >= 0 && verdictAt < text.indexOf('HEAD TO HEAD'));
  for (const required of [
    'buy-and-hold P&L',
    'max drawdown',
    'total costs paid',
    'win rate',
    'largest single loss',
    'trades (fills)',
    'SESSIONS COUNTED PER VENUE',
    'STATISTICAL HONESTY',
    'NO REAL ORDERS WERE PLACED',
  ]) {
    assert.ok(text.includes(required), `the report does not mention ${required}`);
  }
  assert.match(text, /TEN SESSIONS CANNOT SEPARATE SKILL FROM LUCK/);
  assert.match(text, /EMPTY LIST/, 'an empty holiday list must be visible in the report, not assumed away');
  assert.ok(JSON.parse(JSON.stringify(report)).edge.verdict === 'NO EDGE');
});

test('the report shows the DISTRIBUTION of 10-session outcomes and the +100% base rate', async () => {
  const { bars } = trending();
  const feed = new MemoryFeed(bars);
  const d = await windowDistribution(feed, { symbol: 'AAPL', venue: 'US' }, 10);
  assert.equal(d.windowSessions, 10);
  assert.ok(d.windows >= 20, `only ${d.windows} windows`);
  assert.equal(d.returnsBps.length, d.windows);
  assert.ok(d.minBps <= d.medianBps && d.medianBps <= d.maxBps);
  assert.equal(d.targetBps, 10_000);
  // This series rises ~1% a session: nowhere near doubling in ten. The honest
  // base rate for the operator's stated target is therefore zero, and it is shown.
  assert.equal(d.fractionAtTarget, 0);
  assert.ok(d.fractionPositive > 0.9);
  await assert.rejects(() => windowDistribution(feed, { symbol: 'AAPL', venue: 'US' }, 1), /windowSessions must be >= 2/);
});

test('a swarm that beats the benchmark is still not told it has an edge', async () => {
  const { bars, sessions } = trending();
  const feed = new MemoryFeed(bars);
  const window = sessions.slice(0, 10);
  const bh = await computeBuyAndHold({
    feed,
    instruments: [{ symbol: 'AAPL', venue: 'US' }],
    sessionsByVenue: { US: window },
    startingCapital: money(500_000, 'SAR'),
    sarPerUsd: 3.75,
  });
  const swarm = computeSwarmMetrics({
    trades: [
      {
        symbol: 'AAPL', venue: 'US', side: 'SELL', qty: 100, priceMinor: 12_000, commissionMinor: 100,
        implicitCostMinor: 10, decisionDay: window[2] as string, fillDay: window[3] as string, decisionTick: 2,
        fillTick: 3, settleTick: 5, settleDay: window[5] as string, currency: 'USD',
        realisedMinor: bh.netBaseMinor * 2 + 100_000,
      },
    ],
    startingCapital: money(500_000, 'SAR'),
    sarPerUsd: 3.75,
  });
  const report = buildRunReport({
    runId: 'r2', startedAt: 0, finishedAt: 1, startingCapital: money(500_000, 'SAR'), sarPerUsd: 3.75,
    swarm, benchmark: bh, venues: [], distributions: [], instruments: [{ symbol: 'AAPL', venue: 'US' }], costs: {},
  });
  assert.equal(report.edge.verdict, 'AHEAD OF BUY-AND-HOLD');
  assert.match(report.edge.verdictText, /NOT evidence of an edge/);
  assert.ok(report.honesty.some((h) => /cannot separate skill from luck/i.test(h)));
  assert.ok(report.honesty.some((h) => /uninterpretable/.test(h)), 'a report with no distribution must say so');
  assert.ok(report.assumptions.some((a) => /CONFIGURABLE ASSUMPTION/.test(a)));
});
