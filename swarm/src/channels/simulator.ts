/**
 * channels/simulator.ts — the synthetic market. In PAPER mode this IS the market.
 * Invariant: every stochastic draw comes from an injected Rng, so a seed reproduces
 * the whole market exactly; latent value is NEVER handed to an agent (only a noisy
 * estimate is); fees are integer minor units always rounded UP, never in our favour.
 * Callers: dataproducts/digitalassets/ksa_ecom adapters (and only them) + tests.
 */

import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Rng } from '../core/rng.js';
import { makeRng } from '../core/rng.js';
import { AdapterError, AresError } from '../core/errors.js';
import { money, type Currency, type Minor, type Money } from '../core/money.js';
import type { Fill, Holding, Offer, Opportunity } from '../core/types.js';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext } from './adapter.js';

/* ------------------------------------------------------------------ params */

/**
 * Per-channel market parameters. Everything that shapes the economics of a
 * channel lives here so nothing is buried as a magic number in an adapter.
 * All *Minor fields are integer minor units; all *Bps are basis points.
 */
export interface ChannelParams {
  /** The one and only currency this channel may ever emit. */
  currency: Currency;
  /** How many distinct SKUs exist in this channel's universe. */
  skuCount: number;
  /** Long-run mean of the latent value process, in minor units. */
  baseValueMinor: Minor;
  /** Per-SKU dispersion of the long-run mean (fraction of baseValueMinor). */
  valueDispersion: number;
  /** Ornstein-Uhlenbeck mean-reversion speed per tick (0..1). */
  ouTheta: number;
  /** OU per-tick volatility, as a fraction of the SKU's long-run mean. */
  ouSigma: number;
  /** Amplitude of the slow seasonal demand component (fraction of 1). */
  seasonAmplitude: number;
  /** Period of the seasonal demand component, in ticks. */
  seasonPeriodTicks: number;
  /** Per-tick idiosyncratic demand noise (sigma). */
  demandNoiseSigma: number;
  /** Half-spread added to the latent value to produce an ask, in bps. */
  spreadBps: number;
  /** Multiplicative noise on the ask price (sigma). */
  askNoiseSigma: number;
  /** Probability a given listing is a GENUINE bargain (priced below latent). */
  bargainProb: number;
  /** How far below latent value a genuine bargain sits (fraction). */
  bargainDepth: number;
  /** Estimator error sigma at confidence 0. Scales down as confidence rises. */
  estErrorSigma: number;
  /** How much of the estimator error a maximal-confidence listing removes (0..1). */
  estErrorConfidenceGain: number;
  /** Mean number of listings surfaced per tick (Poisson-ish). */
  listingsPerTick: number;
  /** TTL handed out with each opportunity, in ticks. */
  opportunityTtlTicks: number;
  /** Commission charged on a purchase, in bps of notional. */
  buyCommissionBps: number;
  /** Commission charged on a sale, in bps of notional. */
  sellCommissionBps: number;
  /** Flat fee charged the moment a listing is published, sold or not. */
  listingFeeMinor: Minor;
  /** Ticks between a sale happening and the cash being reportable. */
  settlementDelayTicks: number;
  /** Probability that a fill (buy or sell) is partial rather than complete. */
  partialFillProb: number;
  /** Sell-through over a full TTL when priced exactly at latent value. */
  baseSellThrough: number;
  /** Demand-curve elasticity: how fast sell-through decays above latent value. */
  elasticity: number;
  /** Probability that a listing is simply dead and never sells within its TTL. */
  deadListingProb: number;
  /** Default TTL applied to a published offer when the caller supplies none. */
  listingTtlTicks: number;
  /** VAT rate, in bps, used only for the display convention (see ksa_ecom). */
  vatRateBps: number;
}

/** Sensible cross-channel baseline; every channel overrides what matters to it. */
export const BASE_PARAMS: ChannelParams = {
  currency: 'SAR',
  skuCount: 24,
  baseValueMinor: 4_000,
  valueDispersion: 0.45,
  ouTheta: 0.12,
  ouSigma: 0.05,
  seasonAmplitude: 0.25,
  seasonPeriodTicks: 48,
  demandNoiseSigma: 0.08,
  spreadBps: 300,
  askNoiseSigma: 0.05,
  bargainProb: 0.04,
  bargainDepth: 0.14,
  estErrorSigma: 0.14,
  estErrorConfidenceGain: 0.7,
  listingsPerTick: 5,
  opportunityTtlTicks: 4,
  buyCommissionBps: 200,
  sellCommissionBps: 600,
  listingFeeMinor: 25,
  settlementDelayTicks: 2,
  partialFillProb: 0.18,
  baseSellThrough: 0.35,
  elasticity: 2.8,
  deadListingProb: 0.2,
  listingTtlTicks: 12,
  vatRateBps: 0,
};

/**
 * Per-channel defaults. These are the numbers the exercise is actually about:
 * digitalassets is a thin-margin, wide-spread, slow-settling trap for a naive
 * scout; dataproducts has no acquisition cost but slow demand; ksa_ecom is a
 * sell-only-in-practice SAR channel.
 */
export const DEFAULT_CHANNEL_PARAMS: Readonly<Record<string, Partial<ChannelParams>>> = Object.freeze({
  dataproducts: {
    skuCount: 12,
    baseValueMinor: 6_500,
    valueDispersion: 0.5,
    ouTheta: 0.08,
    ouSigma: 0.03,
    seasonAmplitude: 0.3,
    seasonPeriodTicks: 60,
    spreadBps: 0,
    askNoiseSigma: 0,
    bargainProb: 0,
    estErrorSigma: 0.1,
    listingsPerTick: 3,
    opportunityTtlTicks: 6,
    buyCommissionBps: 0,
    sellCommissionBps: 900,
    listingFeeMinor: 0,
    settlementDelayTicks: 2,
    partialFillProb: 0.1,
    baseSellThrough: 0.18, // low and slow: revenue must come from pricing, not volume
    elasticity: 2.0,
    deadListingProb: 0.3,
    listingTtlTicks: 16,
  },
  digitalassets: {
    skuCount: 32,
    baseValueMinor: 3_200,
    valueDispersion: 0.4,
    ouTheta: 0.15,
    ouSigma: 0.06,
    spreadBps: 350, // wide two-sided spread
    askNoiseSigma: 0.06,
    bargainProb: 0.05, // genuine edges are rare...
    bargainDepth: 0.28, // ...but deep enough to survive a 5% round trip when real
    estErrorSigma: 0.16, // ...and mostly drowned by estimation error
    listingsPerTick: 7,
    opportunityTtlTicks: 3,
    buyCommissionBps: 250,
    sellCommissionBps: 250,
    listingFeeMinor: 25,
    settlementDelayTicks: 5, // long settlement: cash is locked up for a while
    partialFillProb: 0.22,
    baseSellThrough: 0.45,
    elasticity: 3.4,
    deadListingProb: 0.18,
    listingTtlTicks: 10,
  },
  ksa_ecom: {
    currency: 'SAR',
    skuCount: 20,
    baseValueMinor: 5_000,
    ouTheta: 0.1,
    ouSigma: 0.045,
    spreadBps: 250,
    askNoiseSigma: 0.05,
    bargainProb: 0.03,
    bargainDepth: 0.2,
    estErrorSigma: 0.15,
    listingsPerTick: 6,
    opportunityTtlTicks: 4,
    buyCommissionBps: 300,
    sellCommissionBps: 850,
    listingFeeMinor: 100,
    settlementDelayTicks: 3,
    partialFillProb: 0.2,
    baseSellThrough: 0.38,
    elasticity: 2.6,
    deadListingProb: 0.22,
    listingTtlTicks: 14,
    // ASSUMPTION, NOT VERIFIED LAW: the standard KSA VAT rate used for the
    // VAT-inclusive display convention. Configurable on purpose — it must be
    // confirmed by the legal reviewer before anyone relies on it.
    vatRateBps: 1_500,
  },
});

export function resolveParams(channel: string, overrides: Partial<ChannelParams> = {}): ChannelParams {
  const preset = DEFAULT_CHANNEL_PARAMS[channel] ?? {};
  const p: ChannelParams = { ...BASE_PARAMS, ...preset, ...overrides };
  if (p.skuCount < 1) throw new AresError('SIM_BAD_PARAMS', `skuCount must be >= 1 for ${channel}`);
  if (p.settlementDelayTicks < 1) {
    // A zero-tick settlement would let a naive strategy recycle cash instantly,
    // which is exactly the unrealistic behaviour this simulator exists to deny.
    throw new AresError('SIM_BAD_PARAMS', `settlementDelayTicks must be >= 1 for ${channel}`);
  }
  return Object.freeze(p);
}

/* ------------------------------------------------------------------- types */

/** A listing as the market knows it, including the truth an agent never sees. */
export interface SimListing {
  id: string;
  channel: string;
  sku: string;
  title: string;
  tick: number;
  askMinor: Minor;
  /** The estimate an agent is allowed to see. Noisy on purpose. */
  estResaleMinor: Minor;
  /** Precision of estResaleMinor. Higher confidence => smaller estimation error. */
  confidence: number;
  ttlTicks: number;
  /** GROUND TRUTH. Adapters must never leak this into an Opportunity. */
  latentMinor: Minor;
  /** True iff this listing really is below latent value. Test/audit only. */
  genuineBargain: boolean;
}

export interface SimFill {
  channel: string;
  offerId: string;
  sku: string;
  qty: number;
  unitPriceMinor: Minor;
  feeMinor: Minor;
  soldTick: number;
  settleTick: number;
}

/** A listing that reached its TTL with stock left. The seller's cue to re-price. */
export interface SimExpiry {
  channel: string;
  offerId: string;
  sku: string;
  priceMinor: Minor;
  remaining: number;
  listedTick: number;
  expiredTick: number;
}

export interface SimCounters {
  listed: number;
  filled: number;
  expired: number;
  feesMinor: Minor;
  buys: number;
  boughtUnits: number;
}

interface SkuState {
  sku: string;
  title: string;
  meanMinor: number;
  valueMinor: number;
  demand: number;
}

interface ActiveListing {
  offerId: string;
  sku: string;
  priceMinor: Minor;
  remaining: number;
  listedTick: number;
  expiresTick: number;
  dead: boolean;
}

interface ChannelState {
  name: string;
  params: ChannelParams;
  marketRng: Rng;
  execRng: Rng;
  skus: SkuState[];
  pool: SimListing[];
  poolTick: number;
  active: Map<string, ActiveListing>;
  pending: SimFill[];
  expiries: SimExpiry[];
  counters: SimCounters;
  seq: number;
}

export interface MarketDeps {
  rng: Rng;
  clock: Clock;
  logger: Logger;
}

/* --------------------------------------------------------------- utilities */

/** Fee in minor units, ALWAYS rounded up. Integer math, no float epsilon games. */
export function feeOnBps(amountMinor: Minor, bps: number): Minor {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new AresError('SIM_BAD_AMOUNT', `feeOnBps: amount must be an integer, got ${String(amountMinor)}`);
  }
  if (bps <= 0) return 0;
  const notional = Math.abs(amountMinor) * bps;
  return Math.ceil(notional / 10_000);
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/* ------------------------------------------------------------- MarketSimulator */

export class MarketSimulator {
  private readonly rng: Rng;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly channels = new Map<string, ChannelState>();
  private tick = -1;

  constructor(deps: MarketDeps, params: Record<string, Partial<ChannelParams>> = {}) {
    this.rng = deps.rng;
    this.clock = deps.clock;
    this.logger = deps.logger.child({ mod: 'simulator' });
    // Registration order is the enumeration order of the params object, which is
    // stable — so the derived per-channel seeds are stable too.
    for (const [name, override] of Object.entries(params)) this.registerChannel(name, override);
  }

  /** Current virtual tick, or -1 before the first advance. */
  get currentTick(): number {
    return this.tick;
  }

  hasChannel(name: string): boolean {
    return this.channels.has(name);
  }

  paramsOf(name: string): ChannelParams {
    return this.state(name).params;
  }

  /**
   * Register a channel universe. Each channel gets two derived deterministic
   * streams so that trading activity on one channel can never shift another
   * channel's market evolution.
   */
  registerChannel(name: string, overrides: Partial<ChannelParams> = {}): ChannelParams {
    const existing = this.channels.get(name);
    if (existing) return existing.params;
    const params = resolveParams(name, overrides);
    // Two independent 31-bit seeds drawn from the injected rng.
    const marketSeed = this.rng.int(0x7fff_ffff);
    const execSeed = this.rng.int(0x7fff_ffff);
    const marketRng = makeRng(marketSeed);
    const skus: SkuState[] = [];
    for (let i = 0; i < params.skuCount; i++) {
      const spread = 1 + (marketRng.next() * 2 - 1) * params.valueDispersion;
      const meanMinor = Math.max(1, params.baseValueMinor * spread);
      skus.push({
        sku: `${name}-sku-${String(i).padStart(3, '0')}`,
        title: `${name} item ${String(i).padStart(3, '0')}`,
        meanMinor,
        valueMinor: meanMinor,
        demand: 1,
      });
    }
    const st: ChannelState = {
      name,
      params,
      marketRng,
      execRng: makeRng(execSeed),
      skus,
      pool: [],
      poolTick: -1,
      active: new Map(),
      pending: [],
      expiries: [],
      counters: { listed: 0, filled: 0, expired: 0, feesMinor: 0, buys: 0, boughtUnits: 0 },
      seq: 0,
    };
    this.channels.set(name, st);
    this.logger.debug('channel registered', { channel: name, marketSeed, execSeed, skuCount: params.skuCount });
    return params;
  }

  private state(name: string): ChannelState {
    const st = this.channels.get(name);
    if (!st) throw new AdapterError('SIM_UNKNOWN_CHANNEL', `simulator: channel ${name} is not registered`, { name });
    return st;
  }

  /**
   * Evolve the market up to `tick`. Idempotent for a tick already reached and a
   * no-op for a tick in the past, so any adapter may call it first without
   * changing the outcome — determinism does not depend on call ordering.
   */
  advanceTo(tick: number): void {
    if (!Number.isInteger(tick) || tick < 0) {
      throw new AresError('SIM_BAD_TICK', `advanceTo: tick must be a non-negative integer, got ${String(tick)}`);
    }
    while (this.tick < tick) {
      this.tick += 1;
      for (const st of this.channels.values()) this.stepChannel(st, this.tick);
    }
  }

  private stepChannel(st: ChannelState, tick: number): void {
    const p = st.params;
    const r = st.marketRng;
    // 1. latent value: mean-reverting (OU) random walk; demand: slow seasonal + noise.
    const season = 1 + p.seasonAmplitude * Math.sin((2 * Math.PI * tick) / Math.max(1, p.seasonPeriodTicks));
    for (const s of st.skus) {
      const drift = p.ouTheta * (s.meanMinor - s.valueMinor);
      const shock = r.gauss(0, p.ouSigma * s.meanMinor);
      s.valueMinor = Math.max(1, s.valueMinor + drift + shock);
      s.demand = Math.max(0.05, season * (1 + r.gauss(0, p.demandNoiseSigma)));
    }
    // 2. surface this tick's listings.
    st.pool = this.mintListings(st, tick);
    st.poolTick = tick;
    // 3. resolve active listings: hazard draw, then expiry.
    this.resolveListings(st, tick);
  }

  private mintListings(st: ChannelState, tick: number): SimListing[] {
    const p = st.params;
    const r = st.marketRng;
    const out: SimListing[] = [];
    // Count jitters around listingsPerTick so an agent cannot count on supply.
    const n = Math.max(0, Math.round(p.listingsPerTick + r.gauss(0, Math.max(0.5, p.listingsPerTick * 0.25))));
    for (let i = 0; i < n; i++) {
      const s = r.pick(st.skus);
      const latent = s.valueMinor;
      const genuineBargain = p.bargainProb > 0 && r.next() < p.bargainProb;
      const spread = 1 + p.spreadBps / 10_000;
      const noise = p.askNoiseSigma > 0 ? 1 + r.gauss(0, p.askNoiseSigma) : 1;
      const askRaw = genuineBargain
        ? latent * (1 - p.bargainDepth) * Math.max(0.5, noise)
        : latent * spread * Math.max(0.5, noise);
      const askMinor = Math.max(1, Math.round(askRaw));
      // The estimate an agent sees. Its error shrinks as confidence rises, which
      // is exactly why a confidence threshold is worth anything.
      const confidence = clamp(0.3 + r.next() * 0.65, 0, 1);
      const sigma = p.estErrorSigma * (1 - p.estErrorConfidenceGain * confidence);
      const estMinor = Math.max(1, Math.round(latent * (1 + r.gauss(0, sigma))));
      st.seq += 1;
      out.push({
        id: `${st.name}:opp:${tick}:${i}`,
        channel: st.name,
        sku: s.sku,
        title: s.title,
        tick,
        askMinor,
        estResaleMinor: estMinor,
        confidence,
        ttlTicks: p.opportunityTtlTicks,
        latentMinor: Math.round(latent),
        genuineBargain,
      });
    }
    return out;
  }

  private resolveListings(st: ChannelState, tick: number): void {
    const p = st.params;
    const r = st.execRng;
    for (const [id, l] of [...st.active.entries()]) {
      if (l.listedTick >= tick) continue; // published this tick: cannot sell yet
      if (!l.dead && l.remaining > 0) {
        const life = Math.max(1, l.expiresTick - l.listedTick);
        const pTtl = this.sellThroughRaw(st, l.sku, l.priceMinor);
        const hazard = 1 - Math.pow(1 - clamp(pTtl, 0, 0.98), 1 / life);
        if (r.next() < hazard) {
          let qty = l.remaining;
          if (l.remaining > 1 && r.next() < p.partialFillProb) qty = 1 + r.int(l.remaining - 1);
          l.remaining -= qty;
          const feeMinor = feeOnBps(l.priceMinor * qty, p.sellCommissionBps);
          st.counters.filled += qty;
          st.counters.feesMinor += feeMinor;
          st.pending.push({
            channel: st.name,
            offerId: l.offerId,
            sku: l.sku,
            qty,
            unitPriceMinor: l.priceMinor,
            feeMinor,
            soldTick: tick,
            settleTick: tick + p.settlementDelayTicks,
          });
        }
      }
      if (l.remaining <= 0) {
        st.active.delete(id);
      } else if (tick >= l.expiresTick) {
        st.counters.expired += 1;
        st.active.delete(id);
        st.expiries.push({
          channel: st.name,
          offerId: l.offerId,
          sku: l.sku,
          priceMinor: l.priceMinor,
          remaining: l.remaining,
          listedTick: l.listedTick,
          expiredTick: tick,
        });
        this.logger.debug('listing expired unsold', { channel: st.name, offerId: l.offerId, remaining: l.remaining });
      }
    }
  }

  /* ------------------------------------------------------------ read models */

  /** This tick's opportunity pool. Read-only: consumes no randomness. */
  listings(channel: string, tick: number): SimListing[] {
    this.advanceTo(tick);
    const st = this.state(channel);
    return st.poolTick === tick ? st.pool.slice() : [];
  }

  /** GROUND TRUTH. For tests/auditing only — never hand this to an agent. */
  latentValueMinor(channel: string, sku: string, tick: number): Minor {
    this.advanceTo(tick);
    const st = this.state(channel);
    return Math.round(this.skuOf(st, sku).valueMinor);
  }

  private skuOf(st: ChannelState, sku: string): SkuState {
    const found = st.skus.find((s) => s.sku === sku);
    if (found) return found;
    // Unknown SKUs (e.g. a minted data product) behave like the channel average.
    const first = st.skus[0];
    if (!first) throw new AdapterError('SIM_NO_SKUS', `simulator: channel ${st.name} has no SKUs`);
    return first;
  }

  /**
   * The demand curve: sell-through over a full TTL, strictly decreasing in price
   * relative to the current latent value. Pure — consumes no randomness — so a
   * price probe never perturbs the market.
   */
  sellThrough(channel: string, sku: string, priceMinor: Minor, tick: number): number {
    this.advanceTo(tick);
    return this.sellThroughRaw(this.state(channel), sku, priceMinor);
  }

  private sellThroughRaw(st: ChannelState, sku: string, priceMinor: Minor): number {
    const p = st.params;
    const s = this.skuOf(st, sku);
    const ratio = Math.max(0.01, priceMinor / Math.max(1, s.valueMinor));
    // exp(-elasticity * (ratio - 1)) is strictly decreasing in price, for every
    // elasticity > 0 and every latent value. Capped below 1 so nothing is certain.
    const raw = p.baseSellThrough * s.demand * Math.exp(-p.elasticity * (ratio - 1));
    return clamp(raw, 0, 0.97);
  }

  /* ------------------------------------------------------------- executions */

  /** Execute a purchase. Returns the filled quantity (may be partial) and fee. */
  executeBuy(
    channel: string,
    sku: string,
    qty: number,
    unitPriceMinor: Minor,
    tick: number,
  ): { filledQty: number; feeMinor: Minor } {
    this.advanceTo(tick);
    const st = this.state(channel);
    if (!Number.isInteger(qty) || qty < 1) {
      throw new AdapterError('SIM_BAD_QTY', `executeBuy: qty must be a positive integer, got ${String(qty)}`);
    }
    let filledQty = qty;
    if (qty > 1 && st.execRng.next() < st.params.partialFillProb) filledQty = 1 + st.execRng.int(qty - 1);
    const feeMinor = feeOnBps(unitPriceMinor * filledQty, st.params.buyCommissionBps);
    st.counters.buys += 1;
    st.counters.boughtUnits += filledQty;
    st.counters.feesMinor += feeMinor;
    return { filledQty, feeMinor };
  }

  /** Publish a listing. The listing fee is charged now, sale or no sale. */
  listOffer(
    channel: string,
    offerId: string,
    sku: string,
    priceMinor: Minor,
    qty: number,
    tick: number,
    ttlTicks?: number,
  ): { feeMinor: Minor; dead: boolean; expiresTick: number } {
    this.advanceTo(tick);
    const st = this.state(channel);
    if (!Number.isInteger(qty) || qty < 1) {
      throw new AdapterError('SIM_BAD_QTY', `listOffer: qty must be a positive integer, got ${String(qty)}`);
    }
    if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) {
      throw new AdapterError('SIM_BAD_PRICE', `listOffer: price must be a non-negative integer minor amount`);
    }
    if (st.active.has(offerId)) {
      throw new AdapterError('SIM_DUPLICATE_LISTING', `listOffer: ${offerId} is already listed on ${channel}`);
    }
    const ttl = Number.isInteger(ttlTicks) && (ttlTicks as number) > 0 ? (ttlTicks as number) : st.params.listingTtlTicks;
    const dead = st.execRng.next() < st.params.deadListingProb;
    const expiresTick = tick + ttl;
    st.active.set(offerId, { offerId, sku, priceMinor, remaining: qty, listedTick: tick, expiresTick, dead });
    st.counters.listed += 1;
    st.counters.feesMinor += st.params.listingFeeMinor;
    return { feeMinor: st.params.listingFeeMinor, dead, expiresTick };
  }

  /** Settled fills at or before `tick`. Draining: a second call returns []. */
  collectFills(channel: string, tick: number): SimFill[] {
    this.advanceTo(tick);
    const st = this.state(channel);
    const due: SimFill[] = [];
    const keep: SimFill[] = [];
    for (const f of st.pending) (f.settleTick <= tick ? due : keep).push(f);
    st.pending = keep;
    return due;
  }

  /** Listings that expired unsold since the previous call. Draining, like fills. */
  collectExpiries(channel: string, tick: number): SimExpiry[] {
    this.advanceTo(tick);
    const st = this.state(channel);
    const out = st.expiries;
    st.expiries = [];
    return out;
  }

  /** Number of listings still live on a channel. */
  activeListings(channel: string): number {
    return this.state(channel).active.size;
  }

  /**
   * Live state of one listing, or null once it sold out or expired. `remaining`
   * drops the moment a sale happens — BEFORE the cash settles — which is how a
   * seller distinguishes "sold, payout pending" from "still sitting there".
   */
  listingState(channel: string, offerId: string): Readonly<ActiveListing> | null {
    const l = this.state(channel).active.get(offerId);
    return l ? { ...l } : null;
  }

  /** Every listing still live on a channel. */
  openListings(channel: string): Readonly<ActiveListing>[] {
    return [...this.state(channel).active.values()].map((l) => ({ ...l }));
  }

  counters(channel?: string): SimCounters {
    if (channel !== undefined) return { ...this.state(channel).counters };
    const total: SimCounters = { listed: 0, filled: 0, expired: 0, feesMinor: 0, buys: 0, boughtUnits: 0 };
    for (const st of this.channels.values()) {
      total.listed += st.counters.listed;
      total.filled += st.counters.filled;
      total.expired += st.counters.expired;
      total.feesMinor += st.counters.feesMinor;
      total.buys += st.counters.buys;
      total.boughtUnits += st.counters.boughtUnits;
    }
    return total;
  }

  /** Wall-clock is only ever read through the injected clock. */
  nowMs(): number {
    return this.clock.now();
  }
}

/* ------------------------------------------------- shared adapter scaffolding */

/**
 * Behaviour every simulated adapter shares: the init/close lifecycle, the
 * idempotency ledgers for buy/publish, currency policing and poll-once
 * semantics. Lives here because the simulator is the only thing it talks to.
 */
export abstract class SimulatedChannelAdapter implements ChannelAdapter {
  abstract readonly name: string;
  abstract readonly capabilities: ChannelCapabilities;

  protected ctx: ChannelContext | null = null;
  protected log: Logger | null = null;
  private ready = false;
  private closed = false;
  private lastPollTick = -1;
  /** Replay cache: same idem key => same result, no second holding, no second fee. */
  protected readonly buyIdem = new Map<string, { holding: Holding; feeMinor: Minor }>();
  private readonly publishIdem = new Map<string, { offerId: string; feeMinor: Minor }>();

  constructor(protected readonly sim: MarketSimulator) {}

  /** The single currency this adapter is allowed to emit. */
  get currency(): Currency {
    return this.params.currency;
  }

  get params(): ChannelParams {
    return this.sim.paramsOf(this.name);
  }

  async init(ctx: ChannelContext): Promise<void> {
    if (this.closed) {
      throw new AdapterError('ADAPTER_CLOSED', `${this.name}: cannot re-init a closed adapter`, { channel: this.name });
    }
    if (this.ready) return; // init is idempotent
    this.ctx = ctx;
    this.log = ctx.logger.child({ channel: this.name });
    if (!this.sim.hasChannel(this.name)) this.sim.registerChannel(this.name);
    this.ready = true;
    if (ctx.cfg.baseCurrency !== this.currency) {
      // Not fatal: a channel may legitimately trade in its own currency (ksa_ecom
      // is always SAR). The treasury converts. But it must be visible.
      this.log.warn('channel currency differs from base currency', {
        channelCurrency: this.currency,
        baseCurrency: ctx.cfg.baseCurrency,
      });
    }
    this.log.info('channel adapter initialised', {
      jurisdiction: this.capabilities.jurisdiction,
      canBuy: this.capabilities.canBuy,
      buyRequiresHumanApproval: this.capabilities.buyRequiresHumanApproval,
      currency: this.currency,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return; // safe to call twice
    this.closed = true;
    this.ready = false;
    this.log?.info('channel adapter closed', { counters: this.sim.counters(this.name) });
  }

  get isReady(): boolean {
    return this.ready;
  }

  protected assertReady(op: string): void {
    if (!this.ready) {
      throw new AdapterError('ADAPTER_NOT_INITIALISED', `${this.name}.${op}(): init() must be awaited first`, {
        channel: this.name,
        op,
        closed: this.closed,
      });
    }
  }

  /** Every Money crossing this boundary must carry the declared currency. */
  protected assertCurrency(m: Money, where: string): void {
    if (m.currency !== this.currency) {
      throw new AdapterError(
        'ADAPTER_CURRENCY_MISMATCH',
        `${this.name}.${where}(): expected ${this.currency}, got ${m.currency}`,
        { channel: this.name, expected: this.currency, actual: m.currency, where },
      );
    }
  }

  protected m(amount: Minor): Money {
    return money(amount, this.currency);
  }

  async scan(tick: number, budget: Money): Promise<Opportunity[]> {
    this.assertReady('scan');
    this.assertCurrency(budget, 'scan');
    return this.buildOpportunities(tick, budget);
  }

  protected abstract buildOpportunities(tick: number, budget: Money): Opportunity[];

  async quote(o: Opportunity, tick: number): Promise<{ unitCost: Money; feeMinor: Minor }> {
    this.assertReady('quote');
    this.assertCurrency(o.askPrice, 'quote');
    this.sim.advanceTo(tick);
    return { unitCost: o.askPrice, feeMinor: feeOnBps(o.askPrice.amount, this.params.buyCommissionBps) };
  }

  async buy(o: Opportunity, qty: number, tick: number, idem: string): Promise<{ holding: Holding; feeMinor: Minor }> {
    this.assertReady('buy');
    this.assertCurrency(o.askPrice, 'buy');
    if (!this.capabilities.canBuy) {
      throw new AdapterError('CHANNEL_CANNOT_BUY', `${this.name}: this channel has no buy path`, {
        channel: this.name,
      });
    }
    const prior = this.buyIdem.get(idem);
    if (prior) {
      this.log?.debug('buy replayed from idempotency cache', { idem, holdingId: prior.holding.id });
      return prior;
    }
    const result = this.doBuy(o, qty, tick, idem);
    this.buyIdem.set(idem, result);
    return result;
  }

  protected doBuy(_o: Opportunity, _qty: number, _tick: number, _idem: string): { holding: Holding; feeMinor: Minor } {
    throw new AdapterError('CHANNEL_CANNOT_BUY', `${this.name}: this channel has no buy path`, { channel: this.name });
  }

  async publish(offer: Offer, tick: number, idem: string): Promise<{ offerId: string; feeMinor: Minor }> {
    this.assertReady('publish');
    this.assertCurrency(offer.price, 'publish');
    if (!this.capabilities.canSell) {
      throw new AdapterError('CHANNEL_CANNOT_SELL', `${this.name}: selling is not enabled`, { channel: this.name });
    }
    const prior = this.publishIdem.get(idem);
    if (prior) {
      this.log?.debug('publish replayed from idempotency cache', { idem, offerId: prior.offerId });
      return prior;
    }
    const offerId = `${this.name}:${offer.id}`;
    const { feeMinor } = this.sim.listOffer(
      this.name,
      offerId,
      offer.sku,
      offer.price.amount,
      Math.max(1, offer.qty),
      tick,
      typeof offer.meta['ttlTicks'] === 'number' ? (offer.meta['ttlTicks'] as number) : undefined,
    );
    this.decorateListing(offer, offerId, tick);
    const result = { offerId, feeMinor };
    this.publishIdem.set(idem, result);
    return result;
  }

  /** Hook for channel-specific bookkeeping at publish time. */
  protected decorateListing(_offer: Offer, _offerId: string, _tick: number): void {
    /* default: nothing */
  }

  async poll(tick: number): Promise<Fill[]> {
    this.assertReady('poll');
    this.lastPollTick = tick;
    return this.sim.collectFills(this.name, tick).map((f) => ({
      offerId: f.offerId,
      qty: f.qty,
      unitPrice: this.m(f.unitPriceMinor),
      // `tick` is the SETTLEMENT tick: the tick at which the cash is available.
      // It is never the tick the sale happened on — that is the whole point.
      feeMinor: f.feeMinor,
      tick: f.settleTick,
    }));
  }

  get lastPolledTick(): number {
    return this.lastPollTick;
  }

  async demandSignal(sku: string, price: Money, tick: number): Promise<number> {
    this.assertReady('demandSignal');
    this.assertCurrency(price, 'demandSignal');
    return this.sim.sellThrough(this.name, sku, price.amount, tick);
  }

  /**
   * Live state of a listing this adapter published, keyed by the offerId that
   * publish() returned. Null once it has sold out or expired. The seller needs
   * this to tell "sold, payout still settling" from "unsold, re-price it".
   */
  listingStatus(offerId: string): { remaining: number; listedTick: number; expiresTick: number; priceMinor: Minor } | null {
    this.assertReady('listingStatus');
    const l = this.sim.listingState(this.name, offerId);
    return l
      ? { remaining: l.remaining, listedTick: l.listedTick, expiresTick: l.expiresTick, priceMinor: l.priceMinor }
      : null;
  }

  /**
   * Listings that hit their TTL with stock unsold, drained since the previous
   * call — the seller's cue to re-price or write off. Poll-once, like poll().
   */
  async pollExpired(tick: number): Promise<SimExpiry[]> {
    this.assertReady('pollExpired');
    return this.sim.collectExpiries(this.name, tick);
  }

  counters(): SimCounters {
    return this.sim.counters(this.name);
  }
}
