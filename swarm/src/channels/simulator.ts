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
  /**
   * Last-mile / delivery cost, charged ONCE PER ORDER on every fill. This is the
   * shipping label. On a physical channel it dominates everything else at this
   * price band, which is precisely why it must not be omitted.
   */
  fulfilmentPerOrderMinor: Minor;
  /** Pick, pack and consumables, charged PER UNIT on every fill. */
  packagingPerUnitMinor: Minor;
  /** Payment-processor cost on the gross, in bps. */
  paymentFeeBps: number;
  /** Payment-processor flat cost per order, in minor units. */
  paymentFeeFlatMinor: Minor;
  /**
   * Fixed platform/seller-account overhead accrued EVERY TICK for as long as the
   * channel is registered, whether or not anything is listed or sold. Accrues
   * per tick and is collected the next time the swarm transacts on the channel
   * (a listing or a settled fill), the way a monthly seller-account bill is.
   */
  platformFeePerTickMinor: Minor;
  /** Ticks between a sale happening and the cash being reportable. */
  settlementDelayTicks: number;
  /** Probability that a fill (buy or sell) is partial rather than complete. */
  partialFillProb: number;
  /** Sell-through over a full TTL when priced exactly at latent value. */
  baseSellThrough: number;
  /** Demand-curve elasticity: how fast sell-through decays above latent value. */
  elasticity: number;
  /**
   * Fraction of the ASSORTMENT that is permanently dead. Drawn ONCE PER SKU at
   * channel registration, never per listing: a dud SKU stays a dud however many
   * times it is relisted. Drawing it per listing would teach "relist and it will
   * eventually sell", which is the opposite of the real lesson.
   */
  deadListingProb: number;
  /** Default TTL applied to a published offer when the caller supplies none. */
  listingTtlTicks: number;
  /**
   * Permanent per-tick decay of a SKU's long-run mean, in bps. NEGATIVE drift on
   * purpose: without it the OU process guarantees that anything bought below the
   * mean recovers given enough time, so holding is free optionality and "wait it
   * out" strictly dominates selling. Inventory must age.
   */
  valueDriftBps: number;
  /** Per-tick probability that a SKU's value collapses permanently (obsolescence). */
  obsolescenceProb: number;
  /** Multiplier applied to a SKU's mean AND spot value when it collapses. */
  obsolescenceFactor: number;
  /**
   * VAT rate, in bps. CONFIGURABLE ASSUMPTION, NOT A STATEMENT OF LAW (see
   * ksa_ecom.ts). It drives both the VAT-inclusive display convention and the
   * deduction in the fill path: VAT collected on a sale is money owed to the tax
   * authority, never the seller's margin.
   */
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
  fulfilmentPerOrderMinor: 0,
  packagingPerUnitMinor: 0,
  paymentFeeBps: 250,
  paymentFeeFlatMinor: 100,
  platformFeePerTickMinor: 0,
  settlementDelayTicks: 20,
  partialFillProb: 0.18,
  baseSellThrough: 0.35,
  elasticity: 2.8,
  deadListingProb: 0.2,
  listingTtlTicks: 12,
  valueDriftBps: -15,
  obsolescenceProb: 0.003,
  obsolescenceFactor: 0.35,
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
    // An unsold listing MUST be a real loss. At zero this channel was
    // structurally incapable of losing money: with unitCost 0, listingFee 0 and
    // buyCommission 0 the seller's floor rule reduced to "price >= 9% of price",
    // which is true for every price.
    listingFeeMinor: 120,
    // No shipping, but delivery/hosting/support per order is not free.
    fulfilmentPerOrderMinor: 150,
    packagingPerUnitMinor: 0,
    paymentFeeBps: 275,
    paymentFeeFlatMinor: 100,
    platformFeePerTickMinor: 18,
    settlementDelayTicks: 20,
    partialFillProb: 0.1,
    baseSellThrough: 0.18, // low and slow: revenue must come from pricing, not volume
    elasticity: 2.0,
    deadListingProb: 0.3,
    listingTtlTicks: 16,
    // Data goes stale fast, and a dataset can be superseded outright.
    valueDriftBps: -30,
    obsolescenceProb: 0.005,
    obsolescenceFactor: 0.3,
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
    fulfilmentPerOrderMinor: 0, // transferable: nothing is shipped
    packagingPerUnitMinor: 0,
    paymentFeeBps: 250,
    paymentFeeFlatMinor: 75,
    platformFeePerTickMinor: 14,
    // Cash conversion is 90-150 days in the real thing. The old value of 5 was
    // off by roughly 10x and let a naive strategy recycle capital far too fast.
    settlementDelayTicks: 45,
    partialFillProb: 0.22,
    baseSellThrough: 0.45,
    elasticity: 3.4,
    deadListingProb: 0.18,
    listingTtlTicks: 10,
    valueDriftBps: -15,
    obsolescenceProb: 0.003,
    obsolescenceFactor: 0.4,
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
    // THE SHIPPING LABEL. At this channel's SAR 32-65 price band a real KSA
    // per-order cost is last-mile SAR 15-30, pick/pack SAR 2-5 and payment
    // ~2-2.75% + ~SAR 1 — together 40-70% of order value. Omitting it was the
    // single largest overstatement in the model.
    fulfilmentPerOrderMinor: 2_000,
    packagingPerUnitMinor: 300,
    paymentFeeBps: 250,
    paymentFeeFlatMinor: 100,
    platformFeePerTickMinor: 22,
    settlementDelayTicks: 30,
    partialFillProb: 0.2,
    baseSellThrough: 0.38,
    elasticity: 2.6,
    deadListingProb: 0.22,
    listingTtlTicks: 14,
    valueDriftBps: -20,
    obsolescenceProb: 0.0035,
    obsolescenceFactor: 0.35,
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
  // A VAT rate outside [0, 100%] is not a tax rate. -10000 in particular made
  // vatBreakdown() divide by zero, and any negative rate turns tax into revenue.
  if (!Number.isFinite(p.vatRateBps) || p.vatRateBps < 0 || p.vatRateBps > 10_000) {
    throw new AresError(
      'SIM_BAD_PARAMS',
      `vatRateBps must be between 0 and 10000 for ${channel}, got ${String(p.vatRateBps)}`,
    );
  }
  for (const k of [
    'listingFeeMinor',
    'fulfilmentPerOrderMinor',
    'packagingPerUnitMinor',
    'paymentFeeFlatMinor',
    'platformFeePerTickMinor',
  ] as const) {
    const v = p[k];
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new AresError('SIM_BAD_PARAMS', `${k} must be a non-negative integer for ${channel}, got ${String(v)}`);
    }
  }
  if (!Number.isFinite(p.paymentFeeBps) || p.paymentFeeBps < 0) {
    throw new AresError('SIM_BAD_PARAMS', `paymentFeeBps must be >= 0 for ${channel}`);
  }
  if (!(p.obsolescenceProb >= 0 && p.obsolescenceProb <= 1)) {
    throw new AresError('SIM_BAD_PARAMS', `obsolescenceProb must be in [0,1] for ${channel}`);
  }
  if (!(p.obsolescenceFactor >= 0 && p.obsolescenceFactor <= 1)) {
    throw new AresError('SIM_BAD_PARAMS', `obsolescenceFactor must be in [0,1] for ${channel}`);
  }
  if (!(p.deadListingProb >= 0 && p.deadListingProb <= 1)) {
    throw new AresError('SIM_BAD_PARAMS', `deadListingProb must be in [0,1] for ${channel}`);
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

/**
 * Everything deducted from the gross of one order, itemised. `feeMinor` on the
 * fill is the sum, so a caller that only knows about "fees" still pays all of it
 * — but an auditor can see WHICH cost killed the margin.
 */
export interface FillCosts {
  /** Marketplace commission on the gross. */
  commissionMinor: Minor;
  /** Last-mile delivery, once per order. */
  fulfilmentMinor: Minor;
  /** Pick/pack, per unit. */
  packagingMinor: Minor;
  /** Payment processing: bps of gross plus a flat per-order charge. */
  paymentMinor: Minor;
  /** Fixed platform overhead accrued since it was last collected. */
  platformMinor: Minor;
  /** VAT collected from the buyer inside the gross. Owed to the tax authority. */
  vatMinor: Minor;
  /** VAT charged BY the platform/carrier ON their fees. A real cost to the seller. */
  vatOnFeesMinor: Minor;
  /** commission + fulfilment + packaging + payment + platform (VAT excluded). */
  sellerCostMinor: Minor;
  /** sellerCost + vat + vatOnFees. Equals the fill's feeMinor exactly. */
  totalMinor: Minor;
}

export interface SimFill {
  channel: string;
  offerId: string;
  sku: string;
  qty: number;
  unitPriceMinor: Minor;
  feeMinor: Minor;
  /** Itemised breakdown of feeMinor. */
  costs: FillCosts;
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
  /** Platform overhead ACCRUED, whether or not it has been collected yet. */
  platformAccruedMinor: Minor;
  /** Platform overhead actually charged to the swarm. */
  platformChargedMinor: Minor;
  /** VAT collected from buyers. Owed onward; never the seller's margin. */
  vatCollectedMinor: Minor;
  /** Fulfilment + packaging charged across every fill. */
  logisticsMinor: Minor;
  /** Number of SKUs written down by an obsolescence event. */
  obsoleted: number;
}

interface SkuState {
  sku: string;
  title: string;
  meanMinor: number;
  valueMinor: number;
  demand: number;
  /**
   * PERMANENT. Drawn once, at registration: this SKU is part of the dead tail of
   * the assortment and will never sell, however often it is relisted.
   */
  dead: boolean;
  /** True once this SKU has been written down by an obsolescence event. */
  obsolete: boolean;
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
  /** Platform overhead accrued since it was last collected, in minor units. */
  platformAccrualMinor: Minor;
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

/**
 * Net the VAT out of a VAT-INCLUSIVE gross. Integer math; the VAT component is
 * whatever is left after the net, so net + vat reconstructs the gross exactly.
 * The rate is a CONFIGURABLE ASSUMPTION (see ksa_ecom.ts), never a legal claim.
 */
export function vatOnGross(grossMinor: Minor, vatRateBps: number): Minor {
  if (vatRateBps <= 0) return 0;
  const net = Math.round((grossMinor * 10_000) / (10_000 + vatRateBps));
  return grossMinor - net;
}

/**
 * Every cost of one order, itemised. Pure, integer, and deliberately charged in
 * full: the swarm used to book the money it owes the tax authority as profit and
 * to ship at no cost at all.
 */
export function fillCosts(
  p: ChannelParams,
  grossMinor: Minor,
  qty: number,
  platformDueMinor: Minor = 0,
): FillCosts {
  const commissionMinor = feeOnBps(grossMinor, p.sellCommissionBps);
  const fulfilmentMinor = p.fulfilmentPerOrderMinor;
  const packagingMinor = p.packagingPerUnitMinor * Math.max(0, qty);
  const paymentMinor = feeOnBps(grossMinor, p.paymentFeeBps) + p.paymentFeeFlatMinor;
  const platformMinor = Math.max(0, platformDueMinor);
  const sellerCostMinor = commissionMinor + fulfilmentMinor + packagingMinor + paymentMinor + platformMinor;
  // VAT collected from the buyer inside a VAT-inclusive price is NOT margin.
  const vatMinor = vatOnGross(grossMinor, p.vatRateBps);
  // ...and the platform/carrier/PSP charge VAT on their own fees, which the
  // seller pays. Hence proceeds = gross - vat - fees * (1 + vatRate).
  const vatOnFeesMinor = feeOnBps(sellerCostMinor, p.vatRateBps);
  return {
    commissionMinor,
    fulfilmentMinor,
    packagingMinor,
    paymentMinor,
    platformMinor,
    vatMinor,
    vatOnFeesMinor,
    sellerCostMinor,
    totalMinor: sellerCostMinor + vatMinor + vatOnFeesMinor,
  };
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
      // The dead draw happens HERE, once, per SKU — not per listing. A fixed
      // fraction of the assortment is permanently unsellable, so relisting a dud
      // is throwing good listing fees after bad rather than a route to a sale.
      const dead = marketRng.next() < params.deadListingProb;
      skus.push({
        sku: `${name}-sku-${String(i).padStart(3, '0')}`,
        title: `${name} item ${String(i).padStart(3, '0')}`,
        meanMinor,
        valueMinor: meanMinor,
        demand: 1,
        dead,
        obsolete: false,
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
      counters: {
        listed: 0,
        filled: 0,
        expired: 0,
        feesMinor: 0,
        buys: 0,
        boughtUnits: 0,
        platformAccruedMinor: 0,
        platformChargedMinor: 0,
        vatCollectedMinor: 0,
        logisticsMinor: 0,
        obsoleted: 0,
      },
      seq: 0,
      platformAccrualMinor: 0,
    };
    this.channels.set(name, st);
    this.logger.debug('channel registered', {
      channel: name,
      marketSeed,
      execSeed,
      skuCount: params.skuCount,
      deadSkus: skus.filter((k) => k.dead).length,
    });
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
      // OBSOLESCENCE, part 1: the long-run mean itself decays. Without this the
      // OU pull guarantees that anything bought below the mean recovers if you
      // wait, so holding costs nothing and "wait it out" strictly dominates.
      if (p.valueDriftBps !== 0) {
        s.meanMinor = Math.max(1, s.meanMinor * (1 + p.valueDriftBps / 10_000));
      }
      // OBSOLESCENCE, part 2: a small per-tick chance the SKU is superseded and
      // never comes back. PERMANENT — the mean moves, not just the spot value.
      if (p.obsolescenceProb > 0 && r.next() < p.obsolescenceProb) {
        s.meanMinor = Math.max(1, s.meanMinor * p.obsolescenceFactor);
        s.valueMinor = Math.max(1, s.valueMinor * p.obsolescenceFactor);
        if (!s.obsolete) {
          s.obsolete = true;
          st.counters.obsoleted += 1;
        }
        this.logger.debug('sku obsoleted', { channel: st.name, sku: s.sku, tick, factor: p.obsolescenceFactor });
      }
      const drift = p.ouTheta * (s.meanMinor - s.valueMinor);
      const shock = r.gauss(0, p.ouSigma * s.meanMinor);
      s.valueMinor = Math.max(1, s.valueMinor + drift + shock);
      s.demand = Math.max(0.05, season * (1 + r.gauss(0, p.demandNoiseSigma)));
    }
    // Fixed platform overhead accrues every tick the channel is registered,
    // whether or not the swarm lists or sells anything on it.
    if (p.platformFeePerTickMinor > 0) {
      st.platformAccrualMinor += p.platformFeePerTickMinor;
      st.counters.platformAccruedMinor += p.platformFeePerTickMinor;
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
      if (!l.dead && !this.skuOf(st, l.sku).dead && l.remaining > 0) {
        const life = Math.max(1, l.expiresTick - l.listedTick);
        const pTtl = this.sellThroughRaw(st, l.sku, l.priceMinor);
        const hazard = 1 - Math.pow(1 - clamp(pTtl, 0, 0.98), 1 / life);
        if (r.next() < hazard) {
          let qty = l.remaining;
          if (l.remaining > 1 && r.next() < p.partialFillProb) qty = 1 + r.int(l.remaining - 1);
          l.remaining -= qty;
          const grossMinor = l.priceMinor * qty;
          const costs = fillCosts(p, grossMinor, qty, this.drainPlatformAccrual(st));
          const feeMinor = costs.totalMinor;
          st.counters.filled += qty;
          st.counters.feesMinor += feeMinor;
          st.counters.vatCollectedMinor += costs.vatMinor;
          st.counters.logisticsMinor += costs.fulfilmentMinor + costs.packagingMinor;
          st.pending.push({
            channel: st.name,
            offerId: l.offerId,
            sku: l.sku,
            qty,
            unitPriceMinor: l.priceMinor,
            feeMinor,
            costs,
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
  ): { feeMinor: Minor; platformChargeMinor: Minor; dead: boolean; expiresTick: number } {
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
    // Deadness is a property of the SKU, fixed at registration — NOT redrawn per
    // listing. Relisting a dud does not give it a fresh 1-in-5 chance.
    const dead = this.skuOf(st, sku).dead;
    const expiresTick = tick + ttl;
    st.active.set(offerId, { offerId, sku, priceMinor, remaining: qty, listedTick: tick, expiresTick, dead });
    st.counters.listed += 1;
    st.counters.feesMinor += st.params.listingFeeMinor;
    // Overhead accrued since the last transaction falls due now.
    const platformChargeMinor = this.drainPlatformAccrual(st);
    return { feeMinor: st.params.listingFeeMinor, platformChargeMinor, dead, expiresTick };
  }

  /**
   * Collect the platform overhead accrued since it was last collected. Returns
   * the amount and resets the accrual — so overhead is charged exactly once,
   * whichever transaction happens to be the one that collects it.
   */
  private drainPlatformAccrual(st: ChannelState): Minor {
    const due = st.platformAccrualMinor;
    if (due <= 0) return 0;
    st.platformAccrualMinor = 0;
    st.counters.platformChargedMinor += due;
    st.counters.feesMinor += due;
    return due;
  }

  /** Platform overhead accrued on a channel but not yet collected. */
  platformAccrual(channel: string): Minor {
    return this.state(channel).platformAccrualMinor;
  }

  /** Whether a SKU is part of this channel's permanently dead tail. */
  isDeadSku(channel: string, sku: string): boolean {
    return this.skuOf(this.state(channel), sku).dead;
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
    const total: SimCounters = {
      listed: 0,
      filled: 0,
      expired: 0,
      feesMinor: 0,
      buys: 0,
      boughtUnits: 0,
      platformAccruedMinor: 0,
      platformChargedMinor: 0,
      vatCollectedMinor: 0,
      logisticsMinor: 0,
      obsoleted: 0,
    };
    for (const st of this.channels.values()) {
      for (const k of Object.keys(total) as (keyof SimCounters)[]) total[k] += st.counters[k];
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
    const listed = this.sim.listOffer(
      this.name,
      offerId,
      offer.sku,
      offer.price.amount,
      Math.max(1, offer.qty),
      tick,
      typeof offer.meta['ttlTicks'] === 'number' ? (offer.meta['ttlTicks'] as number) : undefined,
    );
    // The listing fee AND any platform overhead that has fallen due are both
    // real cash leaving now, sale or no sale, so both are in the fee the caller
    // books. The split is surfaced in meta for the audit trail.
    const feeMinor = listed.feeMinor + listed.platformChargeMinor;
    this.decorateListing(offer, offerId, tick);
    offer.meta['listingFeeMinor'] = listed.feeMinor;
    offer.meta['platformChargeMinor'] = listed.platformChargeMinor;
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
