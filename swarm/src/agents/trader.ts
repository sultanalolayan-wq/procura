/**
 * agents/trader.ts — the equities trading agent. It REPLACES scout+seller for a
 * trading channel: the same fungible instrument is bought and sold, so there is
 * no inventory-to-offer pipeline and no resale estimate to be wrong about. What
 * it keeps is everything that makes the swarm safe: BaseAgent's halt gate and
 * action cap, budget reservations, the policy engine, the kill switch, survival,
 * memory and a bandit whose reward is REALISED cash at settlement.
 *
 * ── WHAT THE OPERATOR ASKED FOR, AND WHAT THE CAPS MAKE IMPOSSIBLE ───────────
 * The operator asked to double SAR 5,000 in 10 working days. That is +7.18% per
 * session, compounded. An index moves ~1% a day and a single liquid name ~2%;
 * reaching +100% in ten sessions therefore requires position sizes that are a
 * LARGE MULTIPLE of equity — leverage — because unlevered you cannot compound a
 * 1-2% daily move into 7.18% a day.
 *
 * The reason this file refuses to do that is not timidity, it is arithmetic.
 * For a bet with edge, expected LOG growth per period is maximised at the Kelly
 * fraction f* = edge/variance, rises to that point, and then FALLS; past 2*f* it
 * is NEGATIVE. A negative expected log growth rate means the median outcome of
 * repeating the bet is RUIN — you lose money on average even though the edge is
 * real and even though individual outcomes can be spectacular. Sizing large
 * enough to double in ten sessions sits far to the right of 2*f* for any edge a
 * strategy of this kind could plausibly have. So the caps below are not a
 * compromise between safety and the target: they are what keeps the sizing on
 * the side of the line where compounding works at all. The honest answer to
 * "can this double in 10 sessions" is the base rate the windowed evaluator in
 * runtime/runplan.ts computes from historical windows, and it is very small.
 *
 * ── WHAT IS DELIBERATELY ABSENT (MARKET_SPEC §8) ─────────────────────────────
 * No shorting, no margin, no leverage, no derivatives, no CFDs. Exposure can
 * never exceed equity (see MAX_EXPOSURE_BPS, enforced at policy construction AND
 * again at every sizing call). Orders never touch a network: fills are modelled
 * locally by the injected executor against the REAL bar.
 *
 * ── NO SAME-BAR LOOKAHEAD ────────────────────────────────────────────────────
 * A decision taken on the close of session D may only fill at session D+1's
 * open. The agent never places an order that can fill on the bar it just read.
 * The executor enforces the fill price; the agent enforces the ordering by
 * submitting with `decidedDayUtc = D` and consuming fills only on later
 * sessions.
 *
 * ── THE REWARD RULE ──────────────────────────────────────────────────────────
 * The bandit is updated on REALISED P&L when the closing sale's cash SETTLES,
 * correlated by round-trip id, exactly as the scout correlates realised margin
 * by traceId. It is never updated on unrealised mark-to-market and never on the
 * signal that justified the entry. Rewarding unrealised P&L is how an agent
 * learns to hold losers and cut winners: the mark of a losing position can be
 * deferred indefinitely, so a "don't realise it" policy scores perfectly.
 *
 * ── THE LIFETIME CASH CAP, A REAL CONSTRAINT ─────────────────────────────────
 * BudgetGovernor.cashSpentMinor accumulates and is NOT reduced by a sale, so
 * ARES_AGENT_CASH_CAP is a LIFETIME spend cap, not a position limit. A trader
 * doing N round trips of size S needs a cap of ~N*S. Set it accordingly or the
 * agent is refused mid-run; the refusal is logged and is normal operation, not
 * a crash.
 *
 * Callers: runtime/runplan.ts (the dated run controller), registry on respawn.
 */

import { BudgetDenied, PolicyDenied, AresError } from '../core/errors.js';
import type { Leg } from '../core/ledger.js';
import { idempotencyKey, newId } from '../core/ids.js';
import { money, type Currency, type Minor } from '../core/money.js';
import type { AgentId, Offer, Opportunity } from '../core/types.js';
import { Bandit } from '../memory/learning.js';
import type { ChannelAdapter } from '../channels/adapter.js';
import type { Bar, PriceFeed, Venue } from '../market/feed.js';
import { BaseAgent, type AgentDeps } from './base.js';

/* ────────────────────────────────────────────────────────────────────────────
 * MARKET_SPEC §2 — the FROZEN feed seam, imported from the module that owns it.
 * Re-exported here so a caller wiring a trader does not need two imports, and
 * so there is exactly ONE definition of Bar/PriceFeed/Venue in the codebase.
 * ──────────────────────────────────────────────────────────────────────────── */

export type { Bar, PriceFeed, Venue } from '../market/feed.js';

/* ──────────────────────────────────────────────────────────── the strategies */

/**
 * The bandit's arms. Three named, transparent strategies — no black boxes, no
 * undocumented parameters, and an explicit statement per arm of whether it has
 * a principled reason to work. Two of the three do not, at this horizon and
 * after costs, and say so.
 */
export type StrategyArm = 'buy-and-hold' | 'momentum' | 'mean-reversion';

export const TRADER_ARMS: readonly StrategyArm[] = Object.freeze([
  'buy-and-hold',
  'momentum',
  'mean-reversion',
]) as readonly StrategyArm[];

/**
 * ARM 1 — buy-and-hold. THE BENCHMARK (MARKET_SPEC §9). Buy once at the first
 * fillable open, hold to the end of the run, never trade again.
 *
 * PRINCIPLED REASON TO WORK: YES, but not as skill. Its positive long-run
 * expectation is the equity risk premium — compensation for bearing risk, not
 * an edge over the market. Over 10 sessions that premium (~0.03%/session) is
 * invisible against ~1%/session noise, so a 10-session result for this arm is
 * essentially a coin flip and must not be read as evidence of anything.
 * PARAMETERS: none. That is the point: it has nothing to overfit.
 */
export const BUY_AND_HOLD_PARAMS = Object.freeze({});

export interface MomentumParams {
  /** N: a close above the highest close of the previous N sessions enters. */
  readonly entryLookback: number;
  /** M: a close below the lowest close of the previous M sessions exits. */
  readonly exitLookback: number;
}

/**
 * ARM 2 — momentum, as an N-day closing-price breakout (a Donchian channel
 * measured on closes, not intraday highs, because the daily bar is all the feed
 * promises). N = 20 in, M = 10 out. Both are stated here and nowhere else.
 *
 * PRINCIPLED REASON TO WORK: WEAK. Cross-sectional and time-series momentum are
 * among the better-documented anomalies in the academic literature, with
 * plausible behavioural explanations (under-reaction, herding). But the
 * documented effect is measured over MONTHS, across HUNDREDS of instruments,
 * gross of the costs a retail participant pays, and it has decayed materially
 * since publication. On two instruments over ten sessions there is no reason
 * whatsoever to expect it to show up, and the round-trip cost model will
 * comfortably exceed any edge it might have. It is here as an honest,
 * inspectable hypothesis to be REFUTED by the benchmark comparison, not as a
 * claim of edge.
 */
export const MOMENTUM_PARAMS: MomentumParams = Object.freeze({ entryLookback: 20, exitLookback: 10 });

export interface MeanReversionParams {
  /** N: sessions in the mean/stddev window, inclusive of the decision close. */
  readonly lookback: number;
  /** Enter long when the z-score is at or below this (negative = cheap). */
  readonly entryZ: number;
  /** Exit when the z-score has recovered to at or above this. */
  readonly exitZ: number;
}

/**
 * ARM 3 — mean reversion on the z-score of the close against its own N-session
 * mean: z = (close - mean_N) / stddev_N (sample stddev, N-1 denominator).
 * N = 20, enter at z <= -1.5, exit at z >= 0. Thresholds stated explicitly.
 *
 * PRINCIPLED REASON TO WORK: WEAK, AND WEAKER THAN IT LOOKS. Short-horizon
 * reversal is real in index data and is usually explained as liquidity
 * provision — you are paid for buying what a forced seller is dumping. The
 * catch is that the payment is the bid-ask spread, which a retail participant
 * PAYS rather than earns, so the mechanism that generates the return is
 * precisely the one working against this agent. Backtests of this rule look
 * good mostly because they are run without costs; with the cost model wired in,
 * expect it to underperform. If it does, that is the system telling the truth.
 */
export const MEAN_REVERSION_PARAMS: MeanReversionParams = Object.freeze({ lookback: 20, entryZ: -1.5, exitZ: 0 });

export interface StrategyParams {
  readonly momentum: MomentumParams;
  readonly meanReversion: MeanReversionParams;
}

export const DEFAULT_STRATEGY_PARAMS: StrategyParams = Object.freeze({
  momentum: MOMENTUM_PARAMS,
  meanReversion: MEAN_REVERSION_PARAMS,
});

/** One honest line per arm, carried into the run report so it is never lost. */
export const STRATEGY_RATIONALE: Readonly<Record<StrategyArm, string>> = Object.freeze({
  'buy-and-hold':
    'Positive long-run expectation, but it is the equity risk premium (payment for bearing risk), not an edge. ' +
    'Over 10 sessions the premium is invisible against the noise.',
  momentum:
    'Weak. Time-series momentum is documented over months and across hundreds of instruments, gross of retail ' +
    'costs, and has decayed since publication. Over 10 sessions on a handful of symbols there is no reason to ' +
    'expect it to appear, and round-trip costs will likely exceed any edge.',
  'mean-reversion':
    'Weak, and weaker than it looks. Short-horizon reversal is usually explained as being PAID the spread for ' +
    'providing liquidity; a retail participant PAYS that spread, so the mechanism runs backwards here. Backtests ' +
    'of this rule flatter it mainly by omitting costs.',
});

export type SignalAction = 'ENTER' | 'EXIT' | 'HOLD';

/** Everything needed to explain one decision afterwards, in numbers and words. */
export interface StrategySignal {
  arm: StrategyArm;
  action: SignalAction;
  /** The signal's ACTUAL value on the decision bar (price, z-score, 1). */
  value: number;
  /** The threshold that value was compared against. */
  threshold: number;
  /** True once enough history exists for the rule to mean anything. */
  ready: boolean;
  reason: string;
}

/** Bars of history a rule needs before its first meaningful signal. */
export function warmupBars(arm: StrategyArm, params: StrategyParams = DEFAULT_STRATEGY_PARAMS): number {
  switch (arm) {
    case 'buy-and-hold':
      return 1;
    case 'momentum':
      return Math.max(params.momentum.entryLookback, params.momentum.exitLookback) + 1;
    case 'mean-reversion':
      return params.meanReversion.lookback;
    default:
      return 1;
  }
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (N-1). Returns 0 for fewer than two points. */
export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/**
 * The z-score of the last close against the mean of the last `lookback` closes.
 * Exported because the run report quotes it and the tests pin it.
 */
export function zScore(closes: readonly Minor[], lookback: number): { z: number; mean: number; sd: number } | null {
  if (closes.length < lookback || lookback < 2) return null;
  const win = closes.slice(closes.length - lookback);
  const m = mean(win);
  const sd = stddev(win);
  if (sd <= 0) return null;
  const last = win[win.length - 1] as number;
  return { z: (last - m) / sd, mean: m, sd };
}

/**
 * The one decision function. `closes` ends with the DECISION session's close;
 * nothing later may be passed in, which is what keeps lookahead out of the
 * strategy layer. `holding` selects the entry rule or the exit rule.
 */
export function strategySignal(
  arm: StrategyArm,
  closes: readonly Minor[],
  holding: boolean,
  params: StrategyParams = DEFAULT_STRATEGY_PARAMS,
): StrategySignal {
  const need = warmupBars(arm, params);
  if (closes.length < need) {
    return {
      arm,
      action: 'HOLD',
      value: 0,
      threshold: 0,
      ready: false,
      reason: `warming up: ${closes.length} of ${need} bar(s) of history needed by ${arm}`,
    };
  }
  const last = closes[closes.length - 1] as number;

  if (arm === 'buy-and-hold') {
    return holding
      ? { arm, action: 'HOLD', value: last, threshold: 0, ready: true, reason: 'buy-and-hold never exits before the end of the run' }
      : { arm, action: 'ENTER', value: last, threshold: 0, ready: true, reason: 'buy-and-hold enters at the first fillable open and holds' };
  }

  if (arm === 'momentum') {
    const p = params.momentum;
    if (!holding) {
      const win = closes.slice(Math.max(0, closes.length - 1 - p.entryLookback), closes.length - 1);
      if (win.length < p.entryLookback) {
        return { arm, action: 'HOLD', value: last, threshold: 0, ready: false, reason: `warming up: need ${p.entryLookback} prior closes` };
      }
      const hi = Math.max(...win);
      return {
        arm,
        action: last > hi ? 'ENTER' : 'HOLD',
        value: last,
        threshold: hi,
        ready: true,
        reason:
          last > hi
            ? `close ${last} broke above the ${p.entryLookback}-session high ${hi}`
            : `close ${last} did not exceed the ${p.entryLookback}-session high ${hi}`,
      };
    }
    const win = closes.slice(Math.max(0, closes.length - 1 - p.exitLookback), closes.length - 1);
    if (win.length === 0) {
      return { arm, action: 'HOLD', value: last, threshold: 0, ready: false, reason: 'warming up: no exit window yet' };
    }
    const lo = Math.min(...win);
    return {
      arm,
      action: last < lo ? 'EXIT' : 'HOLD',
      value: last,
      threshold: lo,
      ready: true,
      reason:
        last < lo
          ? `close ${last} broke below the ${p.exitLookback}-session low ${lo}`
          : `close ${last} held above the ${p.exitLookback}-session low ${lo}`,
    };
  }

  // mean-reversion
  const p = params.meanReversion;
  const z = zScore(closes, p.lookback);
  if (z === null) {
    return { arm, action: 'HOLD', value: 0, threshold: holding ? p.exitZ : p.entryZ, ready: false, reason: `z-score undefined (flat ${p.lookback}-session window)` };
  }
  if (!holding) {
    return {
      arm,
      action: z.z <= p.entryZ ? 'ENTER' : 'HOLD',
      value: z.z,
      threshold: p.entryZ,
      ready: true,
      reason:
        z.z <= p.entryZ
          ? `z ${z.z.toFixed(3)} at or below the entry threshold ${p.entryZ} (close ${last} vs ${p.lookback}-session mean ${z.mean.toFixed(1)}, sd ${z.sd.toFixed(1)})`
          : `z ${z.z.toFixed(3)} above the entry threshold ${p.entryZ}`,
    };
  }
  return {
    arm,
    action: z.z >= p.exitZ ? 'EXIT' : 'HOLD',
    value: z.z,
    threshold: p.exitZ,
    ready: true,
    reason:
      z.z >= p.exitZ
        ? `z ${z.z.toFixed(3)} recovered to the exit threshold ${p.exitZ}`
        : `z ${z.z.toFixed(3)} still below the exit threshold ${p.exitZ}`,
  };
}

/* ─────────────────────────────────────────────────────────── position sizing */

/**
 * THE HARD CEILING. Total exposure may never exceed 100% of equity: that is
 * what "no leverage" means numerically. It is a module constant, not a
 * configurable one, so no environment variable can raise it.
 */
export const MAX_EXPOSURE_BPS = 10_000;

export interface SizingPolicy {
  /** Cap on ONE position as a fraction of equity, in basis points. */
  readonly maxPositionFractionBps: number;
  /** Cap on TOTAL exposure as a fraction of equity. Never above 10,000. */
  readonly maxTotalExposureBps: number;
  /** Fraction of equity risked per trade, in basis points (the risk budget). */
  readonly riskPerTradeBps: number;
  /** The adverse move the risk budget is sized against, in basis points. */
  readonly stopLossBps: number;
  /** Positions smaller than this are not worth the round-trip cost. */
  readonly minPositionMinor: Minor;
}

/**
 * Defaults: 25% of equity per position, 80% total exposure, 1% of equity risked
 * per trade against an 8% adverse move. The 80% is deliberately below the 100%
 * ceiling so that ordinary price drift cannot push a compliant portfolio over
 * the line between sessions.
 */
export const DEFAULT_SIZING: SizingPolicy = Object.freeze({
  maxPositionFractionBps: 2_500,
  maxTotalExposureBps: 8_000,
  riskPerTradeBps: 100,
  stopLossBps: 800,
  minPositionMinor: 1,
});

/**
 * Build a sizing policy, REFUSING anything that would permit leverage. This is
 * the "impossible by construction" half of the guarantee: a configuration that
 * asks for more than 100% exposure does not produce a risky policy, it produces
 * an exception at construction time.
 */
export function makeSizingPolicy(p: Partial<SizingPolicy> = {}): SizingPolicy {
  const out: SizingPolicy = {
    maxPositionFractionBps: p.maxPositionFractionBps ?? DEFAULT_SIZING.maxPositionFractionBps,
    maxTotalExposureBps: p.maxTotalExposureBps ?? DEFAULT_SIZING.maxTotalExposureBps,
    riskPerTradeBps: p.riskPerTradeBps ?? DEFAULT_SIZING.riskPerTradeBps,
    stopLossBps: p.stopLossBps ?? DEFAULT_SIZING.stopLossBps,
    minPositionMinor: p.minPositionMinor ?? DEFAULT_SIZING.minPositionMinor,
  };
  const bad = (why: string, meta: Record<string, unknown>): never => {
    throw new AresError('SIZING_INVALID', `makeSizingPolicy: ${why}`, meta);
  };
  for (const k of ['maxPositionFractionBps', 'maxTotalExposureBps', 'riskPerTradeBps', 'stopLossBps'] as const) {
    const v = out[k];
    if (!Number.isSafeInteger(v) || v <= 0) bad(`${k} must be a positive integer number of basis points, got ${String(v)}`, { [k]: v });
  }
  if (!Number.isSafeInteger(out.minPositionMinor) || out.minPositionMinor < 0) {
    bad(`minPositionMinor must be a non-negative integer, got ${String(out.minPositionMinor)}`, { minPositionMinor: out.minPositionMinor });
  }
  if (out.maxTotalExposureBps > MAX_EXPOSURE_BPS) {
    bad(
      `maxTotalExposureBps ${out.maxTotalExposureBps} exceeds ${MAX_EXPOSURE_BPS} (100% of equity). ARES does not ` +
        `borrow: total exposure above equity is leverage, which is exactly what turns a losing strategy into a ` +
        `total loss, and it is refused here rather than merely left unused`,
      { maxTotalExposureBps: out.maxTotalExposureBps, ceiling: MAX_EXPOSURE_BPS },
    );
  }
  if (out.maxPositionFractionBps > out.maxTotalExposureBps) {
    bad(
      `maxPositionFractionBps ${out.maxPositionFractionBps} exceeds maxTotalExposureBps ${out.maxTotalExposureBps}: ` +
        `a single position may not be allowed more than the whole book`,
      { position: out.maxPositionFractionBps, total: out.maxTotalExposureBps },
    );
  }
  return Object.freeze(out);
}

/**
 * CONFIG-DRIVEN SIZING. The caps are environment variables, not constants, so
 * the operator sets them without editing code — but every value still goes
 * through makeSizingPolicy(), so no environment variable can buy leverage:
 * ARES_TRADER_MAX_EXPOSURE_BPS=50000 is refused at boot, loudly.
 *
 * ARES_TRADER_MAX_POSITION_BPS   per-position cap, bps of equity   (default 2500)
 * ARES_TRADER_MAX_EXPOSURE_BPS   total exposure cap, bps of equity (default 8000)
 * ARES_TRADER_RISK_BPS           equity risked per trade, bps      (default 100)
 * ARES_TRADER_STOP_BPS           adverse move sized against, bps   (default 800)
 * ARES_TRADER_MIN_POSITION_MINOR smallest worthwhile position      (default 1)
 *
 * It lives here rather than in core/config.ts because the market block in that
 * file is owned by the market module; these five numbers belong to the agent.
 */
export function sizingFromEnv(env: Record<string, string | undefined> = process.env): SizingPolicy {
  const num = (key: string, def: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return def;
    if (!/^\d+$/.test(raw.trim())) {
      throw new AresError('SIZING_INVALID', `sizingFromEnv: ${key} must be a non-negative integer, got ${JSON.stringify(raw)}`, { key, raw });
    }
    return Number(raw.trim());
  };
  return makeSizingPolicy({
    maxPositionFractionBps: num('ARES_TRADER_MAX_POSITION_BPS', DEFAULT_SIZING.maxPositionFractionBps),
    maxTotalExposureBps: num('ARES_TRADER_MAX_EXPOSURE_BPS', DEFAULT_SIZING.maxTotalExposureBps),
    riskPerTradeBps: num('ARES_TRADER_RISK_BPS', DEFAULT_SIZING.riskPerTradeBps),
    stopLossBps: num('ARES_TRADER_STOP_BPS', DEFAULT_SIZING.stopLossBps),
    minPositionMinor: num('ARES_TRADER_MIN_POSITION_MINOR', DEFAULT_SIZING.minPositionMinor),
  });
}

export type SizeBinding = 'risk' | 'position-cap' | 'exposure-cap' | 'cash' | 'per-trade-cap' | 'min-size' | 'price';

export interface SizeRequest {
  /** Total equity: settled cash plus the marked value of open positions. */
  equityMinor: Minor;
  /** Notional already at risk in open positions. */
  exposureMinor: Minor;
  /** Cash the budget governor will actually release right now. */
  cashAvailableMinor: Minor;
  /** The price one unit is expected to fill at, in base-currency minor units. */
  unitPriceMinor: Minor;
  /** cfg.budget.perTradeCapMinor — the policy engine refuses more than this. */
  perTradeCapMinor: Minor;
}

export interface SizeDecision {
  qty: number;
  notionalMinor: Minor;
  /** Which cap actually determined the size. Written into the rationale. */
  binding: SizeBinding;
  refused: boolean;
  reason: string;
  /** Every cap's own quantity, so the decision can be re-derived afterwards. */
  caps: { risk: number; position: number; exposure: number; cash: number; perTrade: number };
}

/**
 * Fractional, risk-based, hard-capped sizing. Every cap is computed, the
 * SMALLEST wins, and the result is then checked AGAIN against equity — so even
 * a caller that hand-builds an absurd request cannot obtain leverage. There is
 * no code path in this function that returns a notional above equity.
 */
export function sizePosition(req: SizeRequest, policy: SizingPolicy): SizeDecision {
  const equity = Math.max(0, Math.trunc(req.equityMinor));
  const exposure = Math.max(0, Math.trunc(req.exposureMinor));
  const cash = Math.max(0, Math.trunc(req.cashAvailableMinor));
  const price = Math.trunc(req.unitPriceMinor);
  const perTrade = Math.max(0, Math.trunc(req.perTradeCapMinor));
  const nil = (binding: SizeBinding, reason: string, caps: SizeDecision['caps']): SizeDecision => ({
    qty: 0,
    notionalMinor: 0,
    binding,
    refused: true,
    reason,
    caps,
  });
  const zeroCaps = { risk: 0, position: 0, exposure: 0, cash: 0, perTrade: 0 };

  if (price <= 0) return nil('price', `refused: a unit price of ${price} is not tradeable`, zeroCaps);

  // 1. RISK BUDGET: risk a fixed fraction of equity against a defined adverse
  //    move. This is the "risk-based" part — size falls as the stop widens.
  const riskCapital = Math.floor((equity * policy.riskPerTradeBps) / 10_000);
  const riskPerUnit = Math.max(1, Math.floor((price * policy.stopLossBps) / 10_000));
  const qtyRisk = Math.floor(riskCapital / riskPerUnit);

  // 2. PER-POSITION CAP as a fraction of equity.
  const qtyPosition = Math.floor(Math.floor((equity * policy.maxPositionFractionBps) / 10_000) / price);

  // 3. TOTAL EXPOSURE CAP. The headroom is what is left under the cap, and the
  //    cap itself is clamped to equity — the no-leverage line — whatever the
  //    policy says, belt and braces with makeSizingPolicy's refusal.
  const exposureCeiling = Math.min(
    equity,
    Math.floor((equity * Math.min(policy.maxTotalExposureBps, MAX_EXPOSURE_BPS)) / 10_000),
  );
  const headroom = Math.max(0, exposureCeiling - exposure);
  const qtyExposure = Math.floor(headroom / price);

  // 4. CASH ACTUALLY AVAILABLE. You cannot spend money you do not have; this is
  //    the second, independent reason leverage cannot happen.
  const qtyCash = Math.floor(cash / price);

  // 5. THE POLICY ENGINE'S PER-TRADE CAP, mirrored so the agent sizes within it
  //    instead of being denied after the fact.
  const qtyPerTrade = perTrade > 0 ? Math.floor(perTrade / price) : Number.MAX_SAFE_INTEGER;

  const caps = {
    risk: qtyRisk,
    position: qtyPosition,
    exposure: qtyExposure,
    cash: qtyCash,
    perTrade: qtyPerTrade === Number.MAX_SAFE_INTEGER ? -1 : qtyPerTrade,
  };

  const candidates: Array<{ binding: SizeBinding; qty: number }> = [
    { binding: 'risk', qty: qtyRisk },
    { binding: 'position-cap', qty: qtyPosition },
    { binding: 'exposure-cap', qty: qtyExposure },
    { binding: 'cash', qty: qtyCash },
    { binding: 'per-trade-cap', qty: qtyPerTrade },
  ];
  let chosen = candidates[0] as { binding: SizeBinding; qty: number };
  for (const c of candidates) if (c.qty < chosen.qty) chosen = c;

  const qty = Math.max(0, chosen.qty);
  if (qty <= 0) {
    return nil(chosen.binding, `refused: the ${chosen.binding} cap allows 0 unit(s) at a unit price of ${price}`, caps);
  }
  const notional = qty * price;
  if (notional < policy.minPositionMinor) {
    return nil('min-size', `refused: notional ${notional} is below the minimum position size ${policy.minPositionMinor}`, caps);
  }

  // 6. THE INVARIANT, RE-CHECKED. Not a comment, not a convention: if the
  //    arithmetic above were ever wrong, this refuses rather than borrows.
  if (exposure + notional > equity) {
    return nil(
      'exposure-cap',
      `refused: exposure ${exposure} + notional ${notional} would exceed equity ${equity}. ARES has no borrowing ` +
        `facility, so a position that cannot be paid for out of equity is not a position, it is leverage`,
      caps,
    );
  }

  return {
    qty,
    notionalMinor: notional,
    binding: chosen.binding,
    refused: false,
    reason:
      `sized ${qty} unit(s) at ${price} = ${notional}; binding cap was ${chosen.binding} ` +
      `(risk ${qtyRisk}, position ${qtyPosition}, exposure ${qtyExposure}, cash ${qtyCash}, perTrade ${caps.perTrade}); ` +
      `exposure ${exposure} -> ${exposure + notional} against equity ${equity}`,
    caps,
  };
}

/* ────────────────────────────────────────────────────── the execution seam */

export interface Instrument {
  symbol: string;
  venue: Venue;
}

export function instrumentKey(i: Instrument): string {
  return `${i.venue}:${i.symbol}`;
}

export interface EquityOrderRequest {
  orderId: string;
  symbol: string;
  venue: Venue;
  side: 'BUY' | 'SELL';
  qty: number;
  /** The session whose CLOSE the decision was taken on. Fills at D+1's open. */
  decidedDayUtc: string;
  idempotencyKey: string;
  meta: Record<string, unknown>;
}

/**
 * A modelled fill against the REAL bar. Every money field is in the swarm's
 * BASE currency and in minor units: FX belongs to the channel (MARKET_SPEC §6),
 * not to the agent, so the agent never holds a rate or a float.
 */
export interface EquityFill {
  orderId: string;
  symbol: string;
  venue: Venue;
  side: 'BUY' | 'SELL';
  qty: number;
  /** The session the order actually filled on — never `decidedDayUtc`. */
  fillDayUtc: string;
  /** Realised fill price per unit, inclusive of spread and slippage. */
  unitPriceMinor: Minor;
  /** unitPriceMinor * qty. */
  grossMinor: Minor;
  /** Commission and any other explicit cost of this side. Always >= 0. */
  costsMinor: Minor;
  /** The session the CASH lands (T+settlementDays). */
  settlesDayUtc: string;
  currency: Currency;
}

/**
 * What the trading agent needs from an execution venue, and nothing more. The
 * equities channel (src/channels/equities.ts, a ChannelAdapter) satisfies this
 * through a thin wrapper; a stub satisfies it in the tests. The agent holds no
 * socket, no rate and no cost model of its own — modelling the fill against the
 * real bar is the channel's job, and there is no path from here to a network.
 */
/**
 * WIRING THIS TO src/channels/equities.ts. EquitiesChannel is a ChannelAdapter
 * and already models the fill, the costs, the settlement delay and the FX; it is
 * addressed by a PER-VENUE tick (its `sessionDay(tick)` counts that venue's own
 * sessions, which is why ten US ticks and ten Tadawul ticks are different
 * calendar windows). A wrapper therefore has to do three things and no more:
 *   1. keep a per-venue session counter, so `decidedDayUtc` maps to that
 *      venue's tick — the run controller's step index is GLOBAL and is not it;
 *   2. route BUY through `channel.buy(opportunity, qty, tick, idem)`, which
 *      returns a holding already priced at `executionDay(tick)`'s open, and
 *      hand that back from `fills()` on the NEXT session so this agent's
 *      day accounting stays honest; route SELL through `publish()` + `poll()`;
 *   3. convert the venue's currency to the swarm's base with `channel.toBase()`
 *      before it reaches this interface — everything below is base currency.
 * The wrapper is deliberately NOT in this file: this agent must be testable
 * against a stub, and the channel must be replaceable without touching it.
 */
export interface EquityExecutor {
  readonly name: string;
  /**
   * The ChannelAdapter the policy engine gates. It is REQUIRED: a trade that
   * has not been through policy.checkBuy/checkSell is a trade nobody authorised.
   */
  readonly channel: ChannelAdapter;
  /** Queue an order. It may only fill on a session AFTER `decidedDayUtc`. */
  submit(order: EquityOrderRequest): Promise<void>;
  /** Fills that occurred at this session's open. Each is returned exactly once. */
  fills(venue: Venue, dayUtc: string): Promise<EquityFill[]>;
  /**
   * FINAL-SESSION LIQUIDATION, at THIS session's CLOSE, with the full exit cost
   * charged. Inside a fixed window there is no "next open" to sell into, so the
   * alternative to this is either leaving the run's result as an open position
   * and a story, or marking out without paying the exit — and marking out for
   * free is exactly how a backtest flatters itself. This is the same convention
   * market/report.ts uses to close the buy-and-hold benchmark, so the swarm and
   * the benchmark are closed the same way and remain comparable.
   */
  closeOut(req: { symbol: string; venue: Venue; qty: number; dayUtc: string; idempotencyKey: string }): Promise<EquityFill>;
}

/* ─────────────────────────────────────────────────────────── agent internals */

/** An open position: one per instrument, no pyramiding, long only. */
export interface OpenPosition {
  key: string;
  symbol: string;
  venue: Venue;
  /** The arm that OPENED it — and therefore the arm whose exit rule applies. */
  arm: StrategyArm;
  qty: number;
  /** All-in cost basis: cash out including every cost, in minor units. */
  basisMinor: Minor;
  /** The entry side's explicit costs, carried so the report can split them out. */
  entryCostsMinor: Minor;
  entryDayUtc: string;
  entryTick: number;
  roundTripId: string;
  /** The signal that justified the entry, kept for the postmortem. */
  entrySignal: { value: number; threshold: number; reason: string };
}

/** A sale awaiting settlement. The reward is paid when this lands, not before. */
export interface PendingSettlement {
  roundTripId: string;
  key: string;
  symbol: string;
  venue: Venue;
  arm: StrategyArm;
  qty: number;
  /** Cash in: gross less the selling costs. */
  proceedsMinor: Minor;
  costsMinor: Minor;
  /** Basis relieved by this sale. */
  basisMinor: Minor;
  /** The entry costs inside that basis, prorated. Reported, not re-charged. */
  entryCostsMinor: Minor;
  entryDayUtc: string;
  soldDayUtc: string;
  settlesDayUtc: string;
  /** Mark-to-market P&L at the moment of sale. REPORTED, never rewarded. */
  markAtSaleMinor: Minor;
}

/**
 * A round trip that has SETTLED: the only kind of result this agent learns from
 * and the only kind the run report counts. `markAtSaleMinor` is kept beside the
 * realised figure purely so the audit trail can show what an unrealised-reward
 * rule would have paid instead.
 */
export interface ClosedRoundTrip {
  roundTripId: string;
  arm: StrategyArm;
  symbol: string;
  venue: Venue;
  qty: number;
  basisMinor: Minor;
  /** Explicit costs of the ENTRY side, already inside basisMinor. */
  entryCostsMinor: Minor;
  proceedsMinor: Minor;
  /** Explicit costs of the EXIT side, already deducted from proceedsMinor. */
  costsMinor: Minor;
  realisedMinor: Minor;
  markAtSaleMinor: Minor;
  entryDayUtc: string;
  soldDayUtc: string;
  settledDayUtc: string;
  settlementTick: number;
}

export interface TradingSession {
  venue: Venue;
  /** YYYY-MM-DD of the session being traded. */
  dayUtc: string;
  /** The run's session index, used as the ledger/survival tick. */
  tick: number;
  /** True on the final session of the run: open positions are closed out. */
  finalSession?: boolean;
}

export interface TraderOptions {
  feed: PriceFeed;
  executor: EquityExecutor;
  universe: readonly Instrument[];
  /** Explicit arm set (tests pin this); defaults to TRADER_ARMS. */
  arms?: readonly StrategyArm[];
  sizing?: Partial<SizingPolicy>;
  params?: StrategyParams;
  /** Calendar days of history fetched before the decision day. */
  historyDays?: number;
}

/** Calendar days of bars pulled before the decision session (not sessions). */
export const DEFAULT_HISTORY_DAYS = 120;

export interface TraderStats {
  ordersSubmitted: number;
  buysFilled: number;
  sellsFilled: number;
  roundTripsClosed: number;
  refusals: number;
  openPositions: number;
  pendingSettlements: number;
  realisedPnLMinor: Minor;
  costsPaidMinor: Minor;
}

interface PersistedState {
  positions: OpenPosition[];
  pending: PendingSettlement[];
  closed: ClosedRoundTrip[];
  stats: TraderStats;
  seenFills: string[];
  lastSessionDay: string | null;
}

const STATE_FACT = 'trader.state';
const BANDIT_FACT = 'trader.bandit';
/** Fill ids remembered for idempotency on resume. Bounded. */
const SEEN_FILL_CAP = 500;

/**
 * The trading agent.
 *
 * One tick == one trading session for ONE venue. `setSession()` tells the agent
 * which session it is about to trade; the run controller in runtime/runplan.ts
 * drives that, because a dated run over two venues with different weekends is
 * not a wall-clock loop.
 */
export class TraderAgent extends BaseAgent {
  private readonly feed: PriceFeed;
  private readonly executor: EquityExecutor;
  private readonly universe: readonly Instrument[];
  private readonly arms: readonly StrategyArm[];
  private readonly bandit: Bandit;
  readonly sizing: SizingPolicy;
  readonly params: StrategyParams;
  private readonly historyDays: number;

  private readonly positions = new Map<string, OpenPosition>();
  private pending: PendingSettlement[] = [];
  private closed: ClosedRoundTrip[] = [];
  private readonly seenFills = new Set<string>();
  private session: TradingSession | null = null;
  private armThisSession: StrategyArm;
  private lastSessionDay: string | null = null;
  private stats: TraderStats = {
    ordersSubmitted: 0,
    buysFilled: 0,
    sellsFilled: 0,
    roundTripsClosed: 0,
    refusals: 0,
    openPositions: 0,
    pendingSettlements: 0,
    realisedPnLMinor: 0,
    costsPaidMinor: 0,
  };
  /** Last close seen per instrument, for marking equity. */
  private readonly marks = new Map<string, Minor>();
  private orderSeq = 0;

  constructor(id: AgentId, strategyId: string, deps: AgentDeps, opts: TraderOptions) {
    super(id, 'trader', strategyId, deps);
    if (!opts || typeof opts.feed !== 'object' || typeof opts.feed.bars !== 'function') {
      throw new AresError('TRADER_NO_FEED', 'TraderAgent: a PriceFeed is required', {});
    }
    if (!opts.executor || typeof opts.executor.submit !== 'function' || !opts.executor.channel) {
      throw new AresError(
        'TRADER_NO_EXECUTOR',
        'TraderAgent: an EquityExecutor exposing the ChannelAdapter the policy engine gates is required — ' +
          'a trade that has not been through policy.checkBuy/checkSell is a trade nobody authorised',
        {},
      );
    }
    if (!Array.isArray(opts.universe) || opts.universe.length === 0) {
      throw new AresError('TRADER_NO_UNIVERSE', 'TraderAgent: at least one instrument is required', {});
    }
    this.feed = opts.feed;
    this.executor = opts.executor;
    this.universe = Object.freeze([...opts.universe]);
    this.arms = opts.arms && opts.arms.length > 0 ? Object.freeze([...opts.arms]) : TRADER_ARMS;
    this.sizing = makeSizingPolicy(opts.sizing ?? {});
    this.params = opts.params ?? DEFAULT_STRATEGY_PARAMS;
    this.historyDays = opts.historyDays ?? DEFAULT_HISTORY_DAYS;
    const saved = deps.memory.getFact<unknown>(BANDIT_FACT, null);
    this.bandit = saved === null ? new Bandit([...this.arms], deps.rng) : Bandit.fromJSON(saved, deps.rng);
    for (const a of this.arms) this.bandit.addArm(a);
    this.armThisSession = this.arms[0] as StrategyArm;
    this.restore();
  }

  // ------------------------------------------------------------- inspection --

  get learner(): Bandit {
    return this.bandit;
  }

  get armInUse(): StrategyArm {
    return this.armThisSession;
  }

  openPositions(): OpenPosition[] {
    return [...this.positions.values()].map((p) => ({ ...p }));
  }

  pendingSettlements(): PendingSettlement[] {
    return this.pending.map((p) => ({ ...p }));
  }

  /** Every SETTLED round trip, in settlement order. The report counts these. */
  closedRoundTrips(): ClosedRoundTrip[] {
    return this.closed.map((c) => ({ ...c }));
  }

  /**
   * Cash from sales that have filled but not yet settled. It is NOT in the
   * ledger's cash balance (it is not spendable) but it IS part of the book's
   * value, so the equity curve would have a hole in it without this.
   */
  unsettledCashMinor(): Minor {
    let s = 0;
    for (const p of this.pending) s += p.proceedsMinor;
    return s;
  }

  traderStats(): TraderStats {
    return { ...this.stats, openPositions: this.positions.size, pendingSettlements: this.pending.length };
  }

  /** Notional currently at risk, marked at the last close seen. */
  exposureMinor(): Minor {
    let s = 0;
    for (const p of this.positions.values()) s += p.qty * (this.marks.get(p.key) ?? Math.floor(p.basisMinor / Math.max(1, p.qty)));
    return s;
  }

  /**
   * Equity = settled cash on the books + the marked value of open positions.
   * This is a REPORTING and SIZING figure. It is never a reward: see learn().
   */
  equityMinor(): Minor {
    return Math.max(0, this.deps.ledger.balanceOf('cash')) + this.exposureMinor();
  }

  // ---------------------------------------------------------------- session --

  /** Told to the agent by the run controller before each runTick(). */
  setSession(s: TradingSession): void {
    if (!s || typeof s.dayUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.dayUtc)) {
      throw new AresError('TRADER_BAD_SESSION', `TraderAgent.setSession: dayUtc must be YYYY-MM-DD, got ${String(s?.dayUtc)}`, { session: s });
    }
    this.session = { ...s };
  }

  override async onTick(tick: number): Promise<void> {
    const s = this.session;
    if (s === null) {
      this.log.warn('trader.no_session', { tick });
      return;
    }
    // 1. SETTLE FIRST. Cash that landed today is spendable today; a round trip
    //    whose cash has landed is the only thing that may reward the bandit.
    await this.collectFills(s);
    this.settleDue(s);

    // 2. One arm per session. The arm is what the bandit is judged on, so it
    //    must be drawn once and used for every entry decision in the session.
    const drawn = this.bandit.select();
    this.armThisSession = (this.arms.find((a) => a === drawn) ?? (this.arms[0] as StrategyArm));

    // 3. Decide per instrument on this venue, against bars up to TODAY'S close.
    for (const inst of this.universe) {
      if (inst.venue !== s.venue) continue;
      if (this.actionsLeft <= 0) break;
      await this.act(`decide:${inst.symbol}`, () => this.decide(inst, s));
    }
    this.lastSessionDay = s.dayUtc;
    this.persist();
  }

  // ------------------------------------------------------------------ fills --

  private async collectFills(s: TradingSession): Promise<void> {
    const fills = await this.act(`fills:${s.venue}`, () => this.executor.fills(s.venue, s.dayUtc));
    if (fills === null) return;
    for (const f of fills) {
      const fid = `${f.orderId}:${f.side}:${f.fillDayUtc}:${f.qty}`;
      if (this.seenFills.has(fid)) continue; // resume-safe: never book twice
      if (f.fillDayUtc <= this.decisionDayOf(f)) {
        // A fill dated on or before the decision day is same-bar lookahead. It
        // is refused loudly rather than booked: a backtest that accepts this is
        // lying, and this is the single most common way it happens.
        this.log.error('trader.lookahead_fill_refused', { orderId: f.orderId, fillDay: f.fillDayUtc, symbol: f.symbol });
        this.stats.refusals++;
        continue;
      }
      this.seenFills.add(fid);
      while (this.seenFills.size > SEEN_FILL_CAP) {
        const oldest = this.seenFills.values().next();
        if (oldest.done) break;
        this.seenFills.delete(oldest.value);
      }
      if (f.side === 'BUY') this.bookBuyFill(f, s);
      else this.bookSellFill(f, s);
    }
  }

  /** Decision days are carried on the order; fills echo them back in meta. */
  private readonly decidedBy = new Map<string, string>();

  private decisionDayOf(f: EquityFill): string {
    return this.decidedBy.get(f.orderId) ?? '0000-00-00';
  }

  private bookBuyFill(f: EquityFill, s: TradingSession): void {
    const key = instrumentKey(f);
    const spentMinor = f.grossMinor + Math.max(0, f.costsMinor);
    const qty = Math.max(0, f.qty);
    if (qty <= 0 || spentMinor <= 0) return;
    // The commission is CAPITALISED into the basis, exactly as the scout does:
    // expensing it would make every round trip look cheaper than it was, and a
    // cost floor computed against a bare price certifies losing trades.
    const unitBasis = Math.floor(spentMinor / qty);
    const inventoryMinor = unitBasis * qty;
    const feeResidual = spentMinor - inventoryMinor;
    const legs: Leg[] = [
      { account: 'inventory', amount: inventoryMinor },
      ...(feeResidual > 0 ? ([{ account: 'fees', amount: feeResidual }] as Leg[]) : []),
      { account: 'cash', amount: -spentMinor },
    ];
    this.deps.ledger.append({
      tick: s.tick,
      type: 'BUY',
      agentId: this.id,
      currency: f.currency,
      legs,
      idempotencyKey: idempotencyKey(['trader.buy', this.id, f.orderId, f.fillDayUtc, qty, f.unitPriceMinor]),
      meta: {
        paper: true,
        channel: this.executor.channel.name,
        venue: f.venue,
        symbol: f.symbol,
        sku: f.symbol,
        qty,
        unitPriceMinor: f.unitPriceMinor,
        costsMinor: f.costsMinor,
        fillDayUtc: f.fillDayUtc,
        decidedDayUtc: this.decisionDayOf(f),
        strategyId: this.strategyId,
        arm: this.positions.get(key)?.arm ?? this.armThisSession,
      },
    });
    const pos = this.positions.get(key);
    if (pos === undefined) {
      this.log.error('trader.buy_without_position_record', { key, orderId: f.orderId });
      return;
    }
    pos.qty += qty;
    pos.basisMinor += spentMinor;
    pos.entryCostsMinor += Math.max(0, f.costsMinor);
    this.stats.buysFilled++;
    this.stats.costsPaidMinor += Math.max(0, f.costsMinor);
    this.marks.set(key, f.unitPriceMinor);
    this.emit('BUY_RESULT', {
      ok: true,
      channel: this.executor.channel.name,
      symbol: f.symbol,
      venue: f.venue,
      qty,
      spentMinor,
      unitPriceMinor: f.unitPriceMinor,
      fillDayUtc: f.fillDayUtc,
      roundTripId: pos.roundTripId,
      tick: s.tick,
    });
  }

  /**
   * A sale is recorded but NOT rewarded here. The reward waits for the cash.
   * The mark-to-market P&L at the moment of sale is captured alongside so the
   * audit trail can show what an unrealised-reward rule WOULD have paid — which
   * is the comparison the operator needs to see, not a number to learn from.
   */
  private bookSellFill(f: EquityFill, s: TradingSession): void {
    const key = instrumentKey(f);
    const pos = this.positions.get(key);
    if (pos === undefined) {
      this.log.error('trader.sell_without_position', { key, orderId: f.orderId });
      return;
    }
    const qty = Math.max(0, Math.min(f.qty, pos.qty));
    if (qty <= 0) return;
    const proceedsMinor = f.grossMinor - Math.max(0, f.costsMinor);
    const basisRelieved = pos.qty === qty ? pos.basisMinor : Math.floor((pos.basisMinor * qty) / pos.qty);
    const entryCostsRelieved = pos.qty === qty ? pos.entryCostsMinor : Math.floor((pos.entryCostsMinor * qty) / pos.qty);
    const markAtSale = qty * (this.marks.get(key) ?? f.unitPriceMinor) - basisRelieved;

    this.pending.push({
      roundTripId: pos.roundTripId,
      key,
      symbol: f.symbol,
      venue: f.venue,
      arm: pos.arm,
      qty,
      proceedsMinor,
      costsMinor: Math.max(0, f.costsMinor),
      basisMinor: basisRelieved,
      entryCostsMinor: entryCostsRelieved,
      entryDayUtc: pos.entryDayUtc,
      soldDayUtc: f.fillDayUtc,
      settlesDayUtc: f.settlesDayUtc,
      markAtSaleMinor: markAtSale,
    });
    pos.qty -= qty;
    pos.basisMinor -= basisRelieved;
    pos.entryCostsMinor -= entryCostsRelieved;
    if (pos.qty <= 0) this.positions.delete(key);
    this.stats.sellsFilled++;
    this.stats.costsPaidMinor += Math.max(0, f.costsMinor);
    this.marks.set(key, f.unitPriceMinor);
    this.log.info('trader.sale_awaiting_settlement', {
      symbol: f.symbol,
      qty,
      proceedsMinor,
      basisMinor: basisRelieved,
      settlesDayUtc: f.settlesDayUtc,
      note: 'no reward is paid until the cash settles',
    });
  }

  /**
   * Cash landed. THIS is where the ledger records the sale, where realised P&L
   * exists, and where the bandit and the survival evaluator are told about it.
   */
  private settleDue(s: TradingSession): void {
    const due = this.pending.filter((p) => p.settlesDayUtc <= s.dayUtc);
    if (due.length === 0) return;
    this.pending = this.pending.filter((p) => p.settlesDayUtc > s.dayUtc);
    for (const p of due) {
      const grossMinor = p.proceedsMinor + p.costsMinor;
      this.deps.ledger.append({
        tick: s.tick,
        type: 'SALE',
        agentId: this.id,
        currency: this.cfg.baseCurrency,
        legs: [
          { account: 'cash', amount: p.proceedsMinor },
          { account: 'fees', amount: p.costsMinor },
          { account: 'revenue', amount: -grossMinor },
          ...(p.basisMinor > 0
            ? ([
                { account: 'cogs', amount: p.basisMinor },
                { account: 'inventory', amount: -p.basisMinor },
              ] as Leg[])
            : []),
        ],
        idempotencyKey: idempotencyKey(['trader.sale', this.id, p.roundTripId, p.soldDayUtc, p.qty, p.proceedsMinor]),
        meta: {
          paper: true,
          channel: this.executor.channel.name,
          venue: p.venue,
          symbol: p.symbol,
          sku: p.symbol,
          qty: p.qty,
          arm: p.arm,
          soldDayUtc: p.soldDayUtc,
          settlementDayUtc: p.settlesDayUtc,
          settlementTick: s.tick,
          strategyId: this.strategyId,
        },
      });

      const realisedMinor = p.proceedsMinor - p.basisMinor;
      const success = realisedMinor > 0;
      this.stats.realisedPnLMinor += realisedMinor;
      this.stats.roundTripsClosed++;
      this.closed.push({
        roundTripId: p.roundTripId,
        arm: p.arm,
        symbol: p.symbol,
        venue: p.venue,
        qty: p.qty,
        basisMinor: p.basisMinor,
        entryCostsMinor: p.entryCostsMinor,
        proceedsMinor: p.proceedsMinor,
        costsMinor: p.costsMinor,
        realisedMinor,
        markAtSaleMinor: p.markAtSaleMinor,
        entryDayUtc: p.entryDayUtc,
        soldDayUtc: p.soldDayUtc,
        settledDayUtc: p.settlesDayUtc,
        settlementTick: s.tick,
      });
      try {
        this.bandit.update(p.arm, success ? 1 : 0);
      } catch (err) {
        this.log.error('trader.bandit_update_failed', { arm: p.arm, error: err instanceof Error ? err.message : String(err) });
      }
      this.deps.memory.observe(`realisedPnL:${p.arm}`, realisedMinor);
      this.deps.memory.observe(`markVsRealised:${p.arm}`, p.markAtSaleMinor - realisedMinor);

      this.emit('SALE_FILLED', {
        channel: this.executor.channel.name,
        symbol: p.symbol,
        sku: p.symbol,
        venue: p.venue,
        qty: p.qty,
        grossMinor,
        feeMinor: p.costsMinor,
        cogsMinor: p.basisMinor,
        proceedsMinor: p.proceedsMinor,
        netMinor: realisedMinor,
        remaining: 0,
        disposition: 'sold',
        roundTripId: p.roundTripId,
        tick: s.tick,
      });

      // THE learning path. netMinor is REALISED cash minus REALISED basis.
      this.learn({
        strategyId: `${this.strategyId}/${p.arm}`,
        agentId: this.id,
        tick: s.tick,
        netMinor: realisedMinor,
        success,
        meta: {
          kind: 'round-trip',
          arm: p.arm,
          symbol: p.symbol,
          venue: p.venue,
          qty: p.qty,
          basisMinor: p.basisMinor,
          proceedsMinor: p.proceedsMinor,
          costsMinor: p.costsMinor,
          realisedMinor,
          soldDayUtc: p.soldDayUtc,
          settledDayUtc: p.settlesDayUtc,
          // Side by side, so the audit trail shows what an unrealised-reward
          // rule would have paid. Recorded, never learned from.
          markAtSaleMinor: p.markAtSaleMinor,
          rewardBasis: 'realised-at-settlement',
        },
      });
    }
    this.persistBandit();
  }

  // --------------------------------------------------------------- decision --

  private async decide(inst: Instrument, s: TradingSession): Promise<void> {
    const key = instrumentKey(inst);
    const bars = await this.feed.bars(inst.symbol, inst.venue, this.historyFrom(s.dayUtc), s.dayUtc);
    const usable = bars.filter((b) => b.dayUtc <= s.dayUtc);
    if (usable.length === 0) {
      this.log.debug('trader.no_bars', { symbol: inst.symbol, day: s.dayUtc });
      return;
    }
    const today = usable[usable.length - 1] as Bar;
    if (today.dayUtc !== s.dayUtc) {
      // No bar for this session: the venue was closed or the data is missing.
      // Marking on a stale bar is fine; trading on one is not.
      this.log.debug('trader.no_bar_for_session', { symbol: inst.symbol, day: s.dayUtc, last: today.dayUtc });
      return;
    }
    this.marks.set(key, today.closeMinor);
    const closes = usable.map((b) => b.closeMinor);
    const pos = this.positions.get(key);
    const holding = pos !== undefined;
    const arm: StrategyArm = holding ? (pos as OpenPosition).arm : this.armThisSession;
    const sig = strategySignal(arm, closes, holding, this.params);

    // The final session closes the book so the run has a realised number rather
    // than an open position and a story about what it might have been worth.
    const forceExit = s.finalSession === true && holding;
    const action: SignalAction = forceExit ? 'EXIT' : sig.action;

    if (action === 'ENTER' && !holding) {
      await this.enter(inst, s, today, sig);
      return;
    }
    if (action === 'EXIT' && holding) {
      await this.exit(inst, s, today, sig, forceExit ? 'final-session-close-out' : 'signal');
      return;
    }
    this.explain(s, inst, arm, sig, {
      action: 'HOLD',
      note: forceExit ? 'final session' : sig.reason,
      qty: pos?.qty ?? 0,
    });
  }

  private historyFrom(dayUtc: string): string {
    const d = new Date(`${dayUtc}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - this.historyDays);
    return d.toISOString().slice(0, 10);
  }

  private async enter(inst: Instrument, s: TradingSession, bar: Bar, sig: StrategySignal): Promise<void> {
    const key = instrumentKey(inst);
    // The expected fill price is TODAY's close standing in for TOMORROW's open,
    // because tomorrow's open is not knowable today. The executor fills at the
    // real next open; the difference is slippage the cost model already carries.
    const expectedPrice = bar.closeMinor;
    const decision = sizePosition(
      {
        equityMinor: this.equityMinor(),
        exposureMinor: this.exposureMinor(),
        cashAvailableMinor: this.deps.budget.availableCash(this.id),
        unitPriceMinor: expectedPrice,
        perTradeCapMinor: this.cfg.budget.perTradeCapMinor,
      },
      this.sizing,
    );
    if (decision.refused) {
      this.stats.refusals++;
      this.explain(s, inst, sig.arm, sig, { action: 'REFUSED', note: decision.reason, qty: 0, sizing: decision });
      return;
    }

    // POLICY BEFORE EXECUTION, always, exactly as the scout does it.
    const total = money(decision.notionalMinor, this.cfg.baseCurrency);
    const opportunity: Opportunity = {
      id: `${key}:${s.dayUtc}`,
      channel: this.executor.channel.name,
      sku: inst.symbol,
      title: `${inst.symbol} on ${inst.venue}`,
      askPrice: money(expectedPrice, this.cfg.baseCurrency),
      estResaleValue: money(expectedPrice, this.cfg.baseCurrency),
      confidence: 0,
      ttlTicks: 1,
      meta: { venue: inst.venue, arm: sig.arm, signal: sig.value, threshold: sig.threshold },
    };
    try {
      this.deps.policy.checkBuy(this.executor.channel, opportunity, decision.qty, total, s.tick);
    } catch (err) {
      if (err instanceof PolicyDenied) {
        this.stats.refusals++;
        this.emit('POLICY_DENIED', { channel: this.executor.channel.name, sku: inst.symbol, code: err.code, reason: err.message, stage: 'buy', tick: s.tick });
        this.explain(s, inst, sig.arm, sig, { action: 'REFUSED', note: `policy: ${err.message}`, qty: 0, sizing: decision });
        return;
      }
      throw err;
    }

    // BUDGET. The reservation is released on every path that does not fill.
    let reservation;
    try {
      reservation = this.reserve('cash', decision.notionalMinor, s.tick);
    } catch (err) {
      if (err instanceof BudgetDenied) {
        this.stats.refusals++;
        this.emit('BUDGET_DENIED', { channel: this.executor.channel.name, sku: inst.symbol, code: err.code, amountMinor: decision.notionalMinor, tick: s.tick });
        this.explain(s, inst, sig.arm, sig, { action: 'REFUSED', note: `budget: ${err.message}`, qty: 0, sizing: decision });
        return;
      }
      throw err;
    }

    let settled = false;
    try {
      this.orderSeq++;
      const orderId = `${this.id}:${key}:${s.dayUtc}:${this.orderSeq}`;
      const idem = idempotencyKey(['trader.order', this.id, orderId]);
      const roundTripId = newId('rt');
      const order: EquityOrderRequest = {
        orderId,
        symbol: inst.symbol,
        venue: inst.venue,
        side: 'BUY',
        qty: decision.qty,
        decidedDayUtc: s.dayUtc,
        idempotencyKey: idem,
        meta: { arm: sig.arm, roundTripId, signal: sig.value, threshold: sig.threshold },
      };
      this.decidedBy.set(orderId, s.dayUtc);
      await this.executor.submit(order);
      settled = true;
      this.commitReservation(reservation, decision.notionalMinor, { symbol: inst.symbol, venue: inst.venue });
      this.stats.ordersSubmitted++;
      this.positions.set(key, {
        key,
        symbol: inst.symbol,
        venue: inst.venue,
        arm: sig.arm,
        qty: 0,
        basisMinor: 0,
        entryCostsMinor: 0,
        entryDayUtc: s.dayUtc,
        entryTick: s.tick,
        roundTripId,
        entrySignal: { value: sig.value, threshold: sig.threshold, reason: sig.reason },
      });
      this.emit('BUY_REQUEST', {
        channel: this.executor.channel.name,
        symbol: inst.symbol,
        venue: inst.venue,
        qty: decision.qty,
        totalMinor: decision.notionalMinor,
        decidedDayUtc: s.dayUtc,
        arm: sig.arm,
        tick: s.tick,
      });
      this.explain(s, inst, sig.arm, sig, { action: 'ENTER', note: 'order queued for the next session open', qty: decision.qty, sizing: decision, roundTripId });
    } finally {
      if (!settled) this.releaseReservation(reservation);
    }
  }

  private async exit(inst: Instrument, s: TradingSession, bar: Bar, sig: StrategySignal, why: string): Promise<void> {
    const key = instrumentKey(inst);
    const pos = this.positions.get(key);
    if (pos === undefined || pos.qty <= 0) return;

    const offer: Offer = {
      id: `${key}:${s.dayUtc}:exit`,
      holdingId: pos.roundTripId,
      channel: this.executor.channel.name,
      sku: inst.symbol,
      title: `${inst.symbol} on ${inst.venue}`,
      price: money(bar.closeMinor, this.cfg.baseCurrency),
      qty: pos.qty,
      createdTick: s.tick,
      variant: pos.arm,
      meta: { venue: inst.venue, why },
    };
    try {
      this.deps.policy.checkSell(this.executor.channel, offer, s.tick);
    } catch (err) {
      if (err instanceof PolicyDenied) {
        this.stats.refusals++;
        this.emit('POLICY_DENIED', { channel: this.executor.channel.name, sku: inst.symbol, code: err.code, reason: err.message, stage: 'sell', tick: s.tick });
        this.explain(s, inst, pos.arm, sig, { action: 'REFUSED', note: `policy: ${err.message}`, qty: pos.qty });
        return;
      }
      throw err;
    }

    if (why === 'final-session-close-out') {
      // No next open exists inside the window: liquidate at this close, pay the
      // exit costs, and settle it here — the run ends with a realised number.
      const fill = await this.executor.closeOut({
        symbol: inst.symbol,
        venue: inst.venue,
        qty: pos.qty,
        dayUtc: s.dayUtc,
        idempotencyKey: idempotencyKey(['trader.closeout', this.id, key, s.dayUtc]),
      });
      this.bookSellFill({ ...fill, settlesDayUtc: fill.settlesDayUtc <= s.dayUtc ? fill.settlesDayUtc : s.dayUtc }, s);
      this.settleDue(s);
      this.explain(s, inst, pos.arm, sig, { action: 'EXIT', note: `${why} (marked out at the close, exit costs charged)`, qty: fill.qty, roundTripId: pos.roundTripId });
      return;
    }

    this.orderSeq++;
    const orderId = `${this.id}:${key}:${s.dayUtc}:${this.orderSeq}`;
    const order: EquityOrderRequest = {
      orderId,
      symbol: inst.symbol,
      venue: inst.venue,
      side: 'SELL',
      qty: pos.qty,
      decidedDayUtc: s.dayUtc,
      idempotencyKey: idempotencyKey(['trader.order', this.id, orderId]),
      meta: { arm: pos.arm, roundTripId: pos.roundTripId, why, signal: sig.value, threshold: sig.threshold },
    };
    this.decidedBy.set(orderId, s.dayUtc);
    await this.executor.submit(order);
    this.stats.ordersSubmitted++;
    this.explain(s, inst, pos.arm, sig, { action: 'EXIT', note: why, qty: pos.qty, roundTripId: pos.roundTripId });
  }

  /**
   * EVERY DECISION IS EXPLAINED. The rationale goes into episodic memory with
   * the arm, the signal's actual value, the threshold it was compared against,
   * the size chosen and which cap chose it. A losing run has to be explicable
   * afterwards, not merely regrettable — and with the seeded RNG the whole run
   * replays byte for byte from these records.
   */
  private explain(
    s: TradingSession,
    inst: Instrument,
    arm: StrategyArm,
    sig: StrategySignal,
    outcome: { action: string; note: string; qty: number; sizing?: SizeDecision; roundTripId?: string },
  ): void {
    try {
      this.deps.memory.remember({
        tick: s.tick,
        kind: 'trade-decision',
        net: 0,
        success: outcome.action !== 'REFUSED',
        meta: {
          dayUtc: s.dayUtc,
          venue: inst.venue,
          symbol: inst.symbol,
          arm,
          action: outcome.action,
          signalValue: sig.value,
          signalThreshold: sig.threshold,
          signalReady: sig.ready,
          signalReason: sig.reason,
          qty: outcome.qty,
          notionalMinor: outcome.sizing?.notionalMinor ?? 0,
          sizingBinding: outcome.sizing?.binding ?? null,
          sizingReason: outcome.sizing?.reason ?? null,
          equityMinor: this.equityMinor(),
          exposureMinor: this.exposureMinor(),
          roundTripId: outcome.roundTripId ?? null,
          note: outcome.note,
        },
      });
    } catch (err) {
      this.log.error('trader.explain_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    this.log.info('trader.decision', {
      day: s.dayUtc,
      venue: inst.venue,
      symbol: inst.symbol,
      arm,
      action: outcome.action,
      signal: sig.value,
      threshold: sig.threshold,
      qty: outcome.qty,
      note: outcome.note,
    });
  }

  // ------------------------------------------------------------ persistence --

  /**
   * RESUMABILITY. The container may restart mid-run; the ledger and the
   * MemoryStore are the durable state, and everything the agent needs to carry
   * on — open positions, unsettled sales, the bandit posterior, the fills it has
   * already booked — is written through them on every session.
   */
  private persist(): void {
    try {
      const state: PersistedState = {
        positions: this.openPositions(),
        pending: this.pendingSettlements(),
        closed: this.closedRoundTrips(),
        stats: this.traderStats(),
        seenFills: [...this.seenFills].slice(-SEEN_FILL_CAP),
        lastSessionDay: this.lastSessionDay,
      };
      this.deps.memory.setFact(STATE_FACT, state);
      this.deps.memory.setFact('trader.marks', Object.fromEntries(this.marks));
      this.deps.memory.setFact('trader.decidedBy', Object.fromEntries(this.decidedBy));
      this.persistBandit();
      this.deps.memory.flush();
    } catch (err) {
      this.log.error('trader.persist_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private persistBandit(): void {
    try {
      this.deps.memory.setFact(BANDIT_FACT, this.bandit.toJSON());
      this.deps.memory.setFact('trader.armWeights', this.bandit.weights());
    } catch (err) {
      this.log.error('trader.bandit_persist_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private restore(): void {
    const saved = this.deps.memory.getFact<PersistedState | null>(STATE_FACT, null);
    if (saved === null || typeof saved !== 'object') return;
    for (const p of Array.isArray(saved.positions) ? saved.positions : []) {
      if (p && typeof p.key === 'string') this.positions.set(p.key, { ...p });
    }
    this.pending = Array.isArray(saved.pending) ? saved.pending.map((p) => ({ ...p })) : [];
    this.closed = Array.isArray(saved.closed) ? saved.closed.map((c) => ({ ...c })) : [];
    if (saved.stats && typeof saved.stats === 'object') this.stats = { ...this.stats, ...saved.stats };
    for (const f of Array.isArray(saved.seenFills) ? saved.seenFills : []) if (typeof f === 'string') this.seenFills.add(f);
    this.lastSessionDay = typeof saved.lastSessionDay === 'string' ? saved.lastSessionDay : null;
    const marks = this.deps.memory.getFact<Record<string, number>>('trader.marks', {});
    for (const [k, v] of Object.entries(marks ?? {})) if (typeof v === 'number') this.marks.set(k, v);
    const decided = this.deps.memory.getFact<Record<string, string>>('trader.decidedBy', {});
    for (const [k, v] of Object.entries(decided ?? {})) if (typeof v === 'string') this.decidedBy.set(k, v);
    this.log.warn('trader.resumed', {
      positions: this.positions.size,
      pending: this.pending.length,
      lastSessionDay: this.lastSessionDay,
      roundTripsClosed: this.stats.roundTripsClosed,
    });
  }

  /** The session this agent last completed, or null. Used to resume a run. */
  get resumedFromDay(): string | null {
    return this.lastSessionDay;
  }

  protected override async onTerminate(reason: string): Promise<void> {
    // An unsettled sale is real cash that is still coming; an open position is
    // a loss the successor must be told about. Both are written down, neither
    // is quietly forgotten.
    this.deps.memory.setFact('trader.terminatedWith', {
      reason,
      openPositions: this.openPositions(),
      pendingSettlements: this.pendingSettlements(),
      stats: this.traderStats(),
    });
    this.persist();
  }

  override handoverState(): Record<string, unknown> {
    return {
      openPositions: this.openPositions(),
      pendingSettlements: this.pendingSettlements(),
      armWeights: this.bandit.weights(),
    };
  }
}

/** Factory shape the registry uses when it respawns a trader. */
export function traderFactory(opts: TraderOptions) {
  return (id: AgentId, strategyId: string, deps: AgentDeps): TraderAgent => new TraderAgent(id, strategyId, deps, opts);
}

/** Strategy families the registry can choose between when respawning. */
export const TRADER_STRATEGIES: readonly string[] = Object.freeze(['equities-paper']);

export function newTraderId(): AgentId {
  return newId('trader');
}
