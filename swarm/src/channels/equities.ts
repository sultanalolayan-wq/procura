/**
 * channels/equities.ts — paper equities trading against REAL bars (SPEC §6).
 *
 * NO SAME-BAR LOOKAHEAD, and that is the whole point of this file. An agent that
 * decides at the close of session D may only be filled on session D+1: a market
 * order fills at D+1's OPEN, a limit order fills only if D+1's actual [low,high]
 * range contains the limit. Every price this channel touches is an integer minor
 * amount; a fill is always clamped into the real bar's range; the cost model is
 * fully parameterised and nothing is buried as a magic number.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — no shorting, no margin, no leverage, no
 * derivatives, no CFDs (SPEC §8). (a) They are what turns a losing strategy into a
 * total loss: without them the worst case is the capital committed, with them it
 * is unbounded. (b) Margin interest raises riba, and CFDs raise gharar concerns,
 * for a KSA operator — that is a question for counsel, not for a trading loop.
 * (c) None of them are needed to answer the only question being asked, which is
 * whether a strategy has an edge over buy-and-hold. A sell of more than the shares
 * actually held throws; there is no code path that creates a negative position.
 *
 * ORDERS NEVER REACH A SOCKET. This module imports a PriceFeed (read-only) and
 * nothing else external. Fills are computed here, locally, from bars. There is no
 * http/https/net import in this file or anything it pulls in on the execution path,
 * and test/equities.test.ts asserts that against the BUILT JavaScript.
 *
 * Callers: the trading agent and the run controller (src/agents/*, not this scope).
 */

import { AdapterError, AresError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { convert, money, type Currency, type Minor, type Money } from '../core/money.js';
import type { Fill, Holding, Offer, Opportunity } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import { nullLogger } from '../core/logger.js';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext } from './adapter.js';
import { SessionCalendar } from '../market/calendar.js';
import {
  assertDayUtc,
  assertSymbol,
  assertVenue,
  cmpDay,
  EPOCH_FLOOR_DAY,
  VENUE_CURRENCY,
  type Bar,
  type PriceFeed,
  type Venue,
} from '../market/feed.js';

/* ------------------------------------------------------------- the cost model */

/**
 * Every cost that separates a printed price from the cash that actually moves.
 * All of it is configuration (ARES_MARKET_<VENUE>_*), all of it is reported, and
 * none of it is optional: a backtest without costs is a slideshow.
 */
export interface VenueCostModel {
  /** Brokerage commission per SIDE, in basis points of notional. */
  commissionBps: number;
  /** Floor on the per-side commission. Small trades are dominated by this. */
  minCommissionMinor: Minor;
  /**
   * Half the quoted bid-ask spread, in bps, charged adversely on every fill:
   * you buy at the offer and sell at the bid, never at the mid.
   */
  halfSpreadBps: number;
  /** Additional adverse move between decision and execution, in bps. */
  slippageBps: number;
  /** Settlement delay in SESSIONS (not calendar days). T+2 is the default. */
  settlementSessions: number;
  /** Minimum tradeable increment in shares. 1 = whole shares. */
  lotSize: number;
}

/**
 * UNVERIFIED ASSUMPTIONS, PENDING OPERATOR CONFIRMATION WITH THEIR OWN BROKER.
 * These defaults are plausible retail figures, not quoted tariffs, and no broker's
 * schedule has been read or verified here. They are deliberately pessimistic
 * rather than flattering — an optimistic cost model is how a backtest lies about
 * a strategy that only works for free.
 *
 * US: large-cap S&P names quote in pennies on huge size, so 2bps of half-spread is
 * generous to the strategy already; commission at 10bps with a 1.00 minimum models
 * a percentage-fee broker rather than a zero-commission one, because zero-commission
 * order flow is paid for in the spread and assuming both away at once is wishful.
 *
 * TADAWUL: wider quoted spreads and a higher headline commission than US retail,
 * hence 5bps half-spread and 16bps commission with a 1.00 SAR floor. The operator
 * must replace these with their actual broker's schedule before believing a number.
 */
export const DEFAULT_COSTS: Readonly<Record<Venue, VenueCostModel>> = Object.freeze({
  US: Object.freeze({
    commissionBps: 10,
    minCommissionMinor: 100, // USD 1.00
    halfSpreadBps: 2,
    slippageBps: 3,
    settlementSessions: 2,
    lotSize: 1,
  }),
  TADAWUL: Object.freeze({
    commissionBps: 16,
    minCommissionMinor: 100, // SAR 1.00
    halfSpreadBps: 5,
    slippageBps: 5,
    settlementSessions: 2,
    lotSize: 1,
  }),
});

export const COST_ASSUMPTION_NOTE =
  'UNVERIFIED ASSUMPTION, PENDING OPERATOR CONFIRMATION: commission, minimum commission, ' +
  'half-spread, slippage and settlement delay are configuration (ARES_MARKET_<VENUE>_*). The ' +
  'shipped defaults are plausible retail figures chosen to be pessimistic rather than ' +
  'flattering; no broker tariff has been read or verified. Replace them with your broker\'s ' +
  'actual schedule before treating any P&L figure as meaningful.';

/**
 * CONFIGURED ASSUMPTION — NOT A LAW OF NATURE. The SAR/USD rate is a configuration
 * parameter (ARES_MARKET_FX_SAR_PER_USD), exactly like the VAT rate in ksa_ecom.ts.
 * The riyal's peg to the dollar is a policy of the Saudi Central Bank; policies are
 * changed, and a peg that has held for decades is still a decision rather than a
 * constant. Nothing in this code should be read as a statement that the rate is
 * fixed, current, or the rate the operator would actually be dealt.
 */
export const FX_ASSUMPTION_NOTE =
  'CONFIGURABLE ASSUMPTION, PENDING OPERATOR CONFIRMATION: SAR/USD is taken from ' +
  'ARES_MARKET_FX_SAR_PER_USD, a single fixed rate applied to every conversion. The peg is a ' +
  'central-bank policy, not a constant; no live rate is fetched, no bid/ask spread on the ' +
  'conversion is modelled, and no forward or hedging cost is modelled. Cross-currency P&L is ' +
  'therefore only as good as this one number.';

export const EQUITIES_TOS_NOTE =
  'PAPER ONLY: no broker, no exchange and no order-routing venue is contacted, ever. This ' +
  'adapter models fills locally against historical or operator-supplied bars and has no network ' +
  'path from an order to anything. The market-data feed is READ-ONLY (GET only, allowlisted ' +
  'hosts); reading prices from a provider is subject to that provider\'s terms of use, which the ' +
  'operator must confirm. Nothing here constitutes investment advice or an offer to deal.';

/* -------------------------------------------------------------- pure fill maths */

export type Side = 'BUY' | 'SELL';

export interface FillModelResult {
  filled: boolean;
  /** Integer minor units per share. Meaningless when filled is false. */
  priceMinor: Minor;
  /** The price before spread/slippage, for cost attribution. */
  referenceMinor: Minor;
  /** priceMinor - referenceMinor, signed against the trader. */
  implicitCostMinor: Minor;
  reason: string;
}

function bpsUp(x: Minor, bps: number): Minor {
  return Math.ceil(x + (x * bps) / 10_000);
}

function bpsDown(x: Minor, bps: number): Minor {
  return Math.max(1, Math.floor(x - (x * bps) / 10_000));
}

/**
 * The fill rule, in one place, as a pure function of the EXECUTION bar.
 *
 * - A market order fills at the bar's OPEN, moved adversely by half-spread +
 *   slippage. It never fills at the close of the bar the decision was made on,
 *   because that bar is not passed to this function at all.
 * - A limit order fills ONLY if the bar's real range contains the limit: a buy
 *   needs low <= limit, a sell needs high >= limit. If the open is already better
 *   than the limit you get the open (price improvement is real); otherwise you get
 *   the limit. The adverse adjustment can never push the fill through the limit —
 *   a limit order that filled at a worse price than its limit is not a limit order.
 * - Every fill is finally clamped into [low, high]. A price outside the bar's own
 *   range did not happen.
 */
export function modelFill(side: Side, bar: Bar, limitMinor: Minor | null, costs: VenueCostModel): FillModelResult {
  const adverseBps = costs.halfSpreadBps + costs.slippageBps;
  const clamp = (p: Minor): Minor => Math.min(Math.max(p, bar.lowMinor), bar.highMinor);
  if (limitMinor !== null && (!Number.isSafeInteger(limitMinor) || limitMinor <= 0)) {
    throw new AresError('MARKET_BAD_LIMIT', `modelFill: limit must be a positive integer minor amount`, {
      limitMinor,
      side,
    });
  }
  if (side === 'BUY') {
    if (limitMinor === null) {
      const ref = bar.openMinor;
      const px = clamp(bpsUp(ref, adverseBps));
      return { filled: true, priceMinor: px, referenceMinor: ref, implicitCostMinor: px - ref, reason: 'market@open' };
    }
    if (bar.lowMinor > limitMinor) {
      return {
        filled: false,
        priceMinor: 0,
        referenceMinor: 0,
        implicitCostMinor: 0,
        reason: `limit ${limitMinor} below the session low ${bar.lowMinor} — untouched`,
      };
    }
    const ref = Math.min(bar.openMinor, limitMinor);
    const px = clamp(Math.min(bpsUp(ref, adverseBps), limitMinor));
    return { filled: true, priceMinor: px, referenceMinor: ref, implicitCostMinor: px - ref, reason: 'limit' };
  }
  if (limitMinor === null) {
    const ref = bar.openMinor;
    const px = clamp(bpsDown(ref, adverseBps));
    return { filled: true, priceMinor: px, referenceMinor: ref, implicitCostMinor: ref - px, reason: 'market@open' };
  }
  if (bar.highMinor < limitMinor) {
    return {
      filled: false,
      priceMinor: 0,
      referenceMinor: 0,
      implicitCostMinor: 0,
      reason: `limit ${limitMinor} above the session high ${bar.highMinor} — untouched`,
    };
  }
  const ref = Math.max(bar.openMinor, limitMinor);
  const px = clamp(Math.max(bpsDown(ref, adverseBps), limitMinor));
  return { filled: true, priceMinor: px, referenceMinor: ref, implicitCostMinor: ref - px, reason: 'limit' };
}

/** Per-side commission: bps of notional, rounded UP, floored at the minimum. */
export function commissionMinor(notionalMinor: Minor, costs: VenueCostModel): Minor {
  if (!Number.isSafeInteger(notionalMinor)) {
    throw new AresError('MARKET_BAD_NOTIONAL', `commissionMinor: notional must be an integer`, { notionalMinor });
  }
  const pct = Math.ceil((Math.abs(notionalMinor) * costs.commissionBps) / 10_000);
  return Math.max(costs.minCommissionMinor, pct);
}

/** Rates table for core/money.convert from the single configured SAR/USD rate. */
export function fxRates(sarPerUsd: number): Record<string, number> {
  if (!Number.isFinite(sarPerUsd) || sarPerUsd <= 0) {
    throw new AresError('MARKET_BAD_FX', `fxRates: SAR per USD must be > 0, got ${String(sarPerUsd)}`, { sarPerUsd });
  }
  return { 'USD->SAR': sarPerUsd, 'SAR->USD': 1 / sarPerUsd };
}

/** Convert with the configured rate. See FX_ASSUMPTION_NOTE before believing it. */
export function toCurrency(m: Money, to: Currency, sarPerUsd: number): Money {
  return convert(m, to, fxRates(sarPerUsd));
}

/* ------------------------------------------------------------------- channel */

export interface EquitiesChannelOptions {
  venue: Venue;
  feed: PriceFeed;
  calendar: SessionCalendar;
  /** The first SESSION of the run. tick 0 is the close of this day. */
  startDay: string;
  /** The instrument universe for this venue. */
  symbols: readonly string[];
  costs?: Partial<VenueCostModel>;
  /** SAR per USD. See FX_ASSUMPTION_NOTE. */
  sarPerUsd?: number;
  /** How many past sessions of history scan() hands the agent. */
  historySessions?: number;
  logger?: Logger;
  /**
   * Refuse a decision call (scan/quote/demandSignal) at a tick where an order has
   * already executed. ON by default: it enforces decide-then-submit, so an agent
   * cannot learn the next session's open from its own first fill and then place a
   * second order on the same decision day with that knowledge.
   */
  oneDecisionPassPerTick?: boolean;
}

interface Position {
  qty: number;
  /** Total cost paid including commission, for realised-P&L attribution. */
  costMinor: Minor;
}

interface RestingSell {
  offerId: string;
  symbol: string;
  qty: number;
  limitMinor: Minor | null;
  placedTick: number;
  expiresAfterTick: number;
}

interface PendingFill {
  fill: Fill;
  settleTick: number;
}

export interface EquityTrade {
  symbol: string;
  venue: Venue;
  side: Side;
  qty: number;
  priceMinor: Minor;
  commissionMinor: Minor;
  implicitCostMinor: Minor;
  decisionDay: string;
  fillDay: string;
  decisionTick: number;
  fillTick: number;
  settleTick: number;
  settleDay: string;
  currency: Currency;
  /** Realised P&L net of both sides' costs. Only set on a SELL. */
  realisedMinor: Minor | null;
}

export const DEFAULT_HISTORY_SESSIONS = 60;

export class EquitiesChannel implements ChannelAdapter {
  readonly name: string;
  readonly venue: Venue;
  readonly currency: Currency;
  readonly costs: VenueCostModel;
  readonly capabilities: ChannelCapabilities;

  private ctx: ChannelContext | null = null;
  private log: Logger;
  private ready = false;
  private closed = false;
  private readonly cal: SessionCalendar;
  private readonly feed: PriceFeed;
  private readonly startDay: string;
  private readonly symbols: readonly string[];
  private readonly historySessions: number;
  private readonly sarPerUsd: number;
  private readonly oneDecisionPass: boolean;

  private readonly sessionDays: string[] = [];
  private readonly positions = new Map<string, Position>();
  private readonly reserved = new Map<string, number>();
  private readonly resting: RestingSell[] = [];
  private readonly pending: PendingFill[] = [];
  private readonly buyIdem = new Map<string, { holding: Holding; feeMinor: Minor }>();
  private readonly publishIdem = new Map<string, { offerId: string; feeMinor: Minor }>();
  private readonly trades: EquityTrade[] = [];
  private readonly expired: string[] = [];
  private executedAtTick = new Set<number>();
  private resolvedThroughTick = -1;
  private lastPollTick = -1;
  private totalCommissionMinor = 0;
  private totalImplicitMinor = 0;

  constructor(opts: EquitiesChannelOptions) {
    this.venue = assertVenue(opts.venue, 'EquitiesChannel');
    this.name = `equities_${this.venue.toLowerCase()}`;
    this.currency = VENUE_CURRENCY[this.venue];
    this.feed = opts.feed;
    this.cal = opts.calendar;
    this.startDay = assertDayUtc(opts.startDay, 'EquitiesChannel.startDay');
    this.symbols = opts.symbols.map((s) => assertSymbol(s, `EquitiesChannel(${this.venue}).symbols`));
    this.costs = Object.freeze({ ...DEFAULT_COSTS[this.venue], ...(opts.costs ?? {}) });
    this.sarPerUsd = opts.sarPerUsd ?? 3.75;
    this.historySessions = opts.historySessions ?? DEFAULT_HISTORY_SESSIONS;
    this.oneDecisionPass = opts.oneDecisionPassPerTick ?? true;
    this.log = opts.logger ?? nullLogger;
    this.validateCosts();
    this.capabilities = Object.freeze({
      canBuy: true,
      canSell: true,
      // FALSE, and deliberately so: there is no venue to protect. A "buy" here is
      // an arithmetic operation on a historical bar inside this process. Requiring
      // a human to approve a simulated fill would be theatre, and it would also
      // make the channel unusable (policy.checkChannel refuses an adapter that
      // needs approval when no approval channel exists).
      buyRequiresHumanApproval: false,
      tosNote: EQUITIES_TOS_NOTE,
      jurisdiction: this.venue === 'US' ? 'US' : 'SA',
    });
  }

  private validateCosts(): void {
    const c = this.costs;
    const bad = (m: string): never => {
      throw new AresError('MARKET_BAD_COSTS', `EquitiesChannel(${this.venue}): ${m}`, { costs: c, venue: this.venue });
    };
    if (!Number.isFinite(c.commissionBps) || c.commissionBps < 0) bad('commissionBps must be >= 0');
    if (!Number.isSafeInteger(c.minCommissionMinor) || c.minCommissionMinor < 0) bad('minCommissionMinor must be >= 0');
    if (!Number.isFinite(c.halfSpreadBps) || c.halfSpreadBps < 0) bad('halfSpreadBps must be >= 0');
    if (!Number.isFinite(c.slippageBps) || c.slippageBps < 0) bad('slippageBps must be >= 0');
    if (!Number.isInteger(c.settlementSessions) || c.settlementSessions < 0) bad('settlementSessions must be >= 0');
    if (!Number.isInteger(c.lotSize) || c.lotSize < 1) bad('lotSize must be >= 1');
  }

  /* --------------------------------------------------------------- lifecycle */

  async init(ctx: ChannelContext): Promise<void> {
    if (this.closed) {
      throw new AdapterError('ADAPTER_CLOSED', `${this.name}: cannot re-init a closed adapter`, { channel: this.name });
    }
    if (this.ready) return;
    this.ctx = ctx;
    this.log = ctx.logger.child({ channel: this.name });
    this.ready = true;
    this.log.info('equities channel initialised', {
      venue: this.venue,
      currency: this.currency,
      startDay: this.startDay,
      symbols: [...this.symbols],
      costs: this.costs,
      settlementSessions: this.costs.settlementSessions,
      holidaysConfigured: this.cal.holidaysOf(this.venue).length,
      costNote: COST_ASSUMPTION_NOTE,
      fxNote: FX_ASSUMPTION_NOTE,
      paper: true,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    await this.feed.close();
    this.log.info('equities channel closed', {
      trades: this.trades.length,
      commissionMinor: this.totalCommissionMinor,
      implicitCostMinor: this.totalImplicitMinor,
    });
  }

  private assertReady(op: string): void {
    if (!this.ready) {
      throw new AdapterError('ADAPTER_NOT_INITIALISED', `${this.name}.${op}(): init() must be awaited first`, {
        channel: this.name,
        op,
        closed: this.closed,
      });
    }
  }

  private assertDecisionPhase(op: string, tick: number): void {
    if (this.oneDecisionPass && this.executedAtTick.has(tick)) {
      throw new AdapterError(
        'MARKET_DECISION_AFTER_EXECUTION',
        `${this.name}.${op}(): an order has already executed at tick ${tick}. A decision taken after ` +
          `seeing this tick's own fill would be using the next session's price to decide on this ` +
          `session — decide first, then submit.`,
        { channel: this.name, op, tick },
      );
    }
  }

  /* ----------------------------------------------------------- session clock */

  /**
   * tick -> the SESSION DAY whose close that tick represents, for THIS venue.
   * Ten ticks is ten US sessions or ten Tadawul sessions, and those are different
   * calendar windows: that is why this is per-channel and not global.
   */
  sessionDay(tick: number): string {
    if (!Number.isInteger(tick) || tick < 0) {
      throw new AresError('MARKET_BAD_TICK', `${this.name}.sessionDay: tick must be a non-negative integer`, { tick });
    }
    if (this.sessionDays.length === 0) this.sessionDays.push(this.cal.sessionOnOrAfter(this.venue, this.startDay));
    while (this.sessionDays.length <= tick) {
      this.sessionDays.push(this.cal.nextSession(this.venue, this.sessionDays[this.sessionDays.length - 1] as string));
    }
    return this.sessionDays[tick] as string;
  }

  /** The session an order decided at `tick` can first be filled on. */
  executionDay(tick: number): string {
    return this.sessionDay(tick + 1);
  }

  private async barOn(symbol: string, day: string): Promise<Bar | null> {
    const got = await this.feed.bars(symbol, this.venue, day, day);
    return got.length === 0 ? null : (got[0] as Bar);
  }

  private async requireExecutionBar(symbol: string, tick: number, op: string): Promise<{ bar: Bar; day: string }> {
    const day = this.executionDay(tick);
    const bar = await this.barOn(symbol, day);
    if (bar === null) {
      throw new AdapterError(
        'MARKET_NEXT_BAR_UNAVAILABLE',
        `${this.name}.${op}: no bar for ${symbol} on ${day}, the next session after the tick-${tick} decision. ` +
          `In replay this means the data file is missing that session (a holiday not in the configured ` +
          `holiday list is the usual cause); in a forward run it means that session has not happened yet ` +
          `and the order must be resubmitted after it closes.`,
        { channel: this.name, symbol, day, tick, op },
      );
    }
    if (cmpDay(bar.dayUtc, this.sessionDay(tick)) <= 0) {
      // Defence in depth: the feed handed back a bar that is not strictly after
      // the decision day. That is a lookahead fill and it is refused here.
      throw new AresError(
        'MARKET_LOOKAHEAD_REFUSED',
        `${this.name}.${op}: refusing to fill ${symbol} on ${bar.dayUtc}, which is not after the ` +
          `decision session ${this.sessionDay(tick)}`,
        { channel: this.name, symbol, barDay: bar.dayUtc, decisionDay: this.sessionDay(tick), tick },
      );
    }
    return { bar, day };
  }

  /* ------------------------------------------------------------------- scan */

  /**
   * Opportunities priced at the DECISION session's close, with the trailing
   * history an agent needs to compute a signal. Nothing after `sessionDay(tick)`
   * is read, so a strategy cannot see the bar it will be filled on.
   */
  async scan(tick: number, budget: Money): Promise<Opportunity[]> {
    this.assertReady('scan');
    this.assertDecisionPhase('scan', tick);
    this.assertCurrency(budget, 'scan');
    const day = this.sessionDay(tick);
    const from = tick >= this.historySessions ? this.sessionDay(tick - this.historySessions) : EPOCH_FLOOR_DAY;
    const out: Opportunity[] = [];
    for (const symbol of this.symbols) {
      const hist = await this.feed.bars(symbol, this.venue, from, day);
      if (hist.length === 0) continue;
      const last = hist[hist.length - 1] as Bar;
      if (last.dayUtc !== day) {
        // No bar for this session: a closed venue or missing data. Not an
        // opportunity, and deliberately not a silent one either.
        this.log.debug('market.scan.no_bar', { symbol, day, newest: last.dayUtc });
        continue;
      }
      out.push({
        id: `${this.name}:${symbol}:${day}`,
        channel: this.name,
        sku: symbol,
        title: `${symbol} @ ${this.venue}`,
        askPrice: money(last.closeMinor, this.currency),
        estResaleValue: money(last.closeMinor, this.currency),
        confidence: 0,
        ttlTicks: 1,
        meta: {
          venue: this.venue,
          decisionDay: day,
          decisionTick: tick,
          closes: hist.map((b) => b.closeMinor),
          highs: hist.map((b) => b.highMinor),
          lows: hist.map((b) => b.lowMinor),
          days: hist.map((b) => b.dayUtc),
          volume: last.volume,
          paper: true,
          mode: 'PAPER',
        },
      });
    }
    return out;
  }

  private assertCurrency(m: Money, where: string): void {
    if (m.currency !== this.currency) {
      throw new AdapterError('ADAPTER_CURRENCY_MISMATCH', `${this.name}.${where}(): expected ${this.currency}, got ${m.currency}`, {
        channel: this.name,
        expected: this.currency,
        actual: m.currency,
        where,
      });
    }
  }

  /**
   * Indicative all-in cost of one share if the order were submitted now: the
   * decision close moved adversely plus commission. Indicative is the operative
   * word — the real fill comes from the NEXT session's bar, which does not exist
   * yet as far as this method is concerned.
   */
  async quote(o: Opportunity, tick: number): Promise<{ unitCost: Money; feeMinor: Minor }> {
    this.assertReady('quote');
    this.assertDecisionPhase('quote', tick);
    this.assertCurrency(o.askPrice, 'quote');
    const indicative = bpsUp(o.askPrice.amount, this.costs.halfSpreadBps + this.costs.slippageBps);
    return { unitCost: money(indicative, this.currency), feeMinor: commissionMinor(indicative, this.costs) };
  }

  /* -------------------------------------------------------------------- buy */

  /**
   * Submit a BUY decided at the close of `sessionDay(tick)`; it fills on
   * `sessionDay(tick+1)`. `o.meta.limitMinor`, if present, makes it a limit order,
   * and a limit that the next session's range never touches DOES NOT FILL — that
   * is an ordinary outcome, signalled by MARKET_LIMIT_NOT_FILLED, not a failure.
   * Use `wouldFill()` first if you would rather branch than catch.
   */
  async buy(o: Opportunity, qty: number, tick: number, idem: string): Promise<{ holding: Holding; feeMinor: Minor }> {
    this.assertReady('buy');
    this.assertCurrency(o.askPrice, 'buy');
    const prior = this.buyIdem.get(idem);
    if (prior !== undefined) return prior;
    const symbol = assertSymbol(o.sku, `${this.name}.buy`);
    this.assertLot(qty, 'buy');
    const { bar, day } = await this.requireExecutionBar(symbol, tick, 'buy');
    const limit = this.limitOf(o.meta);
    const f = modelFill('BUY', bar, limit, this.costs);
    if (!f.filled) {
      throw new AdapterError(
        'MARKET_LIMIT_NOT_FILLED',
        `${this.name}.buy: ${symbol} limit order did not fill on ${day} — ${f.reason}`,
        { channel: this.name, symbol, day, limitMinor: limit, low: bar.lowMinor, high: bar.highMinor, tick },
      );
    }
    const notional = f.priceMinor * qty;
    const fee = commissionMinor(notional, this.costs);
    const pos = this.positions.get(symbol) ?? { qty: 0, costMinor: 0 };
    pos.qty += qty;
    pos.costMinor += notional + fee;
    this.positions.set(symbol, pos);
    this.totalCommissionMinor += fee;
    this.totalImplicitMinor += f.implicitCostMinor * qty;
    const fillTick = tick + 1;
    this.executedAtTick.add(tick);
    const trade: EquityTrade = {
      symbol,
      venue: this.venue,
      side: 'BUY',
      qty,
      priceMinor: f.priceMinor,
      commissionMinor: fee,
      implicitCostMinor: f.implicitCostMinor * qty,
      decisionDay: this.sessionDay(tick),
      fillDay: day,
      decisionTick: tick,
      fillTick,
      // A purchase is paid for on settlement too, but cash is committed at once
      // and the shares cannot be sold before they exist. Modelling the cash as
      // leaving immediately is the conservative direction.
      settleTick: fillTick,
      settleDay: day,
      currency: this.currency,
      realisedMinor: null,
    };
    this.trades.push(trade);
    const holding: Holding = {
      id: newId('hold'),
      channel: this.name,
      sku: symbol,
      qty,
      unitCost: money(f.priceMinor, this.currency),
      acquiredTick: fillTick,
      meta: {
        venue: this.venue,
        paper: true,
        mode: 'PAPER',
        decisionDay: trade.decisionDay,
        fillDay: day,
        fillReason: f.reason,
        barOpenMinor: bar.openMinor,
        barLowMinor: bar.lowMinor,
        barHighMinor: bar.highMinor,
        limitMinor: limit,
        commissionMinor: fee,
        implicitCostMinor: trade.implicitCostMinor,
        costNote: COST_ASSUMPTION_NOTE,
      },
    };
    this.log.info('market.fill', {
      side: 'BUY',
      symbol,
      qty,
      priceMinor: f.priceMinor,
      decisionDay: trade.decisionDay,
      fillDay: day,
      feeMinor: fee,
      paper: true,
    });
    const result = { holding, feeMinor: fee };
    this.buyIdem.set(idem, result);
    return result;
  }

  private assertLot(qty: number, op: string): void {
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new AdapterError('MARKET_BAD_QTY', `${this.name}.${op}: qty must be a positive integer, got ${String(qty)}`, {
        channel: this.name,
        qty,
      });
    }
    if (qty % this.costs.lotSize !== 0) {
      throw new AdapterError('MARKET_BAD_LOT', `${this.name}.${op}: qty ${qty} is not a multiple of lotSize ${this.costs.lotSize}`, {
        channel: this.name,
        qty,
        lotSize: this.costs.lotSize,
      });
    }
  }

  private limitOf(meta: Record<string, unknown>): Minor | null {
    const v = meta['limitMinor'];
    if (v === undefined || v === null) return null;
    if (!Number.isSafeInteger(v) || (v as number) <= 0) {
      throw new AresError('MARKET_BAD_LIMIT', `${this.name}: meta.limitMinor must be a positive integer minor amount`, {
        limitMinor: v,
      });
    }
    return v as number;
  }

  /** Would this order fill on the next session, given the bar? No side effects. */
  async wouldFill(side: Side, symbol: string, tick: number, limitMinor: Minor | null): Promise<FillModelResult> {
    this.assertReady('wouldFill');
    const { bar } = await this.requireExecutionBar(assertSymbol(symbol, 'wouldFill'), tick, 'wouldFill');
    return modelFill(side, bar, limitMinor, this.costs);
  }

  /* ---------------------------------------------------------------- publish */

  /**
   * Submit a SELL. `offer.price` is the LIMIT unless `offer.meta.orderType` is
   * 'market'. It rests from the next session until `meta.ttlSessions` (default 1)
   * sessions have passed, and is resolved by poll(). Shares are RESERVED at submit
   * time, so two sells can never exceed the position — this is where "no shorting"
   * is enforced, structurally, rather than by hoping the agent behaves.
   */
  async publish(offer: Offer, tick: number, idem: string): Promise<{ offerId: string; feeMinor: Minor }> {
    this.assertReady('publish');
    this.assertCurrency(offer.price, 'publish');
    const prior = this.publishIdem.get(idem);
    if (prior !== undefined) return prior;
    const symbol = assertSymbol(offer.sku, `${this.name}.publish`);
    const qty = offer.qty;
    this.assertLot(qty, 'publish');
    const held = this.positions.get(symbol)?.qty ?? 0;
    const reserved = this.reserved.get(symbol) ?? 0;
    if (qty > held - reserved) {
      throw new AdapterError(
        'MARKET_NO_SHORTING',
        `${this.name}.publish: cannot sell ${qty} ${symbol} — ${held} held, ${reserved} already committed to ` +
          `resting orders. Shorting, margin and leverage are deliberately not implemented (SPEC §8).`,
        { channel: this.name, symbol, qty, held, reserved },
      );
    }
    const isMarket = offer.meta['orderType'] === 'market';
    const ttlRaw = offer.meta['ttlSessions'];
    const ttl = Number.isInteger(ttlRaw) && (ttlRaw as number) >= 1 ? (ttlRaw as number) : 1;
    const offerId = `${this.name}:${offer.id}`;
    this.reserved.set(symbol, reserved + qty);
    this.resting.push({
      offerId,
      symbol,
      qty,
      limitMinor: isMarket ? null : offer.price.amount,
      placedTick: tick,
      expiresAfterTick: tick + ttl,
    });
    offer.meta['venue'] = this.venue;
    offer.meta['paper'] = true;
    offer.meta['mode'] = 'PAPER';
    offer.meta['decisionDay'] = this.sessionDay(tick);
    offer.meta['earliestFillDay'] = this.executionDay(tick);
    offer.meta['orderType'] = isMarket ? 'market' : 'limit';
    // No fee is charged for SUBMITTING an order. Commission is charged on the
    // fill, per side, and an order that never fills costs nothing but opportunity.
    const result = { offerId, feeMinor: 0 };
    this.publishIdem.set(idem, result);
    this.log.info('market.order.submitted', {
      side: 'SELL',
      symbol,
      qty,
      limitMinor: isMarket ? null : offer.price.amount,
      decisionDay: this.sessionDay(tick),
      earliestFillDay: this.executionDay(tick),
      paper: true,
    });
    return result;
  }

  /* ------------------------------------------------------------------- poll */

  /**
   * Resolve resting sells against every session that has completed since the last
   * poll, then release the cash of fills whose T+`settlementSessions` has arrived.
   *
   * Cash from a sale is NOT available on the fill day. `Fill.tick` is the
   * SETTLEMENT tick, exactly as the marketplace channel does it, and a fill is not
   * returned at all until that tick has come. A strategy that appears to compound
   * daily on unsettled proceeds is trading money it does not have.
   */
  async poll(tick: number): Promise<Fill[]> {
    this.assertReady('poll');
    this.lastPollTick = tick;
    for (let s = Math.max(this.resolvedThroughTick + 1, 1); s <= tick; s++) await this.resolveSession(s);
    this.resolvedThroughTick = Math.max(this.resolvedThroughTick, tick);
    const due: Fill[] = [];
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i] as PendingFill;
      if (p.settleTick <= tick) {
        due.push(p.fill);
        this.pending.splice(i, 1);
      }
    }
    return due.sort((a, b) => a.tick - b.tick || a.offerId.localeCompare(b.offerId));
  }

  /** Evaluate resting orders against the bar of session `s` (already complete). */
  private async resolveSession(s: number): Promise<void> {
    if (this.resting.length === 0) return;
    const day = this.sessionDay(s);
    for (let i = this.resting.length - 1; i >= 0; i--) {
      const r = this.resting[i] as RestingSell;
      if (s <= r.placedTick) continue; // never the session it was decided on
      const bar = await this.barOn(r.symbol, day);
      if (bar === null) continue; // no session data for this symbol; try the next
      const f = modelFill('SELL', bar, r.limitMinor, this.costs);
      if (!f.filled) {
        if (s >= r.expiresAfterTick) {
          this.resting.splice(i, 1);
          this.release(r.symbol, r.qty);
          this.expired.push(r.offerId);
          this.log.info('market.order.expired', { offerId: r.offerId, symbol: r.symbol, qty: r.qty, day, paper: true });
        }
        continue;
      }
      this.resting.splice(i, 1);
      this.release(r.symbol, r.qty);
      const notional = f.priceMinor * r.qty;
      const fee = commissionMinor(notional, this.costs);
      const pos = this.positions.get(r.symbol);
      if (pos === undefined || pos.qty < r.qty) {
        /* c8 ignore next 4 */
        throw new AresError('MARKET_POSITION_CORRUPT', `${this.name}: sell of ${r.qty} ${r.symbol} exceeds the book`, {
          channel: this.name,
          symbol: r.symbol,
        });
      }
      // Average-cost relief, integer maths, remainder kept on the book.
      const relieved = Math.round((pos.costMinor * r.qty) / pos.qty);
      pos.costMinor -= relieved;
      pos.qty -= r.qty;
      if (pos.qty === 0) pos.costMinor = 0;
      this.positions.set(r.symbol, pos);
      this.totalCommissionMinor += fee;
      this.totalImplicitMinor += f.implicitCostMinor * r.qty;
      const settleTick = s + this.costs.settlementSessions;
      const trade: EquityTrade = {
        symbol: r.symbol,
        venue: this.venue,
        side: 'SELL',
        qty: r.qty,
        priceMinor: f.priceMinor,
        commissionMinor: fee,
        implicitCostMinor: f.implicitCostMinor * r.qty,
        decisionDay: this.sessionDay(r.placedTick),
        fillDay: day,
        decisionTick: r.placedTick,
        fillTick: s,
        settleTick,
        settleDay: this.sessionDay(settleTick),
        currency: this.currency,
        realisedMinor: notional - fee - relieved,
      };
      this.trades.push(trade);
      this.pending.push({
        settleTick,
        fill: {
          offerId: r.offerId,
          qty: r.qty,
          unitPrice: money(f.priceMinor, this.currency),
          feeMinor: fee,
          // The SETTLEMENT tick, never the fill tick. That is the whole point.
          tick: settleTick,
        },
      });
      this.log.info('market.fill', {
        side: 'SELL',
        symbol: r.symbol,
        qty: r.qty,
        priceMinor: f.priceMinor,
        fillDay: day,
        settleDay: trade.settleDay,
        realisedMinor: trade.realisedMinor,
        feeMinor: fee,
        paper: true,
      });
    }
  }

  private release(symbol: string, qty: number): void {
    const r = this.reserved.get(symbol) ?? 0;
    this.reserved.set(symbol, Math.max(0, r - qty));
  }

  /**
   * Probability that a limit at `price` is TOUCHED on the next session, estimated
   * from PAST bars only: the mean true daily range over the trailing window, and
   * how many of those ranges away the limit sits from the last close. No future
   * bar is read, so this is an estimate and not a peek — and it is deliberately
   * crude, because a precise-looking number here would be an invented edge.
   */
  async demandSignal(sku: string, price: Money, tick: number): Promise<number> {
    this.assertReady('demandSignal');
    this.assertDecisionPhase('demandSignal', tick);
    this.assertCurrency(price, 'demandSignal');
    const symbol = assertSymbol(sku, `${this.name}.demandSignal`);
    const day = this.sessionDay(tick);
    const window = 20;
    const from = tick >= window ? this.sessionDay(tick - window) : EPOCH_FLOOR_DAY;
    const hist = await this.feed.bars(symbol, this.venue, from, day);
    if (hist.length < 2) return 0;
    const last = hist[hist.length - 1] as Bar;
    let ranges = 0;
    for (const b of hist) ranges += b.highMinor - b.lowMinor;
    const meanRange = ranges / hist.length;
    if (meanRange <= 0) return 0;
    const distance = Math.abs(price.amount - last.closeMinor) / meanRange;
    // 1 at the close, ~0.37 one mean range away, ~0.14 two ranges away.
    const p = Math.exp(-distance);
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  /* ---------------------------------------------------------------- reading */

  get lastPolledTick(): number {
    return this.lastPollTick;
  }

  positionOf(symbol: string): { qty: number; costMinor: Minor } {
    const p = this.positions.get(symbol);
    return { qty: p?.qty ?? 0, costMinor: p?.costMinor ?? 0 };
  }

  positionsSnapshot(): Record<string, { qty: number; costMinor: Minor }> {
    const out: Record<string, { qty: number; costMinor: Minor }> = {};
    for (const [k, v] of this.positions) if (v.qty !== 0) out[k] = { qty: v.qty, costMinor: v.costMinor };
    return out;
  }

  openOrders(): Array<{ offerId: string; symbol: string; qty: number; limitMinor: Minor | null }> {
    return this.resting.map((r) => ({ offerId: r.offerId, symbol: r.symbol, qty: r.qty, limitMinor: r.limitMinor }));
  }

  /** Orders that reached their TTL without filling, drained since the last call. */
  drainExpired(): string[] {
    return this.expired.splice(0, this.expired.length);
  }

  tradeLog(): EquityTrade[] {
    return this.trades.map((t) => ({ ...t }));
  }

  costsPaid(): { commissionMinor: Minor; implicitMinor: Minor; totalMinor: Minor; currency: Currency } {
    return {
      commissionMinor: this.totalCommissionMinor,
      implicitMinor: this.totalImplicitMinor,
      totalMinor: this.totalCommissionMinor + this.totalImplicitMinor,
      currency: this.currency,
    };
  }

  /** Mark the book to the close of `sessionDay(tick)` — never to a later bar. */
  async markToMarket(tick: number): Promise<Money> {
    this.assertReady('markToMarket');
    const day = this.sessionDay(tick);
    let total = 0;
    for (const [symbol, pos] of this.positions) {
      if (pos.qty === 0) continue;
      const bars = await this.feed.bars(symbol, this.venue, EPOCH_FLOOR_DAY, day);
      const last = bars.length === 0 ? null : (bars[bars.length - 1] as Bar);
      if (last === null) continue;
      total += last.closeMinor * pos.qty;
    }
    return money(total, this.currency);
  }

  /** This venue's value expressed in the run's base currency. See FX_ASSUMPTION_NOTE. */
  toBase(m: Money, base: Currency): Money {
    return toCurrency(m, base, this.sarPerUsd);
  }

  get fxSarPerUsd(): number {
    return this.sarPerUsd;
  }

  get contextOrNull(): ChannelContext | null {
    return this.ctx;
  }
}
