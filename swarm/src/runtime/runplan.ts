/**
 * runtime/runplan.ts — the dated run controller for the paper-trading run.
 *
 * It exists because a forward run over two venues is NOT a wall-clock loop. The
 * US trades Mon-Fri and Tadawul trades Sun-Thu, so "10 working days" is TWO
 * DIFFERENT calendars that only partly overlap. This controller counts sessions
 * PER VENUE, walks the union of their session days in date order, and the report
 * states both counts and both date ranges rather than pretending they align.
 *
 * ── RESUMABLE BY DESIGN ──────────────────────────────────────────────────────
 * The operator runs this on their own machine over two calendar weeks and the
 * container may restart. Nothing here keeps run state in process memory alone:
 * the plan is deterministic from (fromDay, toDay, sessionsPerVenue, universe),
 * progress is written to the shared MemoryStore after EVERY session, and the
 * ledger's idempotency keys make a replayed session a no-op rather than a double
 * booking. A restarted run CONTINUES; it does not restart. A resume against a
 * DIFFERENT plan is refused outright, because silently continuing someone else's
 * run would corrupt both.
 *
 * ── THE REPORT IS NOT MINE ───────────────────────────────────────────────────
 * §9 (the mandatory benchmark) and §10 (the distribution) are computed and
 * rendered by src/market/report.ts. This file feeds it: the swarm's REALISED
 * trades, the equity curve, the per-venue session lists and the notes. What this
 * file adds on top is a windowed evaluation that runs the OTHER strategy arms —
 * report.ts's own distribution is buy-and-hold only, and "what is the base rate
 * for momentum doubling in 10 sessions" is a different question from "what is
 * the base rate for the index doubling in 10 sessions". Both end up in the
 * report: the first as extra distributions and notes, the second as the
 * benchmark's own.
 *
 * ── WHAT THIS FILE DOES NOT DO ───────────────────────────────────────────────
 * It never places a real order and never opens a socket. It drives the agent,
 * which drives an injected executor, which models fills locally against the real
 * bar. There is no code path from here to a write verb.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AresError } from '../core/errors.js';
import type { AresConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import { fmt, money, type Currency, type Minor, type Money } from '../core/money.js';
import type { MemoryStore } from '../memory/store.js';
import {
  DEFAULT_STRATEGY_PARAMS,
  STRATEGY_RATIONALE,
  TRADER_ARMS,
  instrumentKey,
  makeSizingPolicy,
  sizePosition,
  strategySignal,
  warmupBars,
  type SizingPolicy,
  type StrategyArm,
  type StrategyParams,
  type TraderAgent,
} from '../agents/trader.js';
import { VENUE_CURRENCY, type Bar, type PriceFeed, type Venue } from '../market/feed.js';
import type { SessionCalendar } from '../market/calendar.js';
import {
  DEFAULT_COSTS,
  commissionMinor,
  modelFill,
  toCurrency,
  type EquityTrade,
  type VenueCostModel,
} from '../channels/equities.js';
import {
  assertUnleveragedReturnBps,
  buildRunReport,
  computeBuyAndHold,
  computeSwarmMetrics,
  renderReport,
  reportToJson,
  summariseVenue,
  windowDistribution,
  type InstrumentRef,
  type RunReport,
  type VenueSessionSummary,
  type WindowDistribution,
} from '../market/report.js';

/* ──────────────────────────────────────────── the pure simulation core */

/**
 * The deterministic, side-effect-free simulator behind the per-arm windowed
 * evaluation. It is NOT the live path — the live path is the agent plus the
 * executor, with the ledger, budget and policy in it — but it runs the SAME
 * strategy functions and the SAME sizing function as the agent, and prices
 * fills through the SAME modelFill/commissionMinor the equities channel uses.
 * A number produced here is therefore comparable with the live run rather than
 * being a second, friendlier universe.
 *
 * NO SAME-BAR LOOKAHEAD: a decision taken on bar i can only fill at bar i+1's
 * open, exactly as in the live path. The final session is closed out at that
 * session's CLOSE with full exit costs charged; that is a MARK, not a fill, and
 * it is the same convention report.ts uses for the benchmark, so the two are
 * measured the same way.
 */
export interface SimTrade {
  entryDayUtc: string;
  exitDayUtc: string;
  qty: number;
  basisMinor: Minor;
  proceedsMinor: Minor;
  costsMinor: Minor;
  realisedMinor: Minor;
  closedAtMark: boolean;
}

export interface SimResult {
  arm: StrategyArm;
  symbol: string;
  days: string[];
  /** Cash (settled + unsettled) plus the marked position, per session. */
  equityCurve: Minor[];
  trades: SimTrade[];
  realisedMinor: Minor;
  costsMinor: Minor;
  startingEquityMinor: Minor;
  endingEquityMinor: Minor;
  returnBps: number;
}

export interface SimOptions {
  arm: StrategyArm;
  /** Full history, ascending by day. Bars before the first session are warmup. */
  bars: readonly Bar[];
  /** The sessions actually traded; days must exist in `bars`. */
  sessionDays: readonly string[];
  startingEquityMinor: Minor;
  costs: VenueCostModel;
  sizing: SizingPolicy;
  params?: StrategyParams;
  /** Mirrors cfg.budget.perTradeCapMinor so sizing matches the live path. */
  perTradeCapMinor?: Minor;
}

export function simulateStrategy(opts: SimOptions): SimResult {
  const params = opts.params ?? DEFAULT_STRATEGY_PARAMS;
  const bars = opts.bars;
  const byDay = new Map<string, number>();
  for (let i = 0; i < bars.length; i++) byDay.set((bars[i] as Bar).dayUtc, i);

  let settledCash = Math.max(0, Math.trunc(opts.startingEquityMinor));
  let unsettled: Array<{ dueIdx: number; amount: Minor }> = [];
  let qty = 0;
  let basis = 0;
  let entryDay = '';
  let costs = 0;
  let realised = 0;
  const trades: SimTrade[] = [];
  const equityCurve: Minor[] = [];
  const days: string[] = [];
  let pending: { side: 'BUY' | 'SELL'; qty: number } | null = null;

  for (let s = 0; s < opts.sessionDays.length; s++) {
    const day = opts.sessionDays[s] as string;
    const idx = byDay.get(day);
    if (idx === undefined) continue; // no bar: the venue was shut, nothing happens
    const bar = bars[idx] as Bar;
    days.push(day);

    // 1. SETTLEMENT — cash from earlier sales becomes spendable.
    const due = unsettled.filter((u) => u.dueIdx <= s);
    unsettled = unsettled.filter((u) => u.dueIdx > s);
    for (const u of due) settledCash += u.amount;

    // 2. THE PENDING ORDER FILLS AT THIS SESSION'S OPEN, never at the close it
    //    was decided on.
    if (pending !== null) {
      if (pending.side === 'BUY') {
        const f = modelFill('BUY', bar, null, opts.costs);
        const gross = pending.qty * f.priceMinor;
        const fee = commissionMinor(gross, opts.costs);
        if (f.filled && gross + fee <= settledCash) {
          settledCash -= gross + fee;
          qty += pending.qty;
          basis += gross + fee;
          costs += fee + f.implicitCostMinor * pending.qty;
          entryDay = day;
        }
      } else {
        const sellQty = Math.min(pending.qty, qty);
        const f = modelFill('SELL', bar, null, opts.costs);
        if (sellQty > 0 && f.filled) {
          const gross = sellQty * f.priceMinor;
          const fee = commissionMinor(gross, opts.costs);
          const proceeds = gross - fee;
          const relieved = sellQty === qty ? basis : Math.floor((basis * sellQty) / qty);
          costs += fee + f.implicitCostMinor * sellQty;
          realised += proceeds - relieved;
          trades.push({
            entryDayUtc: entryDay,
            exitDayUtc: day,
            qty: sellQty,
            basisMinor: relieved,
            proceedsMinor: proceeds,
            costsMinor: fee,
            realisedMinor: proceeds - relieved,
            closedAtMark: false,
          });
          qty -= sellQty;
          basis -= relieved;
          unsettled.push({ dueIdx: s + Math.max(0, opts.costs.settlementSessions), amount: proceeds });
        }
      }
      pending = null;
    }

    // 3. DECIDE on this session's close.
    const closes: Minor[] = [];
    for (let i = 0; i <= idx; i++) closes.push((bars[i] as Bar).closeMinor);
    const last = s === opts.sessionDays.length - 1;
    const sig = strategySignal(opts.arm, closes, qty > 0, params);

    if (last && qty > 0) {
      // 4. FINAL SESSION: liquidate at this session's CLOSE with the full exit
      //    cost charged, so the run ends in a realised number rather than an
      //    open position and a story about what it might have been worth.
      const f = modelFill('SELL', { ...bar, openMinor: bar.closeMinor }, null, opts.costs);
      const gross = qty * f.priceMinor;
      const fee = commissionMinor(gross, opts.costs);
      const proceeds = gross - fee;
      costs += fee + f.implicitCostMinor * qty;
      realised += proceeds - basis;
      trades.push({
        entryDayUtc: entryDay,
        exitDayUtc: day,
        qty,
        basisMinor: basis,
        proceedsMinor: proceeds,
        costsMinor: fee,
        realisedMinor: proceeds - basis,
        closedAtMark: true,
      });
      settledCash += proceeds;
      qty = 0;
      basis = 0;
    } else if (!last) {
      if (sig.action === 'ENTER' && qty === 0) {
        const equity = settledCash + unsettledTotal(unsettled);
        const d = sizePosition(
          {
            equityMinor: equity,
            exposureMinor: 0,
            cashAvailableMinor: settledCash,
            unitPriceMinor: bar.closeMinor,
            perTradeCapMinor: opts.perTradeCapMinor ?? 0,
          },
          opts.sizing,
        );
        const lot = Math.max(1, opts.costs.lotSize);
        const lots = Math.floor(d.qty / lot) * lot;
        if (!d.refused && lots > 0) pending = { side: 'BUY', qty: lots };
      } else if (sig.action === 'EXIT' && qty > 0) {
        pending = { side: 'SELL', qty };
      }
    }

    equityCurve.push(settledCash + unsettledTotal(unsettled) + qty * bar.closeMinor);
  }

  const starting = Math.max(1, Math.trunc(opts.startingEquityMinor));
  const ending = equityCurve.length > 0 ? (equityCurve[equityCurve.length - 1] as Minor) : starting;
  return {
    arm: opts.arm,
    symbol: bars.length > 0 ? (bars[0] as Bar).symbol : '',
    days,
    equityCurve,
    trades,
    realisedMinor: realised,
    costsMinor: costs,
    startingEquityMinor: opts.startingEquityMinor,
    endingEquityMinor: ending,
    returnBps: Math.round(((ending - starting) / starting) * 10_000),
  };
}

function unsettledTotal(u: Array<{ dueIdx: number; amount: Minor }>): Minor {
  let s = 0;
  for (const x of u) s += x.amount;
  return s;
}

/* ──────────────── per-arm windowed evaluation (MARKET_SPEC §10, extended) */

export interface ArmWindowedOptions {
  arm: StrategyArm;
  bars: readonly Bar[];
  /** Sessions per window. 10 answers the question the operator actually asked. */
  windowSessions: number;
  startingEquityMinor: Minor;
  costs: VenueCostModel;
  sizing: SizingPolicy;
  params?: StrategyParams;
  /** Sessions between window starts. 1 = every possible window. */
  step?: number;
  perTradeCapMinor?: Minor;
  /** The operator's target, in bps. 10,000 = +100% = "double it". */
  targetBps?: number;
}

export interface ArmWindowedResult extends WindowDistribution {
  arm: StrategyArm;
  /** The base rate, in words, so it cannot be skimmed past as a number. */
  statement: string;
}

function percentileOf(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

/**
 * Run the SAME strategy across every historical window of `windowSessions` and
 * report the distribution of outcomes. This is the antidote to reading one
 * 10-session result as evidence: it shows the spread the same rule produces on
 * the same data, and states what fraction of those windows reached the target.
 *
 * report.ts::windowDistribution answers this for buy-and-hold. This answers it
 * for whichever arm the swarm was actually trading, which is the number the
 * operator needs when the swarm was not buying and holding.
 *
 * SIZE BASIS. Unlike the old buy-and-hold distribution, this function never had a
 * one-share basis to fix: every window runs simulateStrategy against a real book
 * of `startingEquityMinor` and sizes each entry through the SAME sizePosition the
 * live agent uses, so the minimum commission is already a percentage of a real
 * position rather than the whole result. The return is (ending equity - starting
 * equity) / starting equity, which is bounded below by -100% by construction —
 * cash never goes negative and a long position is never worth less than zero. The
 * bound is asserted anyway: it is cheap, and an impossible number that is merely
 * unlikely to appear is still a number nobody would catch.
 */
export function armWindowedEvaluation(opts: ArmWindowedOptions): ArmWindowedResult {
  const n = Math.max(2, Math.trunc(opts.windowSessions));
  const step = Math.max(1, Math.trunc(opts.step ?? 1));
  const target = opts.targetBps ?? 10_000;
  const warm = warmupBars(opts.arm, opts.params ?? DEFAULT_STRATEGY_PARAMS);
  const bars = opts.bars;
  const returnsBps: number[] = [];
  for (let start = warm; start + n <= bars.length; start += step) {
    const sessionDays = bars.slice(start, start + n).map((b) => b.dayUtc);
    const sim = simulateStrategy({
      arm: opts.arm,
      bars,
      sessionDays,
      startingEquityMinor: opts.startingEquityMinor,
      costs: opts.costs,
      sizing: opts.sizing,
      ...(opts.params !== undefined ? { params: opts.params } : {}),
      ...(opts.perTradeCapMinor !== undefined ? { perTradeCapMinor: opts.perTradeCapMinor } : {}),
    });
    returnsBps.push(
      assertUnleveragedReturnBps(sim.returnBps, {
        arm: opts.arm,
        symbol: sim.symbol,
        windowSessions: n,
        firstDay: sessionDays[0],
        lastDay: sessionDays[sessionDays.length - 1],
        notionalMinor: opts.startingEquityMinor,
        endingEquityMinor: sim.endingEquityMinor,
      }),
    );
  }
  const sorted = [...returnsBps].sort((a, b) => a - b);
  const windows = returnsBps.length;
  const atTarget = returnsBps.filter((r) => r >= target).length;
  const positive = returnsBps.filter((r) => r > 0).length;
  const meanBps = windows === 0 ? 0 : Math.round(returnsBps.reduce((a, b) => a + b, 0) / windows);
  const fractionAtTarget = windows === 0 ? 0 : atTarget / windows;
  const first = bars[0];
  const statement =
    windows === 0
      ? `'${opts.arm}' could not be evaluated over any ${n}-session window: there is not enough history. ` +
        `No base rate can be quoted, and the absence of a number is not a small number.`
      : `'${opts.arm}' on ${first?.symbol ?? '?'}: across ${windows} historical ${n}-session window(s) it returned ` +
        `between ${(sorted[0] as number) / 100}% and ${(sorted[sorted.length - 1] as number) / 100}% ` +
        `(median ${percentileOf(sorted, 0.5) / 100}%, mean ${meanBps / 100}%). ` +
        `${atTarget} of ${windows} windows (${(fractionAtTarget * 100).toFixed(2)}%) reached ${(target / 100).toFixed(0)}%. ` +
        `That percentage IS the base rate for "double the money in ${n} working days" with this strategy on this ` +
        `data — it is what the history says, not what anyone hopes.` +
        `${atTarget === 0 ? ' It did not happen once.' : ''}`;
  return {
    arm: opts.arm,
    symbol: first?.symbol ?? '',
    venue: first?.venue ?? 'US',
    windowSessions: n,
    windows,
    returnsBps,
    notionalMinor: opts.startingEquityMinor,
    skippedWindows: 0,
    basis:
      `book of ${fmt(money(opts.startingEquityMinor, VENUE_CURRENCY[first?.venue ?? 'US'] as Currency))} per window, each entry ` +
      `sized by the live sizing policy (risk, position, exposure, cash and per-trade caps), lot size ` +
      `${Math.max(1, Math.trunc(opts.costs.lotSize))}, commission charged both sides on the real quantity and ` +
      `floored at the venue minimum, half-spread and slippage inside every fill`,
    minBps: windows === 0 ? 0 : (sorted[0] as number),
    p10Bps: percentileOf(sorted, 0.1),
    medianBps: percentileOf(sorted, 0.5),
    p90Bps: percentileOf(sorted, 0.9),
    maxBps: windows === 0 ? 0 : (sorted[sorted.length - 1] as number),
    meanBps,
    fractionPositive: windows === 0 ? 0 : positive / windows,
    fractionAtTarget,
    targetBps: target,
    statement,
  };
}

/* ───────────────────────────────────────────────────────── the run controller */

export interface RunStep {
  index: number;
  dayUtc: string;
  venue: Venue;
  finalSessionForVenue: boolean;
}

export interface RunProgress {
  runId: string;
  fingerprint: string;
  cursor: number;
  totalSteps: number;
  perVenue: Record<string, number>;
  lastDayUtc: string | null;
  startedAtMs: number;
  updatedAtMs: number;
}

export interface RunPlanOptions {
  runId: string;
  cfg: AresConfig;
  logger: Logger;
  /** The SHARED task memory: run progress belongs to the swarm, not an agent. */
  taskMemory: MemoryStore;
  calendar: SessionCalendar;
  feed: PriceFeed;
  trader: TraderAgent;
  universe: readonly InstrumentRef[];
  fromDayUtc: string;
  toDayUtc: string;
  /** "10 working days" — counted PER VENUE, because the calendars differ. */
  sessionsPerVenue: number;
  startingCapitalMinor: Minor;
  costs?: Partial<Record<Venue, VenueCostModel>>;
  sizing?: SizingPolicy;
  params?: StrategyParams;
  sarPerUsd?: number;
  /** Per-arm windowed evaluation. Disable only with a stated reason. */
  windowed?: { windowSessions?: number; step?: number; arms?: readonly StrategyArm[]; targetBps?: number } | false;
  /** Where the report files are written. Defaults to `${dataDir}/reports`. */
  reportDir?: string;
}

export interface RunPlanResult {
  report: RunReport;
  /** The per-arm distributions, kept whole for the dashboard and for tests. */
  armDistributions: ArmWindowedResult[];
  steps: RunStep[];
  resumed: boolean;
  sessionsExecuted: number;
}

const PROGRESS_PREFIX = 'runplan.progress:';

export class RunPlan {
  private readonly o: RunPlanOptions;
  private readonly sizing: SizingPolicy;
  private readonly params: StrategyParams;
  private readonly sarPerUsd: number;
  private readonly log: Logger;
  private steps: RunStep[] = [];
  private equityByDay: Array<{ dayUtc: string; equityMinor: Minor }> = [];
  private resumedFlag = false;
  private executed = 0;
  private startedAtMs = Date.now();

  constructor(opts: RunPlanOptions) {
    if (!opts || typeof opts.runId !== 'string' || opts.runId.length === 0) {
      throw new AresError('RUNPLAN_BAD_ID', 'RunPlan: a non-empty runId is required (it keys the resume record)', {});
    }
    for (const d of [opts.fromDayUtc, opts.toDayUtc]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
        throw new AresError('RUNPLAN_BAD_DAY', `RunPlan: days must be YYYY-MM-DD, got ${String(d)}`, { day: d });
      }
    }
    if (!Number.isSafeInteger(opts.sessionsPerVenue) || opts.sessionsPerVenue <= 0) {
      throw new AresError('RUNPLAN_BAD_SESSIONS', 'RunPlan: sessionsPerVenue must be a positive integer', {
        sessionsPerVenue: opts.sessionsPerVenue,
      });
    }
    if (!Array.isArray(opts.universe) || opts.universe.length === 0) {
      throw new AresError('RUNPLAN_NO_UNIVERSE', 'RunPlan: at least one instrument is required', {});
    }
    this.o = opts;
    this.sizing = opts.sizing ?? opts.trader.sizing ?? makeSizingPolicy({});
    this.params = opts.params ?? opts.trader.params ?? DEFAULT_STRATEGY_PARAMS;
    this.sarPerUsd = opts.sarPerUsd ?? opts.cfg.market.fx.sarPerUsd;
    this.log = opts.logger.child({ mod: 'runplan', runId: opts.runId });
  }

  /** The venues present in the universe, in a stable order. */
  venues(): Venue[] {
    return [...new Set(this.o.universe.map((i) => i.venue))].sort();
  }

  /** The session days actually traded, per venue. The report quotes these. */
  sessionsByVenue(): Partial<Record<Venue, string[]>> {
    const out: Partial<Record<Venue, string[]>> = {};
    for (const v of this.venues()) {
      out[v] = this.o.calendar.sessionsBetween(v, this.o.fromDayUtc, this.o.toDayUtc).slice(0, this.o.sessionsPerVenue);
    }
    return out;
  }

  /**
   * The plan: for each venue, the first `sessionsPerVenue` sessions in range;
   * then every (day, venue) pair in date order. Deterministic — the same inputs
   * always produce the same plan, which is what makes resume safe.
   */
  buildPlan(): RunStep[] {
    const perVenue = this.sessionsByVenue();
    const rows: RunStep[] = [];
    for (const venue of this.venues()) {
      const days = perVenue[venue] ?? [];
      days.forEach((dayUtc, i) => {
        rows.push({ index: 0, dayUtc, venue, finalSessionForVenue: i === days.length - 1 });
      });
    }
    rows.sort((a, b) => (a.dayUtc === b.dayUtc ? a.venue.localeCompare(b.venue) : a.dayUtc.localeCompare(b.dayUtc)));
    rows.forEach((r, i) => {
      r.index = i;
    });
    this.steps = rows;
    return rows;
  }

  /**
   * Identity of the plan. A resume record whose fingerprint differs describes a
   * DIFFERENT run; continuing into it would interleave two runs' bookkeeping.
   */
  fingerprint(): string {
    const u = [...this.o.universe].map(instrumentKey).sort().join(',');
    return `${this.o.fromDayUtc}|${this.o.toDayUtc}|${this.o.sessionsPerVenue}|${u}`;
  }

  private progressKey(): string {
    return `${PROGRESS_PREFIX}${this.o.runId}`;
  }

  /** The persisted progress for this runId, or null if this is a fresh run. */
  progress(): RunProgress | null {
    const p = this.o.taskMemory.getFact<RunProgress | null>(this.progressKey(), null);
    return p !== null && typeof p === 'object' && typeof p.cursor === 'number' ? p : null;
  }

  private saveProgress(p: RunProgress): void {
    this.o.taskMemory.setFact(this.progressKey(), p);
    this.o.taskMemory.setFact(`${this.progressKey()}:equity`, this.equityByDay);
    this.o.taskMemory.flush();
  }

  /**
   * Execute the plan, continuing from persisted progress when there is any.
   * Safe to call again after a crash: already-completed sessions are skipped,
   * and the ledger would deduplicate their entries even if they were not.
   */
  async run(): Promise<RunPlanResult> {
    const steps = this.buildPlan();
    const fp = this.fingerprint();
    const prior = this.progress();
    let cursor = 0;
    const perVenue: Record<string, number> = {};
    if (prior !== null) {
      if (prior.fingerprint !== fp) {
        throw new AresError(
          'RUNPLAN_FINGERPRINT_MISMATCH',
          `RunPlan: run ${this.o.runId} was started over a DIFFERENT plan (${prior.fingerprint}) than the one now ` +
            `requested (${fp}). Resuming would interleave two runs' bookkeeping, so it is refused. Use a new runId ` +
            `for a new plan, or restore the original parameters to continue this one.`,
          { runId: this.o.runId, stored: prior.fingerprint, requested: fp },
        );
      }
      cursor = Math.max(0, Math.min(prior.cursor, steps.length));
      this.startedAtMs = prior.startedAtMs;
      this.resumedFlag = cursor > 0;
      for (const [k, v] of Object.entries(prior.perVenue ?? {})) perVenue[k] = v;
      const savedEquity = this.o.taskMemory.getFact<Array<{ dayUtc: string; equityMinor: Minor }>>(`${this.progressKey()}:equity`, []);
      if (Array.isArray(savedEquity)) this.equityByDay = savedEquity.filter((e) => e && typeof e.dayUtc === 'string');
      if (this.resumedFlag) {
        this.log.warn('runplan.resumed', {
          cursor,
          totalSteps: steps.length,
          lastDayUtc: prior.lastDayUtc,
          note: 'sessions already completed are skipped; the ledger would deduplicate them regardless',
        });
      }
    }

    for (let i = cursor; i < steps.length; i++) {
      const step = steps[i] as RunStep;
      this.o.trader.setSession({
        venue: step.venue,
        dayUtc: step.dayUtc,
        tick: step.index,
        finalSession: step.finalSessionForVenue,
      });
      await this.o.trader.runTick(step.index);
      this.executed++;
      perVenue[step.venue] = (perVenue[step.venue] ?? 0) + 1;
      const equityMinor = this.o.trader.equityMinor() + this.o.trader.unsettledCashMinor();
      const existing = this.equityByDay.find((e) => e.dayUtc === step.dayUtc);
      if (existing === undefined) this.equityByDay.push({ dayUtc: step.dayUtc, equityMinor });
      else existing.equityMinor = equityMinor;
      this.saveProgress({
        runId: this.o.runId,
        fingerprint: fp,
        cursor: i + 1,
        totalSteps: steps.length,
        perVenue,
        lastDayUtc: step.dayUtc,
        startedAtMs: this.startedAtMs,
        updatedAtMs: Date.now(),
      });
    }

    return this.buildReport(steps);
  }

  /** Sessions already completed, per venue. Reported, and used by resume. */
  sessionsCompleted(): Record<string, number> {
    return { ...(this.progress()?.perVenue ?? {}) };
  }

  /**
   * The swarm's fills as report.ts wants them. Each settled round trip becomes
   * TWO rows — the entry and the exit — because the entry's costs were paid
   * whether or not the trade worked, and a cost total that omits them would
   * flatter the swarm against a benchmark whose entry costs ARE counted.
   */
  swarmTrades(): EquityTrade[] {
    const out: EquityTrade[] = [];
    const base = this.o.cfg.baseCurrency;
    for (const t of this.o.trader.closedRoundTrips()) {
      const unitBasis = t.qty > 0 ? Math.floor((t.basisMinor - t.entryCostsMinor) / t.qty) : 0;
      const unitProceeds = t.qty > 0 ? Math.floor((t.proceedsMinor + t.costsMinor) / t.qty) : 0;
      out.push({
        symbol: t.symbol,
        venue: t.venue,
        side: 'BUY',
        qty: t.qty,
        priceMinor: unitBasis,
        // The executor reports one explicit cost figure per side; it is booked
        // as commission here and the implicit split is reported as zero rather
        // than invented. The TOTAL is right, the breakdown is not guessed.
        commissionMinor: t.entryCostsMinor,
        implicitCostMinor: 0,
        decisionDay: t.entryDayUtc,
        fillDay: t.entryDayUtc,
        decisionTick: 0,
        fillTick: 0,
        settleTick: t.settlementTick,
        settleDay: t.entryDayUtc,
        currency: base,
        realisedMinor: null,
      });
      out.push({
        symbol: t.symbol,
        venue: t.venue,
        side: 'SELL',
        qty: t.qty,
        priceMinor: unitProceeds,
        commissionMinor: t.costsMinor,
        implicitCostMinor: 0,
        decisionDay: t.soldDayUtc,
        fillDay: t.soldDayUtc,
        decisionTick: 0,
        fillTick: 0,
        settleTick: t.settlementTick,
        settleDay: t.settledDayUtc,
        currency: base,
        realisedMinor: t.realisedMinor,
      });
    }
    return out;
  }

  /** The equity curve the run actually walked, one point per session executed. */
  equityCurve(): Minor[] {
    const sorted = [...this.equityByDay].sort((a, b) => a.dayUtc.localeCompare(b.dayUtc));
    return [this.o.startingCapitalMinor, ...sorted.map((e) => e.equityMinor)];
  }

  private costsFor(venue: Venue): VenueCostModel {
    return this.o.costs?.[venue] ?? this.o.cfg.market.costs[venue] ?? DEFAULT_COSTS[venue];
  }

  private async buildReport(steps: readonly RunStep[]): Promise<RunPlanResult> {
    const startingCapital: Money = money(this.o.startingCapitalMinor, this.o.cfg.baseCurrency);
    const byVenue = this.sessionsByVenue();

    // ---- the swarm's own numbers, from REALISED round trips only ----
    const swarm = computeSwarmMetrics({
      trades: this.swarmTrades(),
      startingCapital,
      sarPerUsd: this.sarPerUsd,
      equityCurveBaseMinor: this.equityCurve(),
    });

    // ---- the benchmark: buy-and-hold, SAME everything (MARKET_SPEC §9) ----
    const benchmark = await computeBuyAndHold({
      feed: this.o.feed,
      instruments: this.o.universe,
      sessionsByVenue: byVenue,
      startingCapital,
      costs: Object.fromEntries(this.venues().map((v) => [v, this.costsFor(v)])) as Partial<Record<Venue, VenueCostModel>>,
      sarPerUsd: this.sarPerUsd,
    });

    // ---- the distributions (MARKET_SPEC §10) ----
    const windowCfg = this.o.windowed === false ? null : (this.o.windowed ?? {});
    const distributions: WindowDistribution[] = [];
    const armDistributions: ArmWindowedResult[] = [];
    if (windowCfg !== null) {
      const n = windowCfg.windowSessions ?? this.o.sessionsPerVenue;
      const target = windowCfg.targetBps ?? 10_000;
      // The base rate is quoted PER POSITION SIZE, so the size it is quoted at is
      // the one this run actually deploys: the equal-weight per-instrument share
      // of starting capital, converted into the venue's own currency. Quoting it
      // on one share instead would let the fixed minimum commission swamp any
      // low-priced instrument and report a double as a loss.
      const perInstrumentBase = Math.max(
        1,
        Math.floor(this.o.startingCapitalMinor / Math.max(1, this.o.universe.length)),
      );
      for (const inst of this.o.universe) {
        const notionalMinor = Math.max(
          1,
          toCurrency(
            money(perInstrumentBase, this.o.cfg.baseCurrency),
            VENUE_CURRENCY[inst.venue],
            this.sarPerUsd,
          ).amount,
        );
        // report.ts's own distribution: buy-and-hold, the benchmark's base rate.
        distributions.push(
          await windowDistribution(this.o.feed, inst, Math.max(2, n), {
            targetBps: target,
            costs: this.costsFor(inst.venue),
            notionalMinor,
          }),
        );
        // And the same question asked of the arms the swarm actually traded.
        const bars = await this.historyFor(inst);
        for (const arm of windowCfg.arms ?? TRADER_ARMS) {
          armDistributions.push(
            armWindowedEvaluation({
              arm,
              bars,
              windowSessions: Math.max(2, n),
              startingEquityMinor: this.o.startingCapitalMinor,
              costs: this.costsFor(inst.venue),
              sizing: this.sizing,
              params: this.params,
              step: windowCfg.step ?? 1,
              perTradeCapMinor: this.o.cfg.budget.perTradeCapMinor,
              targetBps: target,
            }),
          );
        }
      }
    }

    const venues: VenueSessionSummary[] = this.venues().map((v) =>
      summariseVenue(this.o.calendar, v, byVenue[v] ?? []),
    );

    const report = buildRunReport({
      runId: this.o.runId,
      startedAt: this.startedAtMs,
      finishedAt: Date.now(),
      startingCapital,
      sarPerUsd: this.sarPerUsd,
      swarm,
      benchmark,
      venues,
      distributions,
      instruments: this.o.universe,
      costs: Object.fromEntries(this.venues().map((v) => [v, this.costsFor(v)])) as Partial<Record<Venue, VenueCostModel>>,
      notes: this.notes(steps, armDistributions),
    });
    return { report, armDistributions, steps: [...steps], resumed: this.resumedFlag, sessionsExecuted: this.executed };
  }

  /**
   * The things a reader must be told that the numbers alone do not say. They
   * ride in the report's `assumptions` block, which renderReport prints.
   */
  private notes(steps: readonly RunStep[], arms: readonly ArmWindowedResult[]): string[] {
    const perVenue = this.venues()
      .map((v) => `${v}=${steps.filter((s) => s.venue === v).length}`)
      .join(', ');
    return [
      `SESSION COUNTS ARE PER VENUE AND DO NOT ALIGN: ${perVenue}, against ${this.o.sessionsPerVenue} requested each. ` +
        `US sessions are Mon-Fri and Tadawul sessions are Sun-Thu, so "${this.o.sessionsPerVenue} working days" is two ` +
        `different calendar windows that overlap only on Mon-Thu. A count below the request means the range (or a ` +
        `configured holiday) ran out of sessions, not that a session was skipped.`,
      `SIZING CAPS: ${JSON.stringify(this.sizing)}. Total exposure can never exceed equity — no leverage, refused at ` +
        `construction rather than merely unused.`,
      `THE TARGET WAS UNREACHABLE BY DESIGN, NOT BY BAD LUCK. Doubling capital in ${this.o.sessionsPerVenue} sessions ` +
        `requires position sizes far above the Kelly-optimal fraction, where expected LOG growth turns negative — ` +
        `betting that large loses money on average even with a genuine edge. The caps above exist to keep this run on ` +
        `the right side of that line.`,
      ...arms.map((a) => a.statement),
      ...TRADER_ARMS.map((arm) => `STRATEGY '${arm}': ${STRATEGY_RATIONALE[arm]}`),
      `Strategy parameters as run: momentum ${JSON.stringify(this.params.momentum)}, ` +
        `mean-reversion ${JSON.stringify(this.params.meanReversion)}, buy-and-hold {} (nothing to overfit).`,
      `Bandit posterior at the end of the run: ${JSON.stringify(this.o.trader.learner.weights())}. The reward was ` +
        `REALISED P&L at settlement on every update — never an unrealised mark, never the signal that justified entry.`,
    ];
  }

  private async historyFor(inst: InstrumentRef): Promise<Bar[]> {
    const from = new Date(`${this.o.fromDayUtc}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 5 * 365);
    const bars = await this.o.feed.bars(inst.symbol, inst.venue, from.toISOString().slice(0, 10), this.o.toDayUtc);
    return [...bars].sort((a, b) => a.dayUtc.localeCompare(b.dayUtc));
  }

  /**
   * Render and write the report through src/market/report.ts. Both forms: the
   * JSON is what a later run diffs against, the text is what a human reads.
   */
  emit(result: RunPlanResult): { jsonPath: string; textPath: string } {
    const dir = this.o.reportDir ?? join(this.o.cfg.dataDir, 'reports');
    mkdirSync(dir, { recursive: true });
    const jsonPath = join(dir, `${result.report.runId}.json`);
    const textPath = join(dir, `${result.report.runId}.txt`);
    writeFileSync(jsonPath, reportToJson(result.report), 'utf8');
    writeFileSync(textPath, this.renderText(result), 'utf8');
    this.log.warn('runplan.report_written', { jsonPath, textPath });
    return { jsonPath, textPath };
  }

  /** report.ts's rendering, plus the per-arm base rates it does not compute. */
  renderText(result: RunPlanResult): string {
    const L = [renderReport(result.report)];
    if (result.armDistributions.length > 0) {
      L.push('');
      L.push('PER-STRATEGY BASE RATES (the same rule run over every historical window of this length)');
      for (const a of result.armDistributions) {
        L.push(
          `  ${a.arm.padEnd(15)} ${a.symbol.padEnd(8)} windows=${String(a.windows).padStart(5)}  ` +
            `median=${(a.medianBps / 100).toFixed(2)}%  p10=${(a.p10Bps / 100).toFixed(2)}%  ` +
            `p90=${(a.p90Bps / 100).toFixed(2)}%  positive=${(a.fractionPositive * 100).toFixed(1)}%  ` +
            `REACHED +${(a.targetBps / 100).toFixed(0)}%: ${(a.fractionAtTarget * 100).toFixed(2)}%`,
        );
      }
      // A base rate without its position size is not a base rate.
      L.push(`  SIZE BASIS: ${(result.armDistributions[0] as ArmWindowedResult).basis}.`);
    }
    L.push('');
    L.push(`SESSIONS EXECUTED: ${result.sessionsExecuted}${result.resumed ? ' (this run was RESUMED from persisted progress)' : ''}`);
    return L.join('\n');
  }
}
