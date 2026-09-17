/**
 * test/agents.trader.test.ts — the trading agent, under a deterministic clock,
 * a seeded RNG, a temp data directory and a STUB PriceFeed that implements the
 * frozen MARKET_SPEC §2 interface. Nothing here touches a network and nothing
 * depends on src/market/ being finished.
 *
 * The five things these tests exist to prove:
 *   1. leverage is impossible BY CONSTRUCTION, not merely unused;
 *   2. the reward lands on REALISED P&L at settlement, never on the mark;
 *   3. a decision taken on day D can never fill on day D (no lookahead);
 *   4. every decision is explained in memory, so a losing run is explicable;
 *   5. a strategy that loses is terminated by the survival machinery.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { makeRng } from '../src/core/rng.js';
import { money, type Currency, type Minor } from '../src/core/money.js';
import type { Envelope } from '../src/bus/protocol.js';
import {
  BUY_AND_HOLD_PARAMS,
  DEFAULT_SIZING,
  DEFAULT_STRATEGY_PARAMS,
  MAX_EXPOSURE_BPS,
  MEAN_REVERSION_PARAMS,
  MOMENTUM_PARAMS,
  STRATEGY_RATIONALE,
  TRADER_ARMS,
  TraderAgent,
  instrumentKey,
  makeSizingPolicy,
  newTraderId,
  sizePosition,
  strategySignal,
  traderFactory,
  warmupBars,
  zScore,
  type Bar,
  type EquityExecutor,
  type EquityFill,
  type EquityOrderRequest,
  type Instrument,
  type PriceFeed,
  type StrategyArm,
  type Venue,
} from '../src/agents/trader.js';
import { makeStack, StubAdapter, type Stack } from './agents.harness.js';

/* ───────────────────────────────────────────────────────── deterministic data */

/** Sessions Mon-Fri from a fixed Monday; enough for any warmup in these tests. */
function sessionDays(count: number, start = '2025-01-06'): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Build bars from an explicit close series. open = previous close, flat bars. */
function barsFrom(symbol: string, venue: Venue, days: string[], closes: number[], currency: Currency = 'SAR'): Bar[] {
  return days.slice(0, closes.length).map((dayUtc, i) => {
    const close = closes[i] as number;
    const open = i === 0 ? close : (closes[i - 1] as number);
    return {
      symbol,
      venue,
      dayUtc,
      openMinor: open,
      highMinor: Math.max(open, close),
      lowMinor: Math.min(open, close),
      closeMinor: close,
      volume: 1_000,
      currency,
    };
  });
}

/** A PriceFeed over a fixed set of bars. Implements the frozen §2 interface. */
class StubFeed implements PriceFeed {
  readonly name = 'stub-feed';
  calls = 0;
  constructor(private readonly series: Map<string, Bar[]>) {}
  async bars(symbol: string, venue: Venue, fromDay: string, toDay: string): Promise<Bar[]> {
    this.calls++;
    const all = this.series.get(`${venue}:${symbol}`) ?? [];
    return all.filter((b) => b.dayUtc >= fromDay && b.dayUtc <= toDay);
  }
  async latest(symbol: string, venue: Venue): Promise<Bar | null> {
    const all = this.series.get(`${venue}:${symbol}`) ?? [];
    return all.length === 0 ? null : (all[all.length - 1] as Bar);
  }
  async close(): Promise<void> {
    /* nothing to close */
  }
}

/**
 * A modelled executor: fills queued orders at the NEXT session's open against
 * the real bar, charges an explicit per-side cost, and settles T+N sessions
 * later. It refuses to fill on the decision day — the property under test.
 */
class StubExecutor implements EquityExecutor {
  readonly name = 'stub-exec';
  submitted: EquityOrderRequest[] = [];
  private queue: EquityOrderRequest[] = [];
  constructor(
    readonly channel: StubAdapter,
    private readonly feed: StubFeed,
    private readonly days: string[],
    private readonly costBps = 20,
    private readonly settlementDays = 2,
  ) {}
  async submit(order: EquityOrderRequest): Promise<void> {
    this.submitted.push(order);
    this.queue.push(order);
  }
  /** Liquidation at this session's CLOSE, exit costs charged, settling here. */
  async closeOut(req: { symbol: string; venue: Venue; qty: number; dayUtc: string; idempotencyKey: string }): Promise<EquityFill> {
    const bars = await this.feed.bars(req.symbol, req.venue, req.dayUtc, req.dayUtc);
    const bar = bars[0];
    if (bar === undefined) throw new Error(`no bar for ${req.symbol} on ${req.dayUtc}`);
    const gross = bar.closeMinor * req.qty;
    return {
      orderId: `closeout:${req.symbol}:${req.dayUtc}`,
      symbol: req.symbol,
      venue: req.venue,
      side: 'SELL',
      qty: req.qty,
      fillDayUtc: req.dayUtc,
      unitPriceMinor: bar.closeMinor,
      grossMinor: gross,
      costsMinor: Math.ceil((gross * this.costBps) / 10_000),
      settlesDayUtc: req.dayUtc,
      currency: 'SAR',
    };
  }

  async fills(venue: Venue, dayUtc: string): Promise<EquityFill[]> {
    const ready = this.queue.filter((o) => o.venue === venue && o.decidedDayUtc < dayUtc);
    this.queue = this.queue.filter((o) => !(o.venue === venue && o.decidedDayUtc < dayUtc));
    const out: EquityFill[] = [];
    for (const o of ready) {
      const bars = await this.feed.bars(o.symbol, o.venue, dayUtc, dayUtc);
      const bar = bars[0];
      if (bar === undefined) continue;
      const gross = bar.openMinor * o.qty;
      const costs = Math.ceil((gross * this.costBps) / 10_000);
      const i = this.days.indexOf(dayUtc);
      const settleIdx = Math.min(this.days.length - 1, i + this.settlementDays);
      out.push({
        orderId: o.orderId,
        symbol: o.symbol,
        venue: o.venue,
        side: o.side,
        qty: o.qty,
        fillDayUtc: dayUtc,
        unitPriceMinor: bar.openMinor,
        grossMinor: gross,
        costsMinor: costs,
        settlesDayUtc: this.days[settleIdx] as string,
        currency: 'SAR',
      });
    }
    return out;
  }
}

const ENV = {
  ARES_CHANNELS: 'equities',
  ARES_STARTING_CASH: '500000',
  ARES_CASH_CAP: '500000',
  ARES_AGENT_CASH_CAP: '500000',
  ARES_TRADE_CAP: '500000',
  ARES_MAX_ACTIONS: '8',
};

interface Rig {
  stack: Stack;
  agent: TraderAgent;
  feed: StubFeed;
  exec: StubExecutor;
  days: string[];
  universe: Instrument[];
  outcomes(): Envelope[];
}

async function rig(
  closes: number[],
  opts: { env?: Record<string, string>; arms?: readonly StrategyArm[]; sessions?: number; venue?: Venue; sizing?: Parameters<typeof makeSizingPolicy>[0] } = {},
): Promise<Rig> {
  const venue = opts.venue ?? 'US';
  const days = sessionDays(opts.sessions ?? closes.length);
  const bars = barsFrom('ACME', venue, days, closes);
  const feed = new StubFeed(new Map([[`${venue}:ACME`, bars]]));
  const channel = new StubAdapter({ name: 'equities' });
  const exec = new StubExecutor(channel, feed, days);
  const stack = await makeStack({ ...ENV, ...(opts.env ?? {}) }, { channels: [], extraChannels: new Map([['equities', channel]]) });
  const universe: Instrument[] = [{ symbol: 'ACME', venue }];
  const id = 'trader-1';
  const agent = new TraderAgent(id, 'equities-paper', stack.depsFor(id), {
    feed,
    executor: exec,
    universe,
    ...(opts.arms ? { arms: opts.arms } : {}),
    ...(opts.sizing ? { sizing: opts.sizing } : {}),
    historyDays: 400,
  });
  return {
    stack,
    agent,
    feed,
    exec,
    days,
    universe,
    outcomes: () => stack.of('STRATEGY_OUTCOME'),
  };
}

/**
 * `closeOutAtEnd` marks the last session as the run's final one, which is what
 * makes the agent liquidate at the close. A test that wants to observe a LIVE,
 * still-open position mid-run sets it false — otherwise the position it is
 * inspecting has already been marked out.
 */
async function runSessions(r: Rig, upto = r.days.length, opts: { venue?: Venue; closeOutAtEnd?: boolean } = {}): Promise<void> {
  const venue = opts.venue ?? 'US';
  const closeOut = opts.closeOutAtEnd ?? true;
  for (let i = 0; i < upto; i++) {
    r.agent.setSession({ venue, dayUtc: r.days[i] as string, tick: i, finalSession: closeOut && i === upto - 1 });
    await r.agent.runTick(i);
    // The supervisor drains the bus between ticks; these tests do the same, so
    // what the observer sees is what a real run would have delivered.
    await r.stack.bus.drain();
  }
}

/* ────────────────────────────────────────────────────────────── the strategies */

describe('trader: strategies are transparent, named and parameterised', () => {
  it('declares exactly three named arms with an honest rationale for each', () => {
    assert.deepEqual([...TRADER_ARMS], ['buy-and-hold', 'momentum', 'mean-reversion']);
    for (const arm of TRADER_ARMS) {
      assert.equal(typeof STRATEGY_RATIONALE[arm], 'string');
      assert.ok(STRATEGY_RATIONALE[arm].length > 40, `${arm} needs a real rationale, not a slogan`);
    }
    // The parameters are declared, not hidden inside the decision function.
    assert.equal(MOMENTUM_PARAMS.entryLookback, 20);
    assert.equal(MOMENTUM_PARAMS.exitLookback, 10);
    assert.equal(MEAN_REVERSION_PARAMS.lookback, 20);
    assert.equal(MEAN_REVERSION_PARAMS.entryZ, -1.5);
    assert.equal(MEAN_REVERSION_PARAMS.exitZ, 0);
    assert.deepEqual(BUY_AND_HOLD_PARAMS, {});
  });

  it('holds while warming up instead of trading on a signal it cannot compute', () => {
    const short = [100, 101, 102];
    for (const arm of TRADER_ARMS) {
      const s = strategySignal(arm, short, false);
      if (warmupBars(arm) > short.length) {
        assert.equal(s.action, 'HOLD');
        assert.equal(s.ready, false);
      }
    }
  });

  it('momentum: enters on an N-day closing breakout and exits on the M-day low', () => {
    const flat = new Array(20).fill(100) as number[];
    const enter = strategySignal('momentum', [...flat, 101], false);
    assert.equal(enter.action, 'ENTER');
    assert.equal(enter.threshold, 100);
    assert.equal(enter.value, 101);
    const hold = strategySignal('momentum', [...flat, 100], false);
    assert.equal(hold.action, 'HOLD');
    const exit = strategySignal('momentum', [...flat, 99], true);
    assert.equal(exit.action, 'EXIT');
    assert.equal(exit.threshold, 100);
  });

  it('mean-reversion: enters at z <= -1.5 and exits at z >= 0, on real z-scores', () => {
    const base = new Array(19).fill(100) as number[];
    base[0] = 90;
    base[1] = 110; // give the window some variance
    const cheap = [...base, 60];
    const z = zScore(cheap, MEAN_REVERSION_PARAMS.lookback);
    assert.ok(z !== null);
    const sig = strategySignal('mean-reversion', cheap, false);
    assert.equal(sig.threshold, -1.5);
    assert.equal(sig.value, (z as { z: number }).z);
    assert.equal(sig.action, (z as { z: number }).z <= -1.5 ? 'ENTER' : 'HOLD');
    const rich = [...base, 130];
    assert.equal(strategySignal('mean-reversion', rich, true).action, 'EXIT');
  });

  it('buy-and-hold enters once and never exits on a signal', () => {
    assert.equal(strategySignal('buy-and-hold', [100], false).action, 'ENTER');
    assert.equal(strategySignal('buy-and-hold', [100, 1], true).action, 'HOLD');
  });
});

/* ────────────────────────────────── leverage is impossible BY CONSTRUCTION */

describe('trader: position sizing cannot produce leverage', () => {
  it('REFUSES a policy that asks for more exposure than equity, at construction', () => {
    assert.throws(
      () => makeSizingPolicy({ maxTotalExposureBps: MAX_EXPOSURE_BPS + 1 }),
      (e: unknown) => {
        const err = e as { code?: string; message?: string };
        assert.equal(err.code, 'SIZING_INVALID');
        assert.match(String(err.message), /leverage/i);
        return true;
      },
    );
    // 20x leverage, the shape a "double it in 10 days" request actually needs.
    assert.throws(() => makeSizingPolicy({ maxTotalExposureBps: 200_000, maxPositionFractionBps: 200_000 }));
    // And a single position may not be allowed more than the whole book.
    assert.throws(() => makeSizingPolicy({ maxPositionFractionBps: 9_000, maxTotalExposureBps: 5_000 }));
  });

  it('REFUSES to size a position past equity even when asked directly', () => {
    const policy = makeSizingPolicy({ maxTotalExposureBps: MAX_EXPOSURE_BPS, maxPositionFractionBps: MAX_EXPOSURE_BPS, riskPerTradeBps: 10_000, stopLossBps: 1 });
    // Equity fully committed already: there is no headroom to borrow into.
    const d = sizePosition({ equityMinor: 100_000, exposureMinor: 100_000, cashAvailableMinor: 10_000_000, unitPriceMinor: 1_000, perTradeCapMinor: 10_000_000 }, policy);
    assert.equal(d.refused, true);
    assert.equal(d.qty, 0);
    assert.equal(d.binding, 'exposure-cap');
    // Cash far beyond equity does not create room: exposure is capped on EQUITY.
    const d2 = sizePosition({ equityMinor: 100_000, exposureMinor: 0, cashAvailableMinor: 100_000_000, unitPriceMinor: 1_000, perTradeCapMinor: 100_000_000 }, policy);
    assert.equal(d2.refused, false);
    assert.ok(d2.notionalMinor <= 100_000, `notional ${d2.notionalMinor} must not exceed equity`);
  });

  it('never, over a thousand seeded draws, returns a notional that exceeds equity', () => {
    const rng = makeRng(20250917);
    const policy = makeSizingPolicy({ maxTotalExposureBps: MAX_EXPOSURE_BPS, maxPositionFractionBps: MAX_EXPOSURE_BPS, riskPerTradeBps: 10_000, stopLossBps: 1 });
    for (let i = 0; i < 1_000; i++) {
      const equity = rng.int(1_000_000) + 1;
      const exposure = rng.int(equity + 1);
      const price = rng.int(50_000) + 1;
      const d = sizePosition(
        { equityMinor: equity, exposureMinor: exposure, cashAvailableMinor: 10 ** 9, unitPriceMinor: price, perTradeCapMinor: 10 ** 9 },
        policy,
      );
      assert.ok(exposure + d.notionalMinor <= equity, `draw ${i}: ${exposure} + ${d.notionalMinor} > ${equity}`);
    }
  });

  it('is risk-based: a wider stop buys fewer units for the same equity', () => {
    const tight = makeSizingPolicy({ stopLossBps: 200 });
    const wide = makeSizingPolicy({ stopLossBps: 2_000 });
    const req = { equityMinor: 1_000_000, exposureMinor: 0, cashAvailableMinor: 1_000_000, unitPriceMinor: 1_000, perTradeCapMinor: 1_000_000 };
    assert.ok(sizePosition(req, tight).qty > sizePosition(req, wide).qty);
  });

  it('reports which cap bound the size, so the decision can be re-derived', () => {
    const policy = makeSizingPolicy({ riskPerTradeBps: 10_000, stopLossBps: 1, maxPositionFractionBps: 1_000 });
    const d = sizePosition({ equityMinor: 1_000_000, exposureMinor: 0, cashAvailableMinor: 1_000_000, unitPriceMinor: 1_000, perTradeCapMinor: 1_000_000 }, policy);
    assert.equal(d.binding, 'position-cap');
    assert.equal(d.qty, 100); // 10% of 1,000,000 at a price of 1,000
    assert.match(d.reason, /binding cap was position-cap/);
  });

  it('defaults sit below the ceiling so drift cannot push the book over it', () => {
    assert.ok(DEFAULT_SIZING.maxTotalExposureBps < MAX_EXPOSURE_BPS);
    assert.ok(DEFAULT_SIZING.maxPositionFractionBps <= DEFAULT_SIZING.maxTotalExposureBps);
  });
});

/* ─────────────────────────────────────────────────────────── the live agent */

describe('trader: execution, lookahead and explanation', () => {
  it('refuses to be built without a feed, an executor, a policy-gated channel or a universe', async () => {
    const r = await rig([100, 101]);
    try {
      const deps = r.stack.depsFor('trader-x');
      assert.throws(() => new TraderAgent('trader-x', 's', deps, { feed: null as unknown as PriceFeed, executor: r.exec, universe: r.universe }));
      assert.throws(() => new TraderAgent('trader-x', 's', deps, { feed: r.feed, executor: { name: 'x' } as unknown as EquityExecutor, universe: r.universe }));
      assert.throws(() => new TraderAgent('trader-x', 's', deps, { feed: r.feed, executor: r.exec, universe: [] }));
    } finally {
      r.stack.close();
    }
  });

  it('NEVER fills on the bar it decided on: the order fills at the next open', async () => {
    const closes = [100_00, 101_00, 102_00, 103_00, 104_00, 105_00];
    const r = await rig(closes, { arms: ['buy-and-hold'] });
    try {
      await runSessions(r, 5);
      const order = r.exec.submitted[0];
      assert.ok(order !== undefined, 'an order should have been submitted');
      const buys = r.stack.of('BUY_RESULT');
      assert.ok(buys.length >= 1);
      const fill = buys[0]?.payload as { fillDayUtc: string; unitPriceMinor: number };
      assert.ok(fill.fillDayUtc > (order as EquityOrderRequest).decidedDayUtc, 'a fill on the decision day is lookahead');
      // And it filled at the OPEN of that session, not the close it decided on.
      const idx = r.days.indexOf(fill.fillDayUtc);
      assert.equal(fill.unitPriceMinor, closes[idx - 1]);
    } finally {
      r.stack.close();
    }
  });

  it('writes the rationale of EVERY decision into memory: arm, value, threshold, size', async () => {
    const r = await rig([100_00, 101_00, 102_00, 103_00], { arms: ['buy-and-hold'] });
    try {
      await runSessions(r, 4);
      const mem = r.stack.memories.get('trader-1');
      assert.ok(mem !== undefined);
      const decisions = (mem as NonNullable<typeof mem>).recall('trade-decision');
      assert.ok(decisions.length >= 3, `expected a record per session, got ${decisions.length}`);
      for (const d of decisions) {
        assert.equal(typeof d.meta['arm'], 'string');
        assert.equal(typeof d.meta['signalValue'], 'number');
        assert.equal(typeof d.meta['signalThreshold'], 'number');
        assert.equal(typeof d.meta['signalReason'], 'string');
        assert.equal(typeof d.meta['action'], 'string');
        assert.equal(typeof d.meta['equityMinor'], 'number');
        assert.equal(typeof d.meta['dayUtc'], 'string');
      }
      const entry = decisions.find((d) => d.meta['action'] === 'ENTER');
      assert.ok(entry !== undefined, 'the entry decision must be explained');
      assert.equal(typeof entry.meta['sizingBinding'], 'string');
      assert.match(String(entry.meta['sizingReason']), /binding cap was/);
    } finally {
      r.stack.close();
    }
  });

  it('books a PAPER-marked BUY that capitalises the commission into the basis', async () => {
    const r = await rig([100_00, 100_00, 100_00, 100_00], { arms: ['buy-and-hold'] });
    try {
      await runSessions(r, 4);
      const buys = r.stack.ledger.entries({ type: 'BUY' });
      assert.ok(buys.length >= 1);
      const e = buys[0];
      assert.equal(e?.meta['paper'], true);
      const inv = (e?.legs ?? []).find((l) => l.account === 'inventory');
      const cash = (e?.legs ?? []).find((l) => l.account === 'cash');
      const fees = (e?.legs ?? []).find((l) => l.account === 'fees');
      // Cash out == inventory + the indivisible fee remainder: nothing vanishes.
      assert.equal(-(cash?.amount ?? 0), (inv?.amount ?? 0) + (fees?.amount ?? 0));
      // The cost is IN the basis, not expensed away from it.
      assert.ok((inv?.amount ?? 0) > 0);
    } finally {
      r.stack.close();
    }
  });
});

/* ──────────────────────── the reward rule: realised, at settlement, never the mark */

describe('trader: the bandit is rewarded on realised P&L at settlement', () => {
  /**
   * The series rises while the position is held and then gaps down below the
   * entry before the exit fills. A mark-to-market reward would have paid this
   * trade handsomely at its peak; the realised outcome is a LOSS, and the loss
   * is what the bandit and the survival evaluator are told about.
   */
  const RISE_THEN_CRASH = [100_00, 100_00, 150_00, 150_00, 40_00, 40_00, 40_00, 40_00];

  it('records NO outcome while the position is merely marked up', async () => {
    const r = await rig(RISE_THEN_CRASH, { arms: ['buy-and-hold'] });
    try {
      // Sessions 0..3: enter, fill, and the mark runs from 100 to 150. The run
      // is NOT ended here, so the position is still open and still unrealised.
      await runSessions(r, 4, { closeOutAtEnd: false });
      assert.equal(r.outcomes().length, 0, 'an unrealised gain is not an outcome');
      assert.equal(r.agent.traderStats().roundTripsClosed, 0);
      assert.ok(r.agent.openPositions().length === 1);
    } finally {
      r.stack.close();
    }
  });

  it('pays the REALISED loss, not the peak mark, and only once the cash settles', async () => {
    const r = await rig(RISE_THEN_CRASH, { arms: ['buy-and-hold'] });
    try {
      await runSessions(r, RISE_THEN_CRASH.length);
      const outs = r.outcomes();
      assert.equal(outs.length, 1, 'exactly one settled round trip');
      const o = outs[0]?.payload as { netMinor: number; success: boolean; meta: Record<string, unknown> };
      assert.ok(o.netMinor < 0, `realised P&L should be a loss, got ${o.netMinor}`);
      assert.equal(o.success, false);
      assert.equal(o.meta['rewardBasis'], 'realised-at-settlement');
      // The realised figure is proceeds - basis, to the halala.
      assert.equal(o.netMinor, (o.meta['proceedsMinor'] as number) - (o.meta['basisMinor'] as number));
      // The mark is RECORDED beside it and is different — that is the whole point.
      assert.equal(typeof o.meta['markAtSaleMinor'], 'number');
      // The bandit took a failure, not a success.
      const w = r.agent.learner.weights()['buy-and-hold'];
      assert.ok(w !== undefined && w.b > 1, 'a losing round trip must increment the failure count');
      assert.equal(w.a, 1);
      // The exit here is the final-session close-out: marked out at that
      // session's close with the exit costs charged, which is the same
      // convention market/report.ts closes the benchmark with.
      const sales = r.stack.ledger.entries({ type: 'SALE' });
      assert.equal(sales.length, 1);
      assert.equal(sales[0]?.meta['paper'], true);
      assert.ok((o.meta['costsMinor'] as number) > 0, 'the exit is not free');
    } finally {
      r.stack.close();
    }
  });

  it('settles T+2: a signal-driven exit is booked on the SETTLEMENT session', async () => {
    // 20 flat sessions of warmup, a breakout that enters, then a collapse below
    // the 10-session low that exits — mid-run, so the T+2 delay is observable.
    const closes = [
      ...new Array(20).fill(100_00),
      101_00, 101_00, 101_00,
      50_00, 50_00, 50_00, 50_00, 50_00,
    ] as number[];
    const r = await rig(closes, { arms: ['momentum'] });
    try {
      await runSessions(r, closes.length, { closeOutAtEnd: false });
      const sales = r.stack.ledger.entries({ type: 'SALE' });
      assert.equal(sales.length, 1, 'the momentum exit should have fired and settled');
      const sale = sales[0];
      assert.notEqual(sale?.meta['soldDayUtc'], sale?.meta['settlementDayUtc']);
      assert.ok(String(sale?.meta['settlementDayUtc']) > String(sale?.meta['soldDayUtc']));
      // And nothing was learned from it before the cash landed.
      const outs = r.outcomes();
      assert.equal(outs.length, 1);
      assert.equal((outs[0]?.payload as { meta: Record<string, unknown> }).meta['settledDayUtc'], sale?.meta['settlementDayUtc']);
    } finally {
      r.stack.close();
    }
  });

  it('a profitable round trip increments the success count instead', async () => {
    const r = await rig([100_00, 100_00, 100_00, 400_00, 400_00, 400_00, 400_00], { arms: ['buy-and-hold'] });
    try {
      await runSessions(r, 7);
      const outs = r.outcomes();
      assert.equal(outs.length, 1);
      const o = outs[0]?.payload as { netMinor: number; success: boolean };
      assert.ok(o.netMinor > 0);
      const w = r.agent.learner.weights()['buy-and-hold'];
      assert.ok(w !== undefined && w.a > 1);
    } finally {
      r.stack.close();
    }
  });
});

/* ──────────────────────────────────── survival terminates a losing strategy */

describe('trader: a losing strategy is terminated by the survival machinery', () => {
  it('reaches TERMINATE on realised losses and dies with a postmortem', async () => {
    // Zero tolerance, no grace, no statistical floor: the operator's literal rule.
    const r = await rig([100_00, 100_00, 100_00, 30_00, 30_00, 30_00, 30_00], {
      arms: ['buy-and-hold'],
      env: { ARES_WINDOW_TICKS: '1', ARES_GRACE_WINDOWS: '0', ARES_MIN_SAMPLES: '0', ARES_PROBATION_WINDOWS: '0' },
    });
    try {
      await runSessions(r, 7);
      const outs = r.outcomes();
      assert.equal(outs.length, 1, 'the losing round trip must have settled');
      const tick = (outs[0]?.payload as { tick: number }).tick;
      const verdict = r.stack.survival.evaluate('trader-1', tick);
      assert.equal(verdict.verdict, 'TERMINATE', verdict.reason);
      assert.ok(verdict.judgedNetMinor < 0);
      // And the judged number is the REALISED outcome, not a cash-flow artefact.
      assert.equal(verdict.windowSamples, 1);

      await r.agent.terminate(`survival: ${verdict.reason}`);
      assert.equal(r.agent.isTerminated, true);
      const pm = r.agent.lastPostmortem();
      assert.ok(pm !== null);
      assert.match(pm.text, /terminated/);
    } finally {
      r.stack.close();
    }
  });

  it('an idle session is UNJUDGED, so doing nothing is not a way to survive', async () => {
    const r = await rig([100_00, 100_00, 100_00], { arms: ['momentum'] }); // never breaks out
    try {
      await runSessions(r, 3);
      assert.equal(r.outcomes().length, 0);
      const v = r.stack.survival.evaluate('trader-1', 2);
      assert.ok(v.verdict === 'UNJUDGED' || v.verdict === 'IMMATURE', v.verdict);
    } finally {
      r.stack.close();
    }
  });
});

/* ───────────────────────────────────────────────────────────── resumability */

describe('trader: state survives a restart', () => {
  it('a fresh agent over the same memory resumes its position, not a blank book', async () => {
    const closes = [100_00, 100_00, 100_00, 100_00, 100_00, 100_00];
    const r = await rig(closes, { arms: ['buy-and-hold'] });
    try {
      await runSessions(r, 3, { closeOutAtEnd: false });
      const before = r.agent.openPositions();
      assert.equal(before.length, 1);
      assert.ok((before[0] as { qty: number }).qty > 0);

      // Same memory scope, same data dir: a container restart, not a new agent.
      const revived = new TraderAgent('trader-1', 'equities-paper', r.stack.depsFor('trader-1'), {
        feed: r.feed,
        executor: r.exec,
        universe: r.universe,
        arms: ['buy-and-hold'],
        historyDays: 400,
      });
      const after = revived.openPositions();
      assert.equal(after.length, 1);
      assert.equal((after[0] as { qty: number }).qty, (before[0] as { qty: number }).qty);
      assert.equal((after[0] as { basisMinor: number }).basisMinor, (before[0] as { basisMinor: number }).basisMinor);
      assert.equal(revived.resumedFromDay, r.days[2]);
      // The bandit posterior came back too, not a fresh uniform prior.
      assert.deepEqual(revived.learner.weights(), r.agent.learner.weights());
    } finally {
      r.stack.close();
    }
  });

  it('hands over open positions and unsettled cash when it dies', async () => {
    const r = await rig([100_00, 100_00, 100_00, 100_00], { arms: ['buy-and-hold'] });
    try {
      await runSessions(r, 3, { closeOutAtEnd: false });
      const state = r.agent.handoverState();
      assert.ok(Array.isArray(state['openPositions']));
      assert.ok(Array.isArray(state['pendingSettlements']));
    } finally {
      r.stack.close();
    }
  });
});

/* ─────────────────────────────────────────────────── the safety machinery holds */

describe('trader: the safety machinery is still wired', () => {
  it('a tripped kill switch stops the agent trading', async () => {
    const r = await rig([100_00, 100_00, 100_00, 100_00], { arms: ['buy-and-hold'] });
    try {
      r.stack.killSwitch.trip('operator halt');
      await runSessions(r, 3, { closeOutAtEnd: false });
      assert.equal(r.exec.submitted.length, 0, 'a halted swarm places no orders');
    } finally {
      r.stack.close();
    }
  });

  it('refuses a channel the policy engine does not allow', async () => {
    const closes = [100_00, 100_00, 100_00, 100_00];
    const days = sessionDays(4);
    const feed = new StubFeed(new Map([['US:ACME', barsFrom('ACME', 'US', days, closes)]]));
    const channel = new StubAdapter({ name: 'not-allowed' });
    const exec = new StubExecutor(channel, feed, days);
    const stack = await makeStack(ENV, { channels: [], extraChannels: new Map([['not-allowed', channel]]) });
    try {
      const agent = new TraderAgent('trader-2', 'equities-paper', stack.depsFor('trader-2'), {
        feed,
        executor: exec,
        universe: [{ symbol: 'ACME', venue: 'US' }],
        arms: ['buy-and-hold'],
        historyDays: 400,
      });
      for (let i = 0; i < 3; i++) {
        agent.setSession({ venue: 'US', dayUtc: days[i] as string, tick: i });
        await agent.runTick(i);
        await stack.bus.drain();
      }
      assert.equal(exec.submitted.length, 0);
      assert.ok(stack.of('POLICY_DENIED').length > 0);
    } finally {
      stack.close();
    }
  });

  it('the factory and id helper produce a usable agent', async () => {
    const r = await rig([100_00, 100_00], { arms: ['buy-and-hold'] });
    try {
      const make = traderFactory({ feed: r.feed, executor: r.exec, universe: r.universe, arms: ['buy-and-hold'] });
      const id = newTraderId();
      assert.match(id, /^trader_/);
      const a = make(id, 'equities-paper', r.stack.depsFor(id));
      assert.equal(a.role, 'trader');
      assert.equal(instrumentKey({ symbol: 'ACME', venue: 'US' }), 'US:ACME');
      assert.equal(a.params, DEFAULT_STRATEGY_PARAMS);
      assert.equal(money(1, 'SAR').currency, 'SAR');
      const _minor: Minor = 1;
      assert.equal(_minor, 1);
    } finally {
      r.stack.close();
    }
  });
});
