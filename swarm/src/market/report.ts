/**
 * market/report.ts — the run report (SPEC §9, §10, §11).
 *
 * THE BENCHMARK IS THE POINT. Every run reports the swarm's realised P&L beside
 * buy-and-hold on the SAME instruments, the SAME sessions, the SAME starting
 * capital and the SAME cost model. A strategy that underperforms buy-and-hold has
 * no edge however much money it made, and this module says so in words, near the
 * top, rather than leaving it to be inferred from two numbers in a table.
 *
 * STATISTICAL HONESTY IS BUILT IN, not left to the reader. Ten sessions is a tiny
 * sample; ten observations cannot separate skill from luck. The report therefore
 * also shows the DISTRIBUTION of the same strategy's outcomes over many historical
 * windows and states what fraction of those windows reached the operator's target,
 * so a single flattering fortnight is seen next to its own base rate.
 *
 * Integer minor units throughout. Callers: the run controller and the dashboard.
 */

import { AresError } from '../core/errors.js';
import { fmt, money, type Currency, type Minor, type Money } from '../core/money.js';
import {
  commissionMinor,
  modelFill,
  toCurrency,
  DEFAULT_COSTS,
  COST_ASSUMPTION_NOTE,
  FX_ASSUMPTION_NOTE,
  type EquityTrade,
  type VenueCostModel,
} from '../channels/equities.js';
import type { SessionCalendar } from './calendar.js';
import { EPOCH_FLOOR_DAY, VENUE_CURRENCY, type Bar, type PriceFeed, type Venue } from './feed.js';

/* ------------------------------------------------------------------- inputs */

export interface InstrumentRef {
  symbol: string;
  venue: Venue;
}

export interface BenchmarkOptions {
  feed: PriceFeed;
  instruments: readonly InstrumentRef[];
  /** The session window PER VENUE, exactly as the run used it. */
  sessionsByVenue: Readonly<Partial<Record<Venue, readonly string[]>>>;
  startingCapital: Money;
  costs?: Partial<Record<Venue, VenueCostModel>>;
  sarPerUsd: number;
}

export interface BuyAndHoldLeg {
  symbol: string;
  venue: Venue;
  qty: number;
  entryDay: string;
  entryPriceMinor: Minor;
  exitDay: string;
  exitPriceMinor: Minor;
  costsMinor: Minor;
  /** Net of both sides' costs, in the VENUE's currency. */
  netMinor: Minor;
  currency: Currency;
  netBaseMinor: Minor;
  note: string;
}

export interface BuyAndHoldResult {
  legs: BuyAndHoldLeg[];
  investedBaseMinor: Minor;
  uninvestedBaseMinor: Minor;
  netBaseMinor: Minor;
  costsBaseMinor: Minor;
  returnBps: number;
  method: string;
}

/**
 * Buy-and-hold under the SAME rules the swarm plays by.
 *
 * Entry: decided at the close of the first session, filled at the OPEN of the
 * second — the identical no-lookahead rule, so the benchmark cannot be beaten by
 * an advantage the swarm never had.
 *
 * Exit: a modelled liquidation at the CLOSE of the final session, charged the full
 * exit commission, half-spread and slippage. Stated because it matters: inside a
 * fixed window there is no "next open" to sell into, and marking at the close
 * without charging exit costs would flatter the benchmark instead.
 *
 * Capital is split equally across instruments, converted into each venue's own
 * currency at the configured rate, and share counts are whole lots — so the
 * benchmark leaves some cash uninvested, exactly as a real one would.
 */
export async function computeBuyAndHold(opts: BenchmarkOptions): Promise<BuyAndHoldResult> {
  const base = opts.startingCapital.currency;
  const n = opts.instruments.length;
  if (n === 0) {
    throw new AresError('MARKET_REPORT_NO_INSTRUMENTS', 'computeBuyAndHold: no instruments', {});
  }
  const perInstrumentBase = Math.floor(opts.startingCapital.amount / n);
  const legs: BuyAndHoldLeg[] = [];
  let investedBase = 0;
  let netBase = 0;
  let costsBase = 0;

  for (const inst of opts.instruments) {
    const sessions = opts.sessionsByVenue[inst.venue] ?? [];
    if (sessions.length < 2) {
      throw new AresError(
        'MARKET_REPORT_SHORT_WINDOW',
        `computeBuyAndHold: ${inst.venue} needs at least 2 sessions to buy at the second session's open, got ${sessions.length}`,
        { venue: inst.venue, sessions: sessions.length },
      );
    }
    const costs = opts.costs?.[inst.venue] ?? DEFAULT_COSTS[inst.venue];
    const cur = VENUE_CURRENCY[inst.venue];
    const entryDay = sessions[1] as string;
    const exitDay = sessions[sessions.length - 1] as string;
    const entryBar = await barOn(opts.feed, inst, entryDay);
    const exitBar = await barOn(opts.feed, inst, exitDay);
    if (entryBar === null || exitBar === null) {
      throw new AresError(
        'MARKET_REPORT_MISSING_BAR',
        `computeBuyAndHold: ${inst.symbol} has no bar on ${entryBar === null ? entryDay : exitDay}`,
        { symbol: inst.symbol, venue: inst.venue, entryDay, exitDay },
      );
    }
    const allocVenue = toCurrency(money(perInstrumentBase, base), cur, opts.sarPerUsd).amount;
    const entry = modelFill('BUY', entryBar, null, costs);
    let qty = Math.floor(allocVenue / Math.max(1, entry.priceMinor));
    qty -= qty % costs.lotSize;
    while (qty > 0 && entry.priceMinor * qty + commissionMinor(entry.priceMinor * qty, costs) > allocVenue) {
      qty -= costs.lotSize;
    }
    if (qty <= 0) {
      legs.push({
        symbol: inst.symbol,
        venue: inst.venue,
        qty: 0,
        entryDay,
        entryPriceMinor: entry.priceMinor,
        exitDay,
        exitPriceMinor: 0,
        costsMinor: 0,
        netMinor: 0,
        currency: cur,
        netBaseMinor: 0,
        note: `allocation of ${fmt(money(allocVenue, cur))} does not cover one lot at ${entry.priceMinor}`,
      });
      continue;
    }
    const entryNotional = entry.priceMinor * qty;
    const entryFee = commissionMinor(entryNotional, costs);
    // Exit is a modelled liquidation at the final close, with full costs.
    const exitRef: Bar = { ...exitBar, openMinor: exitBar.closeMinor };
    const exit = modelFill('SELL', exitRef, null, costs);
    const exitNotional = exit.priceMinor * qty;
    const exitFee = commissionMinor(exitNotional, costs);
    const explicit = entryFee + exitFee;
    const implicit = entry.implicitCostMinor * qty + exit.implicitCostMinor * qty;
    const net = exitNotional - exitFee - (entryNotional + entryFee);
    const netBaseMinor = toCurrency(money(net, cur), base, opts.sarPerUsd).amount;
    investedBase += toCurrency(money(entryNotional + entryFee, cur), base, opts.sarPerUsd).amount;
    costsBase += toCurrency(money(explicit + implicit, cur), base, opts.sarPerUsd).amount;
    netBase += netBaseMinor;
    legs.push({
      symbol: inst.symbol,
      venue: inst.venue,
      qty,
      entryDay,
      entryPriceMinor: entry.priceMinor,
      exitDay,
      exitPriceMinor: exit.priceMinor,
      costsMinor: explicit + implicit,
      netMinor: net,
      currency: cur,
      netBaseMinor,
      note: 'entry at the second session open, exit modelled at the final session close',
    });
  }

  return {
    legs,
    investedBaseMinor: investedBase,
    uninvestedBaseMinor: opts.startingCapital.amount - investedBase,
    netBaseMinor: netBase,
    costsBaseMinor: costsBase,
    returnBps:
      opts.startingCapital.amount === 0 ? 0 : Math.round((netBase * 10_000) / opts.startingCapital.amount),
    method: 'equal-weight, whole lots, entry at session[1] open, exit modelled at final close, full costs both sides',
  };
}

async function barOn(feed: PriceFeed, inst: InstrumentRef, day: string): Promise<Bar | null> {
  const got = await feed.bars(inst.symbol, inst.venue, day, day);
  return got.length === 0 ? null : (got[0] as Bar);
}

/* -------------------------------------------------------- swarm-side metrics */

export interface SwarmMetrics {
  realisedNetBaseMinor: Minor;
  tradeCount: number;
  closedTradeCount: number;
  totalCostsBaseMinor: Minor;
  commissionBaseMinor: Minor;
  implicitCostBaseMinor: Minor;
  winRate: number | null;
  wins: number;
  losses: number;
  largestSingleLossBaseMinor: Minor;
  largestSingleWinBaseMinor: Minor;
  maxDrawdownBaseMinor: Minor;
  maxDrawdownBps: number;
  equityCurveBaseMinor: Minor[];
  returnBps: number;
}

export interface SwarmInput {
  trades: readonly EquityTrade[];
  startingCapital: Money;
  sarPerUsd: number;
  /**
   * Base-currency equity, one point per tick, if the caller tracks it (it should:
   * drawdown measured only at realisation understates the pain of the path). When
   * absent, the curve is rebuilt from cumulative realised P&L at settlement, which
   * is a LOWER BOUND on drawdown and is labelled as such in the text report.
   */
  equityCurveBaseMinor?: readonly Minor[];
}

export function computeSwarmMetrics(input: SwarmInput): SwarmMetrics {
  const base = input.startingCapital.currency;
  const toBase = (m: Minor, cur: Currency): Minor => toCurrency(money(m, cur), base, input.sarPerUsd).amount;
  let realised = 0;
  let commission = 0;
  let implicit = 0;
  let wins = 0;
  let losses = 0;
  let largestLoss = 0;
  let largestWin = 0;
  let closed = 0;
  for (const t of input.trades) {
    commission += toBase(t.commissionMinor, t.currency);
    implicit += toBase(t.implicitCostMinor, t.currency);
    if (t.realisedMinor === null) continue;
    closed++;
    const r = toBase(t.realisedMinor, t.currency);
    realised += r;
    if (r > 0) {
      wins++;
      if (r > largestWin) largestWin = r;
    } else if (r < 0) {
      losses++;
      if (r < largestLoss) largestLoss = r;
    }
  }
  let curve: Minor[];
  if (input.equityCurveBaseMinor !== undefined && input.equityCurveBaseMinor.length > 0) {
    curve = [...input.equityCurveBaseMinor];
  } else {
    const byTick = new Map<number, Minor>();
    for (const t of input.trades) {
      if (t.realisedMinor === null) continue;
      byTick.set(t.settleTick, (byTick.get(t.settleTick) ?? 0) + toBase(t.realisedMinor, t.currency));
    }
    const ticks = [...byTick.keys()].sort((a, b) => a - b);
    let run = input.startingCapital.amount;
    curve = [run];
    for (const tk of ticks) {
      run += byTick.get(tk) as Minor;
      curve.push(run);
    }
  }
  const dd = maxDrawdown(curve);
  return {
    realisedNetBaseMinor: realised,
    tradeCount: input.trades.length,
    closedTradeCount: closed,
    totalCostsBaseMinor: commission + implicit,
    commissionBaseMinor: commission,
    implicitCostBaseMinor: implicit,
    winRate: closed === 0 ? null : wins / closed,
    wins,
    losses,
    largestSingleLossBaseMinor: largestLoss,
    largestSingleWinBaseMinor: largestWin,
    maxDrawdownBaseMinor: dd.amountMinor,
    maxDrawdownBps: dd.bps,
    equityCurveBaseMinor: curve,
    returnBps:
      input.startingCapital.amount === 0 ? 0 : Math.round((realised * 10_000) / input.startingCapital.amount),
  };
}

/** Peak-to-trough, on the curve as given. Returns a NEGATIVE amount (or 0). */
export function maxDrawdown(curve: readonly Minor[]): { amountMinor: Minor; bps: number; peakIndex: number; troughIndex: number } {
  let peak = curve[0] ?? 0;
  let peakIdx = 0;
  let worst = 0;
  let worstBps = 0;
  let wPeak = 0;
  let wTrough = 0;
  for (let i = 0; i < curve.length; i++) {
    const v = curve[i] as Minor;
    if (v > peak) {
      peak = v;
      peakIdx = i;
    }
    const d = v - peak;
    if (d < worst) {
      worst = d;
      wPeak = peakIdx;
      wTrough = i;
      worstBps = peak === 0 ? 0 : Math.round((d * 10_000) / Math.abs(peak));
    }
  }
  return { amountMinor: worst, bps: worstBps, peakIndex: wPeak, troughIndex: wTrough };
}

/* ------------------------------------------------- §10 statistical honesty */

export interface WindowDistribution {
  symbol: string;
  venue: Venue;
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
  /** Fraction of windows that reached the operator's target (default +100%). */
  fractionAtTarget: number;
  targetBps: number;
}

/**
 * The distribution of buy-and-hold outcomes over EVERY rolling window of the run's
 * length in the available history. This is the base rate the single observed run
 * has to be judged against; without it, a +12% fortnight looks like skill and a
 * -12% fortnight looks like failure, when both may be ordinary noise.
 */
export async function windowDistribution(
  feed: PriceFeed,
  inst: InstrumentRef,
  windowSessions: number,
  opts: { targetBps?: number; costs?: VenueCostModel; fromDay?: string; toDay?: string } = {},
): Promise<WindowDistribution> {
  if (!Number.isInteger(windowSessions) || windowSessions < 2) {
    throw new AresError('MARKET_REPORT_BAD_WINDOW', `windowDistribution: windowSessions must be >= 2`, {
      windowSessions,
    });
  }
  const costs = opts.costs ?? DEFAULT_COSTS[inst.venue];
  const target = opts.targetBps ?? 10_000; // +100%
  const bars = await feed.bars(
    inst.symbol,
    inst.venue,
    opts.fromDay ?? EPOCH_FLOOR_DAY,
    opts.toDay ?? '9999-12-31',
  );
  const returns: number[] = [];
  for (let i = 0; i + windowSessions <= bars.length; i++) {
    const entryBar = bars[i + 1];
    const exitBar = bars[i + windowSessions - 1];
    if (entryBar === undefined || exitBar === undefined) continue;
    const entry = modelFill('BUY', entryBar, null, costs);
    const exit = modelFill('SELL', { ...exitBar, openMinor: exitBar.closeMinor }, null, costs);
    const qty = 1;
    const inCost = entry.priceMinor * qty + commissionMinor(entry.priceMinor * qty, costs);
    const outCash = exit.priceMinor * qty - commissionMinor(exit.priceMinor * qty, costs);
    if (inCost <= 0) continue;
    returns.push(Math.round(((outCash - inCost) * 10_000) / inCost));
  }
  const sorted = [...returns].sort((a, b) => a - b);
  const pct = (q: number): number => (sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number));
  const sum = returns.reduce((a, b) => a + b, 0);
  return {
    symbol: inst.symbol,
    venue: inst.venue,
    windowSessions,
    windows: returns.length,
    returnsBps: returns,
    minBps: sorted.length === 0 ? 0 : (sorted[0] as number),
    p10Bps: pct(0.1),
    medianBps: pct(0.5),
    p90Bps: pct(0.9),
    maxBps: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] as number),
    meanBps: returns.length === 0 ? 0 : Math.round(sum / returns.length),
    fractionPositive: returns.length === 0 ? 0 : returns.filter((r) => r > 0).length / returns.length,
    fractionAtTarget: returns.length === 0 ? 0 : returns.filter((r) => r >= target).length / returns.length,
    targetBps: target,
  };
}

/* ------------------------------------------------------------- the report */

export interface VenueSessionSummary {
  venue: Venue;
  sessions: number;
  firstSession: string;
  lastSession: string;
  holidaysConfigured: string[];
}

export interface RunReportInput {
  runId: string;
  startedAt: number;
  finishedAt: number;
  startingCapital: Money;
  sarPerUsd: number;
  swarm: SwarmMetrics;
  benchmark: BuyAndHoldResult;
  venues: VenueSessionSummary[];
  distributions: WindowDistribution[];
  instruments: readonly InstrumentRef[];
  costs: Readonly<Partial<Record<Venue, VenueCostModel>>>;
  notes?: readonly string[];
}

export interface RunReport extends RunReportInput {
  mode: 'PAPER';
  edge: {
    swarmNetBaseMinor: Minor;
    benchmarkNetBaseMinor: Minor;
    differenceBaseMinor: Minor;
    verdict: 'NO EDGE' | 'AHEAD OF BUY-AND-HOLD' | 'TIED WITH BUY-AND-HOLD';
    verdictText: string;
  };
  honesty: string[];
  assumptions: string[];
}

export const SAMPLE_SIZE_WARNING =
  'TEN SESSIONS CANNOT SEPARATE SKILL FROM LUCK. A ten-session result is one draw from a wide ' +
  'distribution: the sign of the number is mostly noise, and no amount of confidence in the ' +
  'strategy changes that. Read the window distribution below, not the headline.';

export function buildRunReport(input: RunReportInput): RunReport {
  const diff = input.swarm.realisedNetBaseMinor - input.benchmark.netBaseMinor;
  const verdict: RunReport['edge']['verdict'] = diff > 0 ? 'AHEAD OF BUY-AND-HOLD' : diff < 0 ? 'NO EDGE' : 'TIED WITH BUY-AND-HOLD';
  const cur = input.startingCapital.currency;
  const verdictText =
    diff < 0
      ? `NO EDGE. The swarm returned ${fmt(money(input.swarm.realisedNetBaseMinor, cur))} where simply buying ` +
        `the same instruments and doing nothing returned ${fmt(money(input.benchmark.netBaseMinor, cur))} — ` +
        `it underperformed by ${fmt(money(Math.abs(diff), cur))}. Trading added cost and risk and subtracted ` +
        `money. Whatever the swarm made, it did not earn it.`
      : diff > 0
        ? `AHEAD OF BUY-AND-HOLD by ${fmt(money(diff, cur))} over this window. This is NOT evidence of an ` +
          `edge: over ${input.venues.map((v) => `${v.sessions} ${v.venue}`).join(' / ')} sessions the ` +
          `difference is well inside noise. See the window distribution for the base rate.`
        : `TIED WITH BUY-AND-HOLD. The swarm took on trading risk and costs to arrive exactly where doing ` +
          `nothing arrived.`;
  const honesty = [
    SAMPLE_SIZE_WARNING,
    ...input.distributions.map(
      (d) =>
        `${d.symbol} (${d.venue}): over ${d.windows} historical ${d.windowSessions}-session windows, ` +
        `buy-and-hold returned between ${bps(d.minBps)} and ${bps(d.maxBps)}, median ${bps(d.medianBps)}; ` +
        `${(d.fractionPositive * 100).toFixed(1)}% of windows were positive and ` +
        `${(d.fractionAtTarget * 100).toFixed(2)}% reached ${bps(d.targetBps)}.`,
    ),
    input.distributions.length === 0
      ? 'No window distribution was computed — the report cannot show the base rate, so treat the headline as uninterpretable.'
      : `Fraction of historical windows that reached the +100% target: ` +
        `${input.distributions.map((d) => `${d.symbol} ${(d.fractionAtTarget * 100).toFixed(2)}%`).join(', ')}. ` +
        `That is the real base rate for the target named, and it is what a ten-session run is being asked to hit.`,
  ];
  return {
    ...input,
    mode: 'PAPER',
    edge: {
      swarmNetBaseMinor: input.swarm.realisedNetBaseMinor,
      benchmarkNetBaseMinor: input.benchmark.netBaseMinor,
      differenceBaseMinor: diff,
      verdict,
      verdictText,
    },
    honesty,
    assumptions: [COST_ASSUMPTION_NOTE, FX_ASSUMPTION_NOTE, ...(input.notes ?? [])],
  };
}

function bps(b: number): string {
  return `${(b / 100).toFixed(2)}%`;
}

/** Machine-readable form for the dashboard and the ledger. */
export function reportToJson(r: RunReport): string {
  return JSON.stringify(r, null, 2);
}

/** Human-readable form. The verdict is at the top, on purpose. */
export function renderReport(r: RunReport): string {
  const cur = r.startingCapital.currency;
  const m = (x: Minor): string => fmt(money(x, cur));
  const L: string[] = [];
  L.push('ARES RUN REPORT — PAPER MODE. NO REAL ORDERS WERE PLACED.');
  L.push(`run ${r.runId}`);
  L.push('');
  L.push(`VERDICT: ${r.edge.verdict}`);
  L.push(wrap(r.edge.verdictText));
  L.push('');
  L.push('HEAD TO HEAD (same instruments, same sessions, same capital, same costs)');
  L.push(`  swarm realised P&L      ${m(r.swarm.realisedNetBaseMinor)}  (${bps(r.swarm.returnBps)})`);
  L.push(`  buy-and-hold P&L        ${m(r.benchmark.netBaseMinor)}  (${bps(r.benchmark.returnBps)})`);
  L.push(`  difference              ${m(r.edge.differenceBaseMinor)}`);
  L.push(`  benchmark method        ${r.benchmark.method}`);
  L.push('');
  L.push('SWARM DETAIL');
  L.push(`  starting capital        ${m(r.startingCapital.amount)}`);
  L.push(`  trades (fills)          ${r.swarm.tradeCount}  (${r.swarm.closedTradeCount} closed)`);
  L.push(`  total costs paid        ${m(r.swarm.totalCostsBaseMinor)}  ` +
    `(commission ${m(r.swarm.commissionBaseMinor)}, spread+slippage ${m(r.swarm.implicitCostBaseMinor)})`);
  L.push(`  win rate                ${r.swarm.winRate === null ? 'n/a (no closed trades)' : `${(r.swarm.winRate * 100).toFixed(1)}% (${r.swarm.wins}W / ${r.swarm.losses}L)`}`);
  L.push(`  largest single loss     ${m(r.swarm.largestSingleLossBaseMinor)}`);
  L.push(`  max drawdown            ${m(r.swarm.maxDrawdownBaseMinor)}  (${bps(r.swarm.maxDrawdownBps)})`);
  L.push('');
  L.push('SESSIONS COUNTED PER VENUE (they are NOT the same calendar days)');
  for (const v of r.venues) {
    L.push(
      `  ${v.venue.padEnd(8)} ${v.sessions} sessions, ${v.firstSession} .. ${v.lastSession}, ` +
        `${v.holidaysConfigured.length} configured holiday(s)${v.holidaysConfigured.length === 0 ? ' — EMPTY LIST, see calendar.ts' : ''}`,
    );
  }
  L.push('');
  L.push('STATISTICAL HONESTY');
  for (const h of r.honesty) L.push(wrap(h));
  L.push('');
  L.push('ASSUMPTIONS THAT ARE NOT FACTS');
  for (const a of r.assumptions) L.push(wrap(a));
  L.push('');
  L.push(`FX used: 1 USD = ${r.sarPerUsd} SAR (configured, not observed).`);
  return L.join('\n');
}

function wrap(s: string, width = 96, indent = '  '): string {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let line = indent;
  for (const w of words) {
    if (line.length + w.length + 1 > width && line.trim() !== '') {
      out.push(line);
      line = indent;
    }
    line += (line === indent ? '' : ' ') + w;
  }
  if (line.trim() !== '') out.push(line);
  return out.join('\n');
}

/** Session summary straight from the calendar, so the report quotes the real list. */
export function summariseVenue(cal: SessionCalendar, venue: Venue, sessions: readonly string[]): VenueSessionSummary {
  return {
    venue,
    sessions: sessions.length,
    firstSession: sessions[0] ?? '',
    lastSession: sessions[sessions.length - 1] ?? '',
    holidaysConfigured: cal.holidaysOf(venue),
  };
}
