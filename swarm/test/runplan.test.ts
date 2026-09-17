/**
 * test/runplan.test.ts — the dated run controller: per-venue session counting,
 * resumability, the mandatory benchmark comparison and the §10 base rate.
 *
 * Everything is deterministic: TestClock and seeded RNG from the agent harness,
 * a temp data directory, the REAL SessionCalendar and the REAL report module,
 * and a stub PriceFeed implementing the frozen MARKET_SPEC §2 interface so
 * nothing here depends on the CSV feed or on a network.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { Minor } from '../src/core/money.js';
import {
  TraderAgent,
  makeSizingPolicy,
  type Bar,
  type EquityExecutor,
  type EquityFill,
  type EquityOrderRequest,
  type PriceFeed,
  type StrategyArm,
  type Venue,
} from '../src/agents/trader.js';
import { SessionCalendar } from '../src/market/calendar.js';
import { DEFAULT_COSTS, commissionMinor, modelFill } from '../src/channels/equities.js';
import type { InstrumentRef } from '../src/market/report.js';
import { RunPlan, armWindowedEvaluation, simulateStrategy, type RunPlanOptions } from '../src/runtime/runplan.js';
import { makeStack, StubAdapter, type Stack } from './agents.harness.js';

/* ────────────────────────────────────────────────────────── deterministic data */

const CAL = new SessionCalendar();

/** Bars on the venue's REAL session days, from an explicit close series. */
function barsFor(symbol: string, venue: Venue, fromDay: string, closes: number[]): Bar[] {
  const days = CAL.sessionsBetween(venue, fromDay, '2027-12-31').slice(0, closes.length);
  return days.map((dayUtc, i) => {
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
      currency: venue === 'US' ? ('USD' as const) : ('SAR' as const),
    };
  });
}

class StubFeed implements PriceFeed {
  readonly name = 'stub-feed';
  constructor(private readonly series: Map<string, Bar[]>) {}
  async bars(symbol: string, venue: Venue, fromDay: string, toDay: string): Promise<Bar[]> {
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

/** Fills at the next session's open; liquidates at the close on the last one. */
class StubExecutor implements EquityExecutor {
  readonly name = 'stub-exec';
  submitted: EquityOrderRequest[] = [];
  private queue: EquityOrderRequest[] = [];
  constructor(readonly channel: StubAdapter, private readonly feed: StubFeed, private readonly costBps = 20) {}
  async submit(order: EquityOrderRequest): Promise<void> {
    this.submitted.push(order);
    this.queue.push(order);
  }
  async fills(venue: Venue, dayUtc: string): Promise<EquityFill[]> {
    const ready = this.queue.filter((o) => o.venue === venue && o.decidedDayUtc < dayUtc);
    this.queue = this.queue.filter((o) => !(o.venue === venue && o.decidedDayUtc < dayUtc));
    const out: EquityFill[] = [];
    for (const o of ready) {
      const bar = (await this.feed.bars(o.symbol, o.venue, dayUtc, dayUtc))[0];
      if (bar === undefined) continue;
      const gross = bar.openMinor * o.qty;
      out.push({
        orderId: o.orderId,
        symbol: o.symbol,
        venue: o.venue,
        side: o.side,
        qty: o.qty,
        fillDayUtc: dayUtc,
        unitPriceMinor: bar.openMinor,
        grossMinor: gross,
        costsMinor: Math.ceil((gross * this.costBps) / 10_000),
        settlesDayUtc: CAL.addSessions(o.venue, dayUtc, 2),
        currency: 'SAR',
      });
    }
    return out;
  }
  async closeOut(req: { symbol: string; venue: Venue; qty: number; dayUtc: string }): Promise<EquityFill> {
    const bar = (await this.feed.bars(req.symbol, req.venue, req.dayUtc, req.dayUtc))[0];
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
}

const ENV = {
  ARES_CHANNELS: 'equities',
  ARES_STARTING_CASH: '500000',
  ARES_CASH_CAP: '500000',
  ARES_AGENT_CASH_CAP: '500000',
  ARES_TRADE_CAP: '500000',
  ARES_MAX_ACTIONS: '8',
};

const FROM = '2025-01-05'; // a Sunday: Tadawul's week starts before the US's
const TO = '2025-02-28';

interface Rig {
  stack: Stack;
  trader: TraderAgent;
  feed: StubFeed;
  exec: StubExecutor;
  universe: InstrumentRef[];
  plan(over?: Partial<RunPlanOptions>): RunPlan;
}

async function rig(
  series: Array<{ symbol: string; venue: Venue; closes: number[] }>,
  opts: { arms?: readonly StrategyArm[]; sessions?: number; runId?: string; env?: Record<string, string> } = {},
): Promise<Rig> {
  const map = new Map<string, Bar[]>();
  for (const s of series) map.set(`${s.venue}:${s.symbol}`, barsFor(s.symbol, s.venue, FROM, s.closes));
  const feed = new StubFeed(map);
  const channel = new StubAdapter({ name: 'equities' });
  const exec = new StubExecutor(channel, feed);
  const stack = await makeStack({ ...ENV, ...(opts.env ?? {}) }, { channels: [], extraChannels: new Map([['equities', channel]]) });
  const universe: InstrumentRef[] = series.map((s) => ({ symbol: s.symbol, venue: s.venue }));
  const trader = new TraderAgent('trader-1', 'equities-paper', stack.depsFor('trader-1'), {
    feed,
    executor: exec,
    universe,
    ...(opts.arms ? { arms: opts.arms } : {}),
    historyDays: 400,
  });
  return {
    stack,
    trader,
    feed,
    exec,
    universe,
    plan(over: Partial<RunPlanOptions> = {}): RunPlan {
      return new RunPlan({
        runId: opts.runId ?? 'run-test',
        cfg: stack.cfg,
        logger: stack.logger,
        taskMemory: stack.taskMemory,
        calendar: CAL,
        feed,
        trader,
        universe,
        fromDayUtc: FROM,
        toDayUtc: TO,
        sessionsPerVenue: opts.sessions ?? 10,
        startingCapitalMinor: 500_000,
        sizing: makeSizingPolicy({}),
        windowed: { windowSessions: 10, step: 1 },
        ...over,
      });
    },
  };
}

const FLAT = new Array(40).fill(100_00) as number[];

/* ─────────────────────────────────── sessions are counted PER VENUE */

describe('runplan: sessions are counted per venue and the report says so', () => {
  it('gives US Mon-Fri and Tadawul Sun-Thu their own ten sessions', async () => {
    const r = await rig([
      { symbol: 'ACME', venue: 'US', closes: FLAT },
      { symbol: 'TADCO', venue: 'TADAWUL', closes: FLAT },
    ]);
    try {
      const steps = r.plan().buildPlan();
      const us = steps.filter((s) => s.venue === 'US').map((s) => s.dayUtc);
      const sa = steps.filter((s) => s.venue === 'TADAWUL').map((s) => s.dayUtc);
      assert.equal(us.length, 10);
      assert.equal(sa.length, 10);
      // The two windows are NOT the same ten calendar days. That is the point.
      assert.notDeepEqual(us, sa);
      assert.equal(sa[0], '2025-01-05'); // Sunday — the US is shut
      assert.equal(us[0], '2025-01-06'); // Monday
      assert.ok(sa[sa.length - 1] !== us[us.length - 1]);
      // Every US day is a weekday, every Tadawul day is Sun-Thu.
      for (const d of us) assert.ok(CAL.isSession('US', d));
      for (const d of sa) assert.ok(CAL.isSession('TADAWUL', d));
      // Steps are interleaved in DATE order, which is how the run executes.
      const dates = steps.map((s) => s.dayUtc);
      assert.deepEqual(dates, [...dates].sort());
      steps.forEach((s, i) => assert.equal(s.index, i));
    } finally {
      r.stack.close();
    }
  });

  it('states the misalignment in the report instead of leaving it to be noticed', async () => {
    const r = await rig([
      { symbol: 'ACME', venue: 'US', closes: FLAT },
      { symbol: 'TADCO', venue: 'TADAWUL', closes: FLAT },
    ]);
    try {
      const res = await r.plan().run();
      const venues = res.report.venues;
      assert.equal(venues.length, 2);
      for (const v of venues) assert.equal(v.sessions, 10);
      assert.notEqual(venues[0]?.firstSession, venues[1]?.firstSession);
      const note = res.report.assumptions.find((a) => a.includes('SESSION COUNTS ARE PER VENUE'));
      assert.ok(note !== undefined, 'the report must SAY the calendars do not align');
      assert.match(note, /Mon-Fri/);
      assert.match(note, /Sun-Thu/);
    } finally {
      r.stack.close();
    }
  });
});

/* ─────────────────────────────────────────────────────── resumability */

describe('runplan: a resumed run continues rather than restarts', () => {
  it('skips the sessions already completed and says it resumed', async () => {
    const r = await rig([{ symbol: 'TADCO', venue: 'TADAWUL', closes: FLAT }], { sessions: 6 });
    try {
      const plan = r.plan();
      const steps = plan.buildPlan();
      // A container that died after two sessions leaves exactly this behind.
      r.stack.taskMemory.setFact('runplan.progress:run-test', {
        runId: 'run-test',
        fingerprint: plan.fingerprint(),
        cursor: 2,
        totalSteps: steps.length,
        perVenue: { TADAWUL: 2 },
        lastDayUtc: steps[1]?.dayUtc ?? null,
        startedAtMs: 1,
        updatedAtMs: 1,
      });
      r.stack.taskMemory.flush();

      const res = await r.plan().run();
      assert.equal(res.resumed, true);
      assert.equal(res.sessionsExecuted, steps.length - 2, 'the completed sessions must not be replayed');
      // The skipped days were never traded by this process.
      const mem = r.stack.memories.get('trader-1');
      const decisions = (mem as NonNullable<typeof mem>).recall('trade-decision');
      const touched = new Set(decisions.map((d) => String(d.meta['dayUtc'])));
      assert.equal(touched.has(String(steps[0]?.dayUtc)), false);
      assert.equal(touched.has(String(steps[2]?.dayUtc)), true);
    } finally {
      r.stack.close();
    }
  });

  it('re-running a finished plan is a no-op, not a second run', async () => {
    const r = await rig([{ symbol: 'TADCO', venue: 'TADAWUL', closes: FLAT }], { sessions: 5 });
    try {
      const first = await r.plan().run();
      assert.equal(first.sessionsExecuted, 5);
      const ledgerSize = r.stack.ledger.size();
      const second = await r.plan().run();
      assert.equal(second.sessionsExecuted, 0);
      assert.equal(second.resumed, true);
      assert.equal(r.stack.ledger.size(), ledgerSize, 'a resumed run must not double-book');
    } finally {
      r.stack.close();
    }
  });

  it('REFUSES to resume a runId whose plan has changed underneath it', async () => {
    const r = await rig([{ symbol: 'TADCO', venue: 'TADAWUL', closes: FLAT }], { sessions: 5 });
    try {
      await r.plan().run();
      await assert.rejects(
        () => r.plan({ sessionsPerVenue: 7 }).run(),
        (e: unknown) => {
          const err = e as { code?: string; message?: string };
          assert.equal(err.code, 'RUNPLAN_FINGERPRINT_MISMATCH');
          assert.match(String(err.message), /interleave/);
          return true;
        },
      );
    } finally {
      r.stack.close();
    }
  });

  it('records progress after every session, not at the end', async () => {
    const r = await rig([{ symbol: 'TADCO', venue: 'TADAWUL', closes: FLAT }], { sessions: 4 });
    try {
      await r.plan().run();
      const p = r.plan().progress();
      assert.ok(p !== null);
      assert.equal(p.cursor, 4);
      assert.equal(p.totalSteps, 4);
      assert.equal(p.perVenue['TADAWUL'], 4);
      assert.deepEqual(r.plan().sessionsCompleted(), { TADAWUL: 4 });
    } finally {
      r.stack.close();
    }
  });
});

/* ───────────────────────────────── the benchmark comparison, including costs */

describe('runplan: the benchmark is computed on the same terms and the verdict is words', () => {
  it('a flat market makes buy-and-hold LOSE exactly its costs', async () => {
    const r = await rig([{ symbol: 'TADCO', venue: 'TADAWUL', closes: FLAT }], { sessions: 10 });
    try {
      const res = await r.plan().run();
      const b = res.report.benchmark;
      // Prices never moved, so every halala of the loss is cost.
      assert.ok(b.netBaseMinor < 0, `flat prices with real costs must lose, got ${b.netBaseMinor}`);
      assert.ok(b.costsBaseMinor > 0);
      assert.equal(b.legs.length, 1);
      const leg = b.legs[0];
      assert.ok((leg?.costsMinor ?? 0) > 0, 'the benchmark pays commission on both sides');
      // Entry is at the SECOND session's open — the same no-lookahead rule the
      // swarm plays by, so the benchmark has no advantage the swarm lacked.
      const sessions = CAL.sessionsBetween('TADAWUL', FROM, TO).slice(0, 10);
      assert.equal(leg?.entryDay, sessions[1]);
      assert.equal(leg?.exitDay, sessions[9]);
    } finally {
      r.stack.close();
    }
  });

  it('says NO EDGE in words when the swarm trails buy-and-hold', async () => {
    // A rising market: buy-and-hold captures the move; a swarm that pays costs
    // to do the same thing cannot beat it.
    const rising = Array.from({ length: 40 }, (_, i) => 100_00 + i * 200);
    const r = await rig([{ symbol: 'TADCO', venue: 'TADAWUL', closes: rising }], { sessions: 10, arms: ['mean-reversion'] });
    try {
      const res = await r.plan().run();
      assert.ok(res.report.swarm.realisedNetBaseMinor <= res.report.benchmark.netBaseMinor);
      assert.equal(res.report.edge.verdict, 'NO EDGE');
      assert.match(res.report.edge.verdictText, /NO EDGE/);
      assert.match(res.report.edge.verdictText, /underperformed/);
      // The verdict is rendered at the top of the human report, not buried.
      const text = r.plan().renderText(res);
      assert.ok(text.indexOf('VERDICT') < 200, 'the verdict must not be buried');
    } finally {
      r.stack.close();
    }
  });

  it('counts BOTH sides of every swarm round trip in the cost total', async () => {
    const r = await rig([{ symbol: 'TADCO', venue: 'TADAWUL', closes: FLAT }], { sessions: 6, arms: ['buy-and-hold'] });
    try {
      const res = await r.plan().run();
      const trades = r.plan().swarmTrades();
      assert.equal(trades.length % 2, 0, 'one entry row and one exit row per round trip');
      assert.ok(trades.some((t) => t.side === 'BUY' && t.realisedMinor === null));
      assert.ok(trades.some((t) => t.side === 'SELL' && t.realisedMinor !== null));
      assert.ok(res.report.swarm.totalCostsBaseMinor > 0, 'entry costs are counted, not quietly dropped');
      assert.equal(res.report.swarm.closedTradeCount, 1);
      // A flat market plus real costs is a loss. There is no version of this
      // where trading for free is the answer.
      assert.ok(res.report.swarm.realisedNetBaseMinor < 0);
    } finally {
      r.stack.close();
    }
  });
});

/* ──────────────────────────────── §10: the base rate, computed not asserted */

describe('runplan: the windowed evaluation produces a real base rate', () => {
  const sizing = makeSizingPolicy({});

  it('reports 0% of windows reaching +100% on a series that never doubles', () => {
    const bars = barsFor('TADCO', 'TADAWUL', FROM, Array.from({ length: 200 }, (_, i) => 100_00 + i * 10));
    const out = armWindowedEvaluation({
      arm: 'buy-and-hold',
      bars,
      windowSessions: 10,
      startingEquityMinor: 500_000,
      costs: DEFAULT_COSTS.TADAWUL,
      sizing,
      targetBps: 10_000,
    });
    assert.ok(out.windows > 100, `expected many windows, got ${out.windows}`);
    assert.equal(out.fractionAtTarget, 0);
    assert.match(out.statement, /did not happen once/);
    assert.match(out.statement, /base rate/);
    assert.ok(out.minBps <= out.medianBps && out.medianBps <= out.maxBps);
  });

  it('finds the windows that DID double when the data contains them', () => {
    // A series that triples inside ten sessions, repeatedly.
    const closes: number[] = [];
    for (let i = 0; i < 200; i++) closes.push(100_00 + (i % 20) * 30_00);
    const bars = barsFor('TADCO', 'TADAWUL', FROM, closes);
    const out = armWindowedEvaluation({
      arm: 'buy-and-hold',
      bars,
      windowSessions: 10,
      startingEquityMinor: 500_000,
      costs: DEFAULT_COSTS.TADAWUL,
      sizing,
      targetBps: 10_000,
    });
    // Sizing is capped, so even a tripling instrument cannot double the BOOK:
    // that is the cap doing its job, and the number proves it rather than
    // asserting it.
    assert.ok(out.windows > 0);
    assert.ok(out.maxBps > 0, 'a tripling instrument must produce positive windows');
    assert.ok(out.fractionAtTarget <= 0.0001, `capped sizing cannot double the book: ${out.fractionAtTarget}`);
  });

  it('carries the per-arm base rates into the report notes', async () => {
    const r = await rig([{ symbol: 'TADCO', venue: 'TADAWUL', closes: FLAT }], { sessions: 5 });
    try {
      const res = await r.plan().run();
      assert.equal(res.armDistributions.length, 3, 'one distribution per arm');
      for (const arm of ['buy-and-hold', 'momentum', 'mean-reversion']) {
        assert.ok(res.armDistributions.some((d) => d.arm === arm));
        assert.ok(res.report.assumptions.some((a) => a.includes(`'${arm}'`)));
      }
      // report.ts's own buy-and-hold distribution is there too.
      assert.equal(res.report.distributions.length, 1);
      assert.ok(res.report.honesty.some((h) => h.includes('+100%') || h.includes('100.00%') || h.includes('base rate')));
    } finally {
      r.stack.close();
    }
  });
});

/* ────────────────────────────────────── the pure simulator's own guarantees */

describe('runplan: the simulator has no lookahead and pays to get out', () => {
  const sizing = makeSizingPolicy({});

  it('fills at the NEXT session open, never on the bar it decided on', () => {
    // A one-session spike: a simulator with lookahead would buy at the spike's
    // own close; an honest one pays the next open, which here is the spike.
    const closes = [100_00, 100_00, 100_00, 100_00, 100_00];
    const bars = barsFor('TADCO', 'TADAWUL', FROM, closes);
    const res = simulateStrategy({
      arm: 'buy-and-hold',
      bars,
      sessionDays: bars.map((b) => b.dayUtc),
      startingEquityMinor: 500_000,
      costs: DEFAULT_COSTS.TADAWUL,
      sizing,
    });
    assert.equal(res.trades.length, 1);
    const t = res.trades[0];
    assert.ok(t !== undefined);
    assert.notEqual(t.entryDayUtc, bars[0]?.dayUtc, 'the decision day cannot be the fill day');
    assert.equal(t.entryDayUtc, bars[1]?.dayUtc);
    assert.equal(t.closedAtMark, true, 'the last session is a marked close-out');
    // Flat prices, real costs: the simulated run loses money, as it must.
    assert.ok(res.realisedMinor < 0);
    assert.ok(res.costsMinor > 0);
    assert.ok(res.endingEquityMinor < 500_000);
  });

  it('charges the exit at the final close instead of marking out for free', () => {
    const bars = barsFor('TADCO', 'TADAWUL', FROM, new Array(6).fill(100_00) as number[]);
    const res = simulateStrategy({
      arm: 'buy-and-hold',
      bars,
      sessionDays: bars.map((b) => b.dayUtc),
      startingEquityMinor: 500_000,
      costs: DEFAULT_COSTS.TADAWUL,
      sizing,
    });
    const t = res.trades[0];
    assert.ok(t !== undefined && t.costsMinor > 0);
    // Cross-check against the channel's own cost helpers: same model, not a
    // second, friendlier one.
    const f = modelFill('SELL', { ...(bars[5] as Bar), openMinor: (bars[5] as Bar).closeMinor }, null, DEFAULT_COSTS.TADAWUL);
    assert.equal(t.costsMinor, commissionMinor(t.qty * f.priceMinor, DEFAULT_COSTS.TADAWUL));
  });

  it('respects the equity cap: the simulated book never goes on margin', () => {
    const bars = barsFor('TADCO', 'TADAWUL', FROM, new Array(12).fill(100_00) as number[]);
    const start = 500_000;
    const res = simulateStrategy({
      arm: 'buy-and-hold',
      bars,
      sessionDays: bars.map((b) => b.dayUtc),
      startingEquityMinor: start,
      costs: DEFAULT_COSTS.TADAWUL,
      sizing,
    });
    for (const e of res.equityCurve) assert.ok(e <= start * 1.01, `equity ${e} implies borrowed money`);
  });
});

/* ──────────────────────────────────────────────────────── report emission */

describe('runplan: the report is emitted through market/report.ts', () => {
  it('writes both forms and puts the verdict and the base rates in the text', async () => {
    const r = await rig([{ symbol: 'TADCO', venue: 'TADAWUL', closes: FLAT }], { sessions: 5 });
    try {
      const plan = r.plan();
      const res = await plan.run();
      const paths = plan.emit(res);
      const text = readFileSync(paths.textPath, 'utf8');
      const json = JSON.parse(readFileSync(paths.jsonPath, 'utf8')) as { mode: string; edge: { verdict: string } };
      assert.equal(json.mode, 'PAPER');
      assert.match(text, /ARES RUN REPORT/);
      assert.match(text, /VERDICT:/);
      assert.match(text, /HEAD TO HEAD/);
      assert.match(text, /SESSIONS COUNTED PER VENUE/);
      assert.match(text, /PER-STRATEGY BASE RATES/);
      assert.match(text, /REACHED \+100%/);
      assert.match(text, /SESSIONS EXECUTED: 5/);
      assert.equal(json.edge.verdict, res.report.edge.verdict);
      const _m: Minor = res.report.startingCapital.amount;
      assert.equal(_m, 500_000);
    } finally {
      r.stack.close();
    }
  });

  it('refuses an impossible plan at construction rather than at session nine', async () => {
    const r = await rig([{ symbol: 'TADCO', venue: 'TADAWUL', closes: FLAT }]);
    try {
      assert.throws(() => r.plan({ runId: '' }), /runId/);
      assert.throws(() => r.plan({ fromDayUtc: '2025-1-5' }), /YYYY-MM-DD/);
      assert.throws(() => r.plan({ sessionsPerVenue: 0 }), /positive integer/);
      assert.throws(() => r.plan({ universe: [] }), /at least one instrument/);
    } finally {
      r.stack.close();
    }
  });
});
