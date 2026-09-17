/**
 * runtime/runplan.ts — the dated run controller for the paper-trading run, and
 * the honest report that comes out of it.
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
 * ── THE BENCHMARK IS THE POINT (MARKET_SPEC §9) ──────────────────────────────
 * Every run reports the swarm's realised P&L AND buy-and-hold on the same
 * instruments, the same sessions, the same starting capital and the SAME cost
 * model object — so "same costs" is true by construction, not by assertion.
 * A strategy that underperforms buy-and-hold has NO EDGE however much money it
 * made, and `verdict.text` says so in words.
 *
 * ── STATISTICAL HONESTY (MARKET_SPEC §10) ────────────────────────────────────
 * Ten observations cannot separate skill from luck. `windowedEvaluation()` runs
 * the same strategy over every historical window of the same length and reports
 * the DISTRIBUTION, including the fraction of windows that reached +100% — the
 * real base rate for the target the operator named. The number is computed from
 * the data, not asserted by anyone.
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
import type { Ledger } from '../core/ledger.js';
import type { Logger } from '../core/logger.js';
import type { Currency, Minor } from '../core/money.js';
import { fmt, money } from '../core/money.js';
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
  type Bar,
  type Instrument,
  type PriceFeed,
  type SizingPolicy,
  type StrategyArm,
  type StrategyParams,
  type TraderAgent,
  type Venue,
} from '../agents/trader.js';

/* ──────────────────────────────────────────────────────────── the calendar */

/**
 * MARKET_SPEC §5. Implemented by src/market/calendar.ts; injected here so the
 * controller and its tests never depend on that module being finished, and so
 * the holiday list stays configuration rather than hardcoded law.
 */
export interface SessionCalendar {
  isSession(venue: Venue, dayUtc: string): boolean;
  sessionsBetween(venue: Venue, fromDay: string, toDay: string): string[];
  nextSession(venue: Venue, dayUtc: string): string;
}

/* ─────────────────────────────────────────────────────────── the cost model */

/**
 * MARKET_SPEC §6, every parameter named and nothing buried. The SAME object is
 * used for the swarm's modelled fills and for the benchmark, which is what
 * makes the comparison fair.
 */
export interface CostModel {
  /** Commission per side, in basis points of notional. */
  commissionBps: number;
  /** Floor on the per-side commission, in minor units. */
  minCommissionMinor: Minor;
  /** Half the quoted bid-ask spread, in basis points. Paid on every side. */
  halfSpreadBps: number;
  /** Modelled market impact / adverse selection, in basis points. */
  slippageBps: number;
  /** Sessions before the cash from a sale is available. T+2 by default. */
  settlementDays: number;
}

export const DEFAULT_COST_MODEL: CostModel = Object.freeze({
  commissionBps: 15,
  minCommissionMinor: 100,
  halfSpreadBps: 5,
  slippageBps: 5,
  settlementDays: 2,
});

/** Total explicit cost of ONE side of a trade, in minor units. Always >= 0. */
export function tradeCostMinor(notionalMinor: Minor, m: CostModel): Minor {
  const n = Math.max(0, Math.trunc(notionalMinor));
  if (n === 0) return 0;
  const commission = Math.max(Math.ceil((n * Math.max(0, m.commissionBps)) / 10_000), Math.max(0, m.minCommissionMinor));
  const spread = Math.ceil((n * Math.max(0, m.halfSpreadBps)) / 10_000);
  const slip = Math.ceil((n * Math.max(0, m.slippageBps)) / 10_000);
  return commission + spread + slip;
}

/* ──────────────────────────────────────────── the pure simulation core */

/**
 * The deterministic, side-effect-free simulator behind the benchmark and the
 * windowed evaluation. It is NOT the live path — the live path is the agent
 * plus the executor, with the ledger, budget and policy in it — but it runs the
 * SAME strategy functions from agents/trader.ts and the SAME sizing function,
 * so a benchmark computed here and a run executed there are comparable.
 *
 * NO SAME-BAR LOOKAHEAD: a decision taken on bar i can only fill at bar i+1's
 * open, exactly as in the live path. The final session is closed out at that
 * session's CLOSE with exit costs applied; that is a MARK, not a fill, and the
 * report labels it as such.
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
  /** Total equity (settled cash + unsettled cash + marked position) per day. */
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
  /** The sessions actually traded; must be a contiguous tail-slice of `bars`. */
  sessionDays: readonly string[];
  startingEquityMinor: Minor;
  cost: CostModel;
  sizing: SizingPolicy;
  params?: StrategyParams;
  /**
   * Multiplier from the bar's currency to the base currency. SAR is pegged to
   * USD, but the peg is a CONFIGURED ASSUMPTION here, not a law — like the VAT
   * rate, it is a number someone chose and can be wrong about.
   */
  fxRate?: number;
  /** Mirrors cfg.budget.perTradeCapMinor so sizing matches the live path. */
  perTradeCapMinor?: Minor;
}

export function simulateStrategy(opts: SimOptions): SimResult {
  const params = opts.params ?? DEFAULT_STRATEGY_PARAMS;
  const fx = opts.fxRate ?? 1;
  const px = (minor: Minor): Minor => Math.max(1, Math.round(minor * fx));
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

    // 2. THE PENDING ORDER FILLS AT THIS SESSION'S OPEN. Never at the close it
    //    was decided on.
    if (pending !== null) {
      const price = px(bar.openMinor);
      if (pending.side === 'BUY') {
        const gross = pending.qty * price;
        const c = tradeCostMinor(gross, opts.cost);
        if (gross + c <= settledCash) {
          settledCash -= gross + c;
          qty += pending.qty;
          basis += gross + c;
          costs += c;
          entryDay = day;
        }
      } else {
        const sellQty = Math.min(pending.qty, qty);
        if (sellQty > 0) {
          const gross = sellQty * price;
          const c = tradeCostMinor(gross, opts.cost);
          const proceeds = gross - c;
          const relieved = sellQty === qty ? basis : Math.floor((basis * sellQty) / qty);
          costs += c;
          realised += proceeds - relieved;
          trades.push({
            entryDayUtc: entryDay,
            exitDayUtc: day,
            qty: sellQty,
            basisMinor: relieved,
            proceedsMinor: proceeds,
            costsMinor: c,
            realisedMinor: proceeds - relieved,
            closedAtMark: false,
          });
          qty -= sellQty;
          basis -= relieved;
          unsettled.push({ dueIdx: s + Math.max(0, opts.cost.settlementDays), amount: proceeds });
        }
      }
      pending = null;
    }

    // 3. DECIDE on this session's close.
    const closes: Minor[] = [];
    for (let i = 0; i <= idx; i++) closes.push(px((bars[i] as Bar).closeMinor));
    const last = s === opts.sessionDays.length - 1;
    const sig = strategySignal(opts.arm, closes, qty > 0, params);
    const close = px(bar.closeMinor);

    if (last && qty > 0) {
      // 4. FINAL SESSION: close the book at this session's CLOSE so the run
      //    produces a realised number instead of an open position and a story.
      //    This is a MARK, not a fill — the report says so.
      const gross = qty * close;
      const c = tradeCostMinor(gross, opts.cost);
      const proceeds = gross - c;
      costs += c;
      realised += proceeds - basis;
      trades.push({
        entryDayUtc: entryDay,
        exitDayUtc: day,
        qty,
        basisMinor: basis,
        proceedsMinor: proceeds,
        costsMinor: c,
        realisedMinor: proceeds - basis,
        closedAtMark: true,
      });
      settledCash += proceeds; // marked out, so it counts in the ending equity
      qty = 0;
      basis = 0;
    } else if (!last) {
      if (sig.action === 'ENTER' && qty === 0) {
        const equity = settledCash + unsettledTotal(unsettled) + qty * close;
        const d = sizePosition(
          {
            equityMinor: equity,
            exposureMinor: qty * close,
            cashAvailableMinor: settledCash,
            unitPriceMinor: close,
            perTradeCapMinor: opts.perTradeCapMinor ?? 0,
          },
          opts.sizing,
        );
        if (!d.refused) pending = { side: 'BUY', qty: d.qty };
      } else if (sig.action === 'EXIT' && qty > 0) {
        pending = { side: 'SELL', qty };
      }
    }

    equityCurve.push(settledCash + unsettledTotal(unsettled) + qty * close);
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

/* ─────────────────────────────────────────────────────────────── statistics */

export interface PerformanceStats {
  label: string;
  startingEquityMinor: Minor;
  endingEquityMinor: Minor;
  realisedPnLMinor: Minor;
  returnBps: number;
  maxDrawdownMinor: Minor;
  maxDrawdownBps: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalCostsMinor: Minor;
  largestSingleLossMinor: Minor;
}

/** Peak-to-trough decline of an equity curve, in minor units and in bps. */
export function maxDrawdown(curve: readonly Minor[]): { minor: Minor; bps: number } {
  let peak = curve.length > 0 ? (curve[0] as Minor) : 0;
  let worst = 0;
  let worstBps = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > worst) {
      worst = dd;
      worstBps = peak > 0 ? Math.round((dd / peak) * 10_000) : 0;
    }
  }
  return { minor: worst, bps: worstBps };
}

export interface TradeResult {
  realisedMinor: Minor;
  costsMinor: Minor;
}

export function computeStats(
  label: string,
  startingEquityMinor: Minor,
  endingEquityMinor: Minor,
  curve: readonly Minor[],
  trades: readonly TradeResult[],
): PerformanceStats {
  const dd = maxDrawdown(curve);
  let wins = 0;
  let losses = 0;
  let costs = 0;
  let realised = 0;
  let worstLoss = 0;
  for (const t of trades) {
    realised += t.realisedMinor;
    costs += t.costsMinor;
    if (t.realisedMinor > 0) wins++;
    else losses++;
    if (t.realisedMinor < worstLoss) worstLoss = t.realisedMinor;
  }
  const starting = Math.max(1, startingEquityMinor);
  return {
    label,
    startingEquityMinor,
    endingEquityMinor,
    realisedPnLMinor: realised,
    returnBps: Math.round(((endingEquityMinor - starting) / starting) * 10_000),
    maxDrawdownMinor: dd.minor,
    maxDrawdownBps: dd.bps,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length === 0 ? 0 : wins / trades.length,
    totalCostsMinor: costs,
    largestSingleLossMinor: worstLoss,
  };
}

/**
 * Combine several single-instrument curves into one book-level curve over the
 * union of their days, forward-filling each instrument's last known equity.
 */
export function aggregateCurves(runs: ReadonlyArray<{ days: readonly string[]; equityCurve: readonly Minor[]; startingEquityMinor: Minor }>): {
  days: string[];
  curve: Minor[];
} {
  const allDays = [...new Set(runs.flatMap((r) => [...r.days]))].sort();
  const cursors = runs.map(() => 0);
  const lastSeen = runs.map((r) => r.startingEquityMinor);
  const curve: Minor[] = [];
  for (const d of allDays) {
    let total = 0;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i] as { days: readonly string[]; equityCurve: readonly Minor[] };
      let c = cursors[i] as number;
      while (c < r.days.length && (r.days[c] as string) <= d) {
        lastSeen[i] = r.equityCurve[c] as Minor;
        c++;
      }
      cursors[i] = c;
      total += lastSeen[i] as Minor;
    }
    curve.push(total);
  }
  return { days: allDays, curve };
}

/* ──────────────────────────────────── windowed evaluation (MARKET_SPEC §10) */

export interface WindowedEvalOptions {
  arm: StrategyArm;
  bars: readonly Bar[];
  /** Sessions per window. 10 answers the question the operator actually asked. */
  windowSessions: number;
  startingEquityMinor: Minor;
  cost: CostModel;
  sizing: SizingPolicy;
  params?: StrategyParams;
  /** Sessions between window starts. 1 = every possible window. */
  step?: number;
  perTradeCapMinor?: Minor;
  fxRate?: number;
}

export interface WindowedEvalResult {
  arm: StrategyArm;
  symbol: string;
  windowSessions: number;
  windows: number;
  returnsBps: number[];
  minBps: number;
  p10Bps: number;
  medianBps: number;
  p90Bps: number;
  maxBps: number;
  meanBps: number;
  fractionPositive: number;
  /** THE number the operator asked for: how often this doubled in a window. */
  fractionDoubled: number;
  statement: string;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i] as number;
}

/**
 * Run the SAME strategy across every historical window of `windowSessions` and
 * report the distribution of outcomes. This is the antidote to reading one
 * 10-session result as evidence: it shows the spread the same rule produces on
 * the same data, and states what fraction of those windows reached +100%.
 */
export function windowedEvaluation(opts: WindowedEvalOptions): WindowedEvalResult {
  const n = Math.max(2, Math.trunc(opts.windowSessions));
  const step = Math.max(1, Math.trunc(opts.step ?? 1));
  const warm = warmupBars(opts.arm, opts.params ?? DEFAULT_STRATEGY_PARAMS);
  const bars = opts.bars;
  const returnsBps: number[] = [];
  for (let start = warm; start + n <= bars.length; start += step) {
    const sessionDays = bars.slice(start, start + n).map((b) => b.dayUtc);
    const r = simulateStrategy({
      arm: opts.arm,
      bars,
      sessionDays,
      startingEquityMinor: opts.startingEquityMinor,
      cost: opts.cost,
      sizing: opts.sizing,
      ...(opts.params !== undefined ? { params: opts.params } : {}),
      ...(opts.fxRate !== undefined ? { fxRate: opts.fxRate } : {}),
      ...(opts.perTradeCapMinor !== undefined ? { perTradeCapMinor: opts.perTradeCapMinor } : {}),
    });
    returnsBps.push(r.returnBps);
  }
  const sorted = [...returnsBps].sort((a, b) => a - b);
  const windows = returnsBps.length;
  const doubled = returnsBps.filter((r) => r >= 10_000).length;
  const positive = returnsBps.filter((r) => r > 0).length;
  const meanBps = windows === 0 ? 0 : Math.round(returnsBps.reduce((a, b) => a + b, 0) / windows);
  const fractionDoubled = windows === 0 ? 0 : doubled / windows;
  const statement =
    windows === 0
      ? `No window of ${n} session(s) could be evaluated: there is not enough history. No base rate can be quoted, ` +
        `and the absence of a number is not a small number.`
      : `Across ${windows} historical window(s) of ${n} sessions on ${(bars[0] as Bar | undefined)?.symbol ?? 'this instrument'}, ` +
        `the '${opts.arm}' strategy returned between ${(sorted[0] as number) / 100}% and ${(sorted[sorted.length - 1] as number) / 100}% ` +
        `(median ${percentile(sorted, 50) / 100}%, mean ${meanBps / 100}%). ` +
        `${doubled} of ${windows} windows (${(fractionDoubled * 100).toFixed(2)}%) reached +100%. ` +
        `That percentage IS the base rate for "double the money in ${n} working days" on this data — ` +
        `it is what the history says, not what anyone hopes. ` +
        `${doubled === 0 ? 'It did not happen once. ' : ''}` +
        `A single ${n}-session run is one draw from this spread and cannot distinguish skill from luck.`;
  return {
    arm: opts.arm,
    symbol: (bars[0] as Bar | undefined)?.symbol ?? '',
    windowSessions: n,
    windows,
    returnsBps,
    minBps: windows === 0 ? 0 : (sorted[0] as number),
    p10Bps: percentile(sorted, 10),
    medianBps: percentile(sorted, 50),
    p90Bps: percentile(sorted, 90),
    maxBps: windows === 0 ? 0 : (sorted[sorted.length - 1] as number),
    meanBps,
    fractionPositive: windows === 0 ? 0 : positive / windows,
    fractionDoubled,
    statement,
  };
}

/* ──────────────────────────────────────────────────────────────── the report */

export interface VenueSessionReport {
  venue: Venue;
  sessions: number;
  firstDayUtc: string | null;
  lastDayUtc: string | null;
  symbols: string[];
}

export interface RunReport {
  version: number;
  runId: string;
  mode: 'PAPER';
  generatedAtMs: number;
  fromDayUtc: string;
  toDayUtc: string;
  sessionsRequestedPerVenue: number;
  venues: VenueSessionReport[];
  /** Why the two venues' session counts and dates do not line up. */
  sessionAlignmentNote: string;
  currency: Currency;
  startingCapitalMinor: Minor;
  swarm: PerformanceStats;
  benchmark: PerformanceStats;
  verdict: { beatsBenchmark: boolean; differenceBps: number; text: string };
  windowed: WindowedEvalResult[];
  honesty: string[];
  costModel: CostModel;
  sizing: SizingPolicy;
  strategies: Array<{ arm: StrategyArm; params: unknown; principledReason: string }>;
  armWeights: Record<string, { a: number; b: number; mean: number; n: number }>;
  resumed: boolean;
  sessionsExecuted: number;
}

export const RUN_REPORT_VERSION = 1;

/**
 * How a report is rendered. src/market/report.ts owns the shipped renderer;
 * it is loaded dynamically at runtime (see loadReportEmitter) so this module
 * compiles and tests before that file exists, and so a missing renderer
 * degrades to the built-in one instead of failing a two-week run at the last
 * step. Nothing here depends on it being present.
 */
export interface ReportEmitter {
  readonly name: string;
  json(report: RunReport): string;
  text(report: RunReport): string;
}

export const builtinReportEmitter: ReportEmitter = {
  name: 'builtin',
  json(report: RunReport): string {
    return JSON.stringify(report, null, 2);
  },
  text(report: RunReport): string {
    return renderReportText(report);
  },
};

/**
 * Try the sibling module's renderer, fall back to the built-in one. A renderer
 * is accepted if it exports text/json functions under any of the obvious names.
 */
export async function loadReportEmitter(specifier = '../market/report.js'): Promise<ReportEmitter> {
  try {
    const spec: string = specifier;
    const mod = (await import(spec)) as Record<string, unknown>;
    const text = pickFn(mod, ['renderReportText', 'reportText', 'toText', 'renderText']);
    const json = pickFn(mod, ['renderReportJson', 'reportJson', 'toJson', 'renderJson']);
    if (text === null && json === null) return builtinReportEmitter;
    return {
      name: `market/report.ts`,
      text: (r) => (text === null ? builtinReportEmitter.text(r) : String(text(r))),
      json: (r) => (json === null ? builtinReportEmitter.json(r) : String(json(r))),
    };
  } catch {
    return builtinReportEmitter;
  }
}

function pickFn(mod: Record<string, unknown>, names: string[]): ((r: RunReport) => unknown) | null {
  for (const n of names) {
    const v = mod[n];
    if (typeof v === 'function') return v as (r: RunReport) => unknown;
  }
  return null;
}

const bps = (b: number): string => `${(b / 100).toFixed(2)}%`;

/** The human-readable report. The verdict is in words and it is not buried. */
export function renderReportText(r: RunReport): string {
  const cur = r.currency;
  const m = (x: Minor): string => fmt(money(Math.trunc(x), cur));
  const L: string[] = [];
  L.push(`ARES PAPER RUN REPORT — ${r.runId}`);
  L.push(`mode=${r.mode}  (no real orders were placed, at any point, by any code path)`);
  L.push(`range ${r.fromDayUtc} .. ${r.toDayUtc}   requested ${r.sessionsRequestedPerVenue} session(s) PER VENUE`);
  L.push('');
  L.push('SESSIONS PER VENUE — these do not align, and the report does not pretend they do:');
  for (const v of r.venues) {
    L.push(`  ${v.venue.padEnd(8)} ${String(v.sessions).padStart(3)} session(s)  ${v.firstDayUtc ?? '-'} .. ${v.lastDayUtc ?? '-'}  [${v.symbols.join(', ')}]`);
  }
  L.push(`  ${r.sessionAlignmentNote}`);
  L.push('');
  L.push(`CAPITAL: ${m(r.startingCapitalMinor)} modelled.`);
  L.push('');
  L.push('RESULT, SIDE BY SIDE (same instruments, same sessions, same capital, same cost model):');
  const row = (s: PerformanceStats): string =>
    `  ${s.label.padEnd(16)} end ${m(s.endingEquityMinor).padStart(16)}  return ${bps(s.returnBps).padStart(9)}  ` +
    `realised ${m(s.realisedPnLMinor).padStart(14)}  maxDD ${bps(s.maxDrawdownBps).padStart(8)}  ` +
    `trades ${String(s.trades).padStart(3)}  win ${(s.winRate * 100).toFixed(0).padStart(3)}%  ` +
    `costs ${m(s.totalCostsMinor).padStart(12)}  worst ${m(s.largestSingleLossMinor)}`;
  L.push(row(r.swarm));
  L.push(row(r.benchmark));
  L.push('');
  L.push('VERDICT:');
  for (const line of r.verdict.text.split('\n')) L.push(`  ${line}`);
  L.push('');
  L.push('STATISTICAL HONESTY:');
  for (const h of r.honesty) L.push(`  - ${h}`);
  for (const w of r.windowed) {
    L.push('');
    L.push(`  DISTRIBUTION — ${w.symbol} / ${w.arm}, ${w.windowSessions}-session windows:`);
    L.push(`    windows=${w.windows}  min=${bps(w.minBps)}  p10=${bps(w.p10Bps)}  median=${bps(w.medianBps)}  p90=${bps(w.p90Bps)}  max=${bps(w.maxBps)}`);
    L.push(`    positive=${(w.fractionPositive * 100).toFixed(1)}%   REACHED +100%: ${(w.fractionDoubled * 100).toFixed(2)}%`);
    L.push(`    ${w.statement}`);
  }
  L.push('');
  L.push('STRATEGIES (arm, parameters, and whether there is a principled reason to expect an edge):');
  for (const s of r.strategies) {
    L.push(`  ${s.arm} ${JSON.stringify(s.params)}`);
    L.push(`      ${s.principledReason}`);
  }
  L.push('');
  L.push(`COST MODEL: ${JSON.stringify(r.costModel)}`);
  L.push(`SIZING:     ${JSON.stringify(r.sizing)} (exposure can never exceed equity: no leverage, by construction)`);
  L.push(`SESSIONS EXECUTED: ${r.sessionsExecuted}${r.resumed ? ' (this run was RESUMED from persisted progress)' : ''}`);
  return L.join('\n');
}

/**
 * The §9 verdict, in words. The rule is simple and it is stated, not implied:
 * underperforming buy-and-hold means no edge, whatever the P&L was.
 */
export function benchmarkVerdict(swarm: PerformanceStats, bench: PerformanceStats): RunReport['verdict'] {
  const diff = swarm.returnBps - bench.returnBps;
  const beats = diff > 0;
  const lines: string[] = [];
  if (!beats) {
    lines.push(
      `NO EDGE. The swarm returned ${bps(swarm.returnBps)} against buy-and-hold's ${bps(bench.returnBps)} on the same ` +
        `instruments, the same sessions, the same starting capital and the same costs — it UNDERPERFORMED the ` +
        `benchmark by ${bps(Math.abs(diff))}.`,
    );
    lines.push(
      `This verdict does not change if the swarm made money. A strategy that made ${swarm.realisedPnLMinor >= 0 ? 'a profit' : 'a loss'} ` +
        `while trailing a do-nothing benchmark has produced no evidence of skill: the same money was available by ` +
        `buying once and sitting still, without ${swarm.trades} round trip(s) and without ` +
        `${fmt(money(Math.trunc(swarm.totalCostsMinor), 'SAR'))} of costs.`,
    );
    lines.push(`Recommended reading of this run: the strategy is not yet distinguishable from a worse version of doing nothing.`);
  } else {
    lines.push(
      `The swarm returned ${bps(swarm.returnBps)} against buy-and-hold's ${bps(bench.returnBps)}, outperforming by ` +
        `${bps(diff)} on identical instruments, sessions, capital and costs.`,
    );
    lines.push(
      `This is NOT yet evidence of an edge. With ${swarm.trades} trade(s) over this many sessions, an outperformance ` +
        `of this size is well within what luck produces; see the windowed distribution below for how wide that spread is.`,
    );
  }
  return { beatsBenchmark: beats, differenceBps: diff, text: lines.join('\n') };
}

/** The §10 statements. They go in every report, whatever the numbers say. */
export function honestyStatements(sessions: number, trades: number): string[] {
  return [
    `${sessions} session(s) is a TINY sample. Ten observations cannot separate skill from luck: with a per-session ` +
      `standard deviation around 1%, the standard error of a 10-session mean is about 0.3%/session, which is larger ` +
      `than any edge a strategy of this kind plausibly has. Nothing in this report should be read as proof of one.`,
    `${trades} completed round trip(s) contributed to the win rate. A win rate computed on a handful of trades has a ` +
      `confidence interval so wide it is close to uninformative.`,
    `The point estimate is the least interesting number here. The distribution of historical windows below is what ` +
      `says how much of this result is noise.`,
    `Doubling capital in 10 sessions requires position sizes far above the Kelly-optimal fraction, where expected log ` +
      `growth turns NEGATIVE — betting that large loses money on average EVEN WITH a genuine edge. The sizing caps ` +
      `exist to keep this run on the right side of that line, so the target was never reachable by design, not by bad luck.`,
    `Past windows are not a forecast. A base rate measured on history is the best available answer to "how often has ` +
      `this happened", and it is not an answer to "will it happen next".`,
  ];
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
  ledger: Ledger;
  /** The SHARED task memory: run progress belongs to the swarm, not an agent. */
  taskMemory: MemoryStore;
  calendar: SessionCalendar;
  feed: PriceFeed;
  trader: TraderAgent;
  universe: readonly Instrument[];
  fromDayUtc: string;
  toDayUtc: string;
  /** "10 working days" — counted PER VENUE, because the calendars differ. */
  sessionsPerVenue: number;
  startingCapitalMinor: Minor;
  cost?: CostModel;
  sizing?: SizingPolicy;
  params?: StrategyParams;
  /** Windowed evaluation (§10). Disable only with a reason. */
  windowed?: { windowSessions: number; step?: number; arms?: readonly StrategyArm[] } | false;
  emitter?: ReportEmitter;
  /** Where the report files are written. Defaults to `${dataDir}/reports`. */
  reportDir?: string;
  fxRate?: number;
}

const PROGRESS_PREFIX = 'runplan.progress:';

export class RunPlan {
  private readonly o: RunPlanOptions;
  private readonly cost: CostModel;
  private readonly sizing: SizingPolicy;
  private readonly params: StrategyParams;
  private readonly log: Logger;
  private steps: RunStep[] = [];
  private equityByDay: Array<{ dayUtc: string; equityMinor: Minor }> = [];
  private resumedFlag = false;
  private executed = 0;

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
      throw new AresError('RUNPLAN_BAD_SESSIONS', `RunPlan: sessionsPerVenue must be a positive integer`, {
        sessionsPerVenue: opts.sessionsPerVenue,
      });
    }
    this.o = opts;
    this.cost = opts.cost ?? DEFAULT_COST_MODEL;
    this.sizing = opts.sizing ?? opts.trader.sizing ?? makeSizingPolicy({});
    this.params = opts.params ?? opts.trader.params ?? DEFAULT_STRATEGY_PARAMS;
    this.log = opts.logger.child({ mod: 'runplan', runId: opts.runId });
  }

  /** The venues present in the universe, in a stable order. */
  private venues(): Venue[] {
    return [...new Set(this.o.universe.map((i) => i.venue))].sort();
  }

  /**
   * The plan: for each venue, the first `sessionsPerVenue` sessions in range;
   * then every (day, venue) pair in date order. Deterministic — the same inputs
   * always produce the same plan, which is what makes resume safe.
   */
  buildPlan(): RunStep[] {
    const perVenue = new Map<Venue, string[]>();
    for (const v of this.venues()) {
      const all = this.o.calendar.sessionsBetween(v, this.o.fromDayUtc, this.o.toDayUtc);
      perVenue.set(v, all.slice(0, this.o.sessionsPerVenue));
    }
    const rows: RunStep[] = [];
    for (const [venue, days] of perVenue) {
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
   * Returns the report. Safe to call again after a crash: already-completed
   * sessions are skipped, and the ledger would deduplicate them regardless.
   */
  async run(): Promise<RunReport> {
    const steps = this.buildPlan();
    const fp = this.fingerprint();
    const prior = this.progress();
    let cursor = 0;
    let startedAtMs = Date.now();
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
      startedAtMs = prior.startedAtMs;
      this.resumedFlag = cursor > 0;
      const savedEquity = this.o.taskMemory.getFact<Array<{ dayUtc: string; equityMinor: Minor }>>(`${this.progressKey()}:equity`, []);
      if (Array.isArray(savedEquity)) this.equityByDay = savedEquity.filter((e) => e && typeof e.dayUtc === 'string');
      if (this.resumedFlag) {
        this.log.warn('runplan.resumed', { cursor, totalSteps: steps.length, lastDayUtc: prior.lastDayUtc });
      }
    }

    const perVenue: Record<string, number> = prior?.perVenue ?? {};
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
        startedAtMs,
        updatedAtMs: Date.now(),
      });
    }

    return this.report(steps, perVenue);
  }

  /** Sessions already completed, per venue. Reported, and used by resume. */
  sessionsCompleted(): Record<string, number> {
    return { ...(this.progress()?.perVenue ?? {}) };
  }

  private async report(steps: readonly RunStep[], perVenue: Record<string, number>): Promise<RunReport> {
    const cur = this.o.cfg.baseCurrency;
    const starting = this.o.startingCapitalMinor;

    // ---- the swarm's own numbers, from REALISED round trips only ----
    const closed = this.o.trader.closedRoundTrips();
    const curve = this.equityByDay.map((e) => e.equityMinor);
    const endingSwarm = curve.length > 0 ? (curve[curve.length - 1] as Minor) : starting;
    const swarm = computeStats(
      'swarm',
      starting,
      endingSwarm,
      curve,
      closed.map((t) => ({ realisedMinor: t.realisedMinor, costsMinor: t.costsMinor })),
    );

    // ---- the benchmark: buy-and-hold, SAME everything ----
    const bench = await this.benchmark();

    // ---- the distribution (§10) ----
    const windowed: WindowedEvalResult[] = [];
    if (this.o.windowed !== false) {
      const w = this.o.windowed ?? { windowSessions: this.o.sessionsPerVenue };
      const arms = w.arms ?? TRADER_ARMS;
      for (const inst of this.o.universe) {
        const bars = await this.historyFor(inst);
        for (const arm of arms) {
          windowed.push(
            windowedEvaluation({
              arm,
              bars,
              windowSessions: w.windowSessions,
              startingEquityMinor: starting,
              cost: this.cost,
              sizing: this.sizing,
              params: this.params,
              step: w.step ?? 1,
              perTradeCapMinor: this.o.cfg.budget.perTradeCapMinor,
              ...(this.o.fxRate !== undefined ? { fxRate: this.o.fxRate } : {}),
            }),
          );
        }
      }
    }

    const venueRows: VenueSessionReport[] = this.venues().map((v) => {
      const days = steps.filter((s) => s.venue === v).map((s) => s.dayUtc);
      return {
        venue: v,
        sessions: days.length,
        firstDayUtc: days.length > 0 ? (days[0] as string) : null,
        lastDayUtc: days.length > 0 ? (days[days.length - 1] as string) : null,
        symbols: this.o.universe.filter((i) => i.venue === v).map((i) => i.symbol),
      };
    });

    const report: RunReport = {
      version: RUN_REPORT_VERSION,
      runId: this.o.runId,
      mode: 'PAPER',
      generatedAtMs: Date.now(),
      fromDayUtc: this.o.fromDayUtc,
      toDayUtc: this.o.toDayUtc,
      sessionsRequestedPerVenue: this.o.sessionsPerVenue,
      venues: venueRows,
      sessionAlignmentNote:
        `US sessions are Mon-Fri and Tadawul sessions are Sun-Thu, so "${this.o.sessionsPerVenue} working days" is ` +
        `two different windows that overlap only on Mon-Thu. The counts above are PER VENUE and are not ` +
        `interchangeable; a per-venue total that differs from the request means the calendar (or a holiday in the ` +
        `configured list) ran out of sessions inside the requested date range.`,
      currency: cur,
      startingCapitalMinor: starting,
      swarm,
      benchmark: bench,
      verdict: benchmarkVerdict(swarm, bench),
      windowed,
      honesty: honestyStatements(steps.length, swarm.trades),
      costModel: this.cost,
      sizing: this.sizing,
      strategies: TRADER_ARMS.map((arm) => ({
        arm,
        params:
          arm === 'momentum' ? this.params.momentum : arm === 'mean-reversion' ? this.params.meanReversion : {},
        principledReason: STRATEGY_RATIONALE[arm],
      })),
      armWeights: this.o.trader.learner.weights(),
      resumed: this.resumedFlag,
      sessionsExecuted: this.executed,
    };
    return report;
  }

  /**
   * Buy-and-hold on the same instruments, over the same sessions, with the same
   * starting capital split equally between them, priced through the SAME cost
   * model object the swarm's fills use.
   */
  private async benchmark(): Promise<PerformanceStats> {
    const n = Math.max(1, this.o.universe.length);
    const perInstrument = Math.floor(this.o.startingCapitalMinor / n);
    const runs: SimResult[] = [];
    for (const inst of this.o.universe) {
      const bars = await this.historyFor(inst);
      const sessionDays = this.o.calendar
        .sessionsBetween(inst.venue, this.o.fromDayUtc, this.o.toDayUtc)
        .slice(0, this.o.sessionsPerVenue);
      runs.push(
        simulateStrategy({
          arm: 'buy-and-hold',
          bars,
          sessionDays,
          startingEquityMinor: perInstrument,
          cost: this.cost,
          sizing: this.sizing,
          params: this.params,
          perTradeCapMinor: this.o.cfg.budget.perTradeCapMinor,
          ...(this.o.fxRate !== undefined ? { fxRate: this.o.fxRate } : {}),
        }),
      );
    }
    const agg = aggregateCurves(runs);
    const ending = agg.curve.length > 0 ? (agg.curve[agg.curve.length - 1] as Minor) : this.o.startingCapitalMinor;
    const trades = runs.flatMap((r) => r.trades).map((t) => ({ realisedMinor: t.realisedMinor, costsMinor: t.costsMinor }));
    return computeStats('buy-and-hold', this.o.startingCapitalMinor, ending, agg.curve, trades);
  }

  private async historyFor(inst: Instrument): Promise<Bar[]> {
    const from = new Date(`${this.o.fromDayUtc}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 5 * 365);
    const bars = await this.o.feed.bars(inst.symbol, inst.venue, from.toISOString().slice(0, 10), this.o.toDayUtc);
    return [...bars].sort((a, b) => a.dayUtc.localeCompare(b.dayUtc));
  }

  /**
   * Render and write the report. Both forms, side by side, because the JSON is
   * what a later run diffs against and the text is what a human reads.
   */
  async emit(report: RunReport): Promise<{ jsonPath: string; textPath: string; emitter: string }> {
    const emitter = this.o.emitter ?? (await loadReportEmitter());
    const dir = this.o.reportDir ?? join(this.o.cfg.dataDir, 'reports');
    mkdirSync(dir, { recursive: true });
    const jsonPath = join(dir, `${report.runId}.json`);
    const textPath = join(dir, `${report.runId}.txt`);
    writeFileSync(jsonPath, emitter.json(report), 'utf8');
    writeFileSync(textPath, emitter.text(report), 'utf8');
    this.log.warn('runplan.report_written', { jsonPath, textPath, emitter: emitter.name });
    return { jsonPath, textPath, emitter: emitter.name };
  }
}
