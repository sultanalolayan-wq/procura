/**
 * agents/seller.ts — the seller. Turns inventory (bought by a scout, or minted
 * at zero cost) into settled cash, and learns price and copy from what sold.
 * Invariants: an offer is NEVER published below cost of goods + fees unless the
 * holding is past its TTL, in which case the shortfall is an explicit, logged
 * writeoff to the `writeoff` account BEFORE the listing goes up; offers are keyed
 * on the channel-scoped offerId publish() returns; a fill is booked at its
 * SETTLEMENT tick; an unsold listing is only ever discovered via pollExpired(),
 * never inferred from silence. Callers: runtime/supervisor, registry.
 */

import { PolicyDenied } from '../core/errors.js';
import { idempotencyKey } from '../core/ids.js';
import { money, mul, type Minor, type Money } from '../core/money.js';
import type { AgentId, Fill, Holding, Offer, Opportunity } from '../core/types.js';
import type { Envelope } from '../bus/protocol.js';
import { Bandit, PriceLearner } from '../memory/learning.js';
import type { ChannelAdapter } from '../channels/adapter.js';
import { BaseAgent, type AgentDeps } from './base.js';

/** Copy/packaging variants the bandit explores. */
export const OFFER_VARIANTS: readonly string[] = Object.freeze([
  'plain',
  'benchmarked',
  'annotated',
  'bundle',
]);

/** Strategy families the registry can choose between when respawning a seller. */
export const SELLER_STRATEGIES: readonly string[] = Object.freeze(['margin-keeper', 'volume-mover', 'patient-lister']);

interface SellerStyle {
  /** Multiplier applied to the learned price. */
  aggression: number;
  /** Ticks a holding may sit before a below-cost sale becomes permissible. */
  ttlTicks: number;
  /** Price decay applied on each failed re-listing. */
  decay: number;
}

const SELLER_STYLES: Readonly<Record<string, SellerStyle>> = Object.freeze({
  'margin-keeper': { aggression: 1.06, ttlTicks: 36, decay: 0.95 },
  'volume-mover': { aggression: 0.94, ttlTicks: 18, decay: 0.9 },
  'patient-lister': { aggression: 1.0, ttlTicks: 48, decay: 0.97 },
});
const DEFAULT_STYLE: SellerStyle = { aggression: 1.0, ttlTicks: 24, decay: 0.94 };

/** Conservative sell-fee assumption before any fill has been observed. */
export const DEFAULT_SELL_FEE_BPS = 900;
/** How far demand is allowed to move the learned price, either way. */
export const DEMAND_LO = 0.9;
export const DEMAND_HI = 1.12;
/** Re-listings before a holding is given up on. */
export const MAX_RELIST_ATTEMPTS = 6;

/**
 * Structural shape of the expiry notice the simulated adapters hand back. It is
 * declared here rather than imported so the seller depends on a capability, not
 * on the simulator.
 */
export interface ExpiredListing {
  channel: string;
  offerId: string;
  sku: string;
  priceMinor: Minor;
  remaining: number;
  listedTick: number;
  expiredTick: number;
}

interface ExpiryCapable {
  pollExpired(tick: number): Promise<ExpiredListing[]>;
}

interface MintCapable {
  mint(o: Opportunity, qty: number, tick: number, idem: string): Promise<{ holding: Holding; feeMinor: Minor }>;
}

function asExpiryCapable(a: ChannelAdapter): ExpiryCapable | null {
  const probe = a as unknown as Partial<ExpiryCapable>;
  return typeof probe.pollExpired === 'function' ? (probe as ExpiryCapable) : null;
}

function asMintCapable(a: ChannelAdapter): MintCapable | null {
  const probe = a as unknown as Partial<MintCapable>;
  return typeof probe.mint === 'function' ? (probe as MintCapable) : null;
}

/* ------------------------------------------------------------- the floor rule */

export interface ListingDecisionInput {
  /** Carrying value of the units being listed: unitCost * qty. */
  carryingMinor: Minor;
  /** Gross the listing would bring in if it sold at the proposed price. */
  proceedsMinor: Minor;
  sellFeeMinor: Minor;
  listingFeeMinor: Minor;
  ageTicks: number;
  ttlTicks: number;
}

export interface ListingDecision {
  allowed: boolean;
  pastTtl: boolean;
  /** cost of goods + the fees this listing will incur. */
  floorMinor: Minor;
  shortfallMinor: Minor;
  /** What must be written off before a below-floor listing may go up. */
  writeoffMinor: Minor;
  reason: string;
}

/**
 * The one rule that keeps the seller from buying revenue with capital: a listing
 * that cannot clear cost of goods plus fees is refused outright, UNTIL the
 * holding is past its TTL — at which point the shortfall is recognised honestly
 * as a writeoff instead of being smuggled through as a "sale". Pure function.
 */
export function listingDecision(i: ListingDecisionInput): ListingDecision {
  const floorMinor = i.carryingMinor + Math.max(0, i.sellFeeMinor) + Math.max(0, i.listingFeeMinor);
  const shortfallMinor = Math.max(0, floorMinor - i.proceedsMinor);
  const pastTtl = i.ageTicks >= i.ttlTicks;
  if (shortfallMinor === 0) {
    return { allowed: true, pastTtl, floorMinor, shortfallMinor: 0, writeoffMinor: 0, reason: 'clears cost + fees' };
  }
  if (!pastTtl) {
    return {
      allowed: false,
      pastTtl,
      floorMinor,
      shortfallMinor,
      writeoffMinor: 0,
      reason:
        `refused: proceeds ${i.proceedsMinor} is ${shortfallMinor} below the floor ${floorMinor} ` +
        `(cogs ${i.carryingMinor} + fees ${i.sellFeeMinor + i.listingFeeMinor}) and the holding is ` +
        `${i.ageTicks} of ${i.ttlTicks} ticks old — selling below cost is not a strategy`,
    };
  }
  return {
    allowed: true,
    pastTtl,
    floorMinor,
    shortfallMinor,
    // Never write off more than the asset is actually carried at.
    writeoffMinor: Math.min(i.carryingMinor, shortfallMinor),
    reason:
      `past TTL (${i.ageTicks} >= ${i.ttlTicks}): recognising a ${Math.min(i.carryingMinor, shortfallMinor)} ` +
      `writeoff so the markdown is an impairment on the books, not a hidden loss in revenue`,
  };
}

/* ------------------------------------------------------------------- the agent */

interface LiveOffer {
  /** The CHANNEL-SCOPED id: "<channel>:<offer.id>". Fills key on exactly this. */
  offerId: string;
  channel: string;
  sku: string;
  holdingId: string;
  qty: number;
  remaining: number;
  priceMinor: Minor;
  multiplier: number;
  variant: string;
  unitCostMinor: Minor;
  traceId: string | null;
  listedTick: number;
  attempts: number;
}

export interface SellerOptions {
  variants?: readonly string[];
  /** Maximum holdings the seller will mint ahead of demand. */
  maxMintedHoldings?: number;
  style?: Partial<SellerStyle>;
}

export class SellerAgent extends BaseAgent {
  private readonly variantBandit: Bandit;
  private readonly priceLearner: PriceLearner;
  private readonly variants: readonly string[];
  private readonly style: SellerStyle;
  private readonly maxMinted: number;
  private readonly offers = new Map<string, LiveOffer>();
  private readonly offerByHolding = new Map<string, string>();
  /** Re-list attempts per holding, so a dud is eventually given up on. */
  private readonly attempts = new Map<string, number>();
  private readonly listingFeeByChannel = new Map<string, Minor>();
  private offerSeq = 0;
  private published = 0;
  private sold = 0;
  private refusedBelowCost = 0;
  private writeoffs = 0;

  constructor(id: AgentId, strategyId: string, deps: AgentDeps, opts: SellerOptions = {}) {
    super(id, 'seller', strategyId, deps);
    this.variants = opts.variants && opts.variants.length > 0 ? opts.variants : OFFER_VARIANTS;
    this.style = { ...(SELLER_STYLES[strategyId] ?? DEFAULT_STYLE), ...(opts.style ?? {}) };
    this.maxMinted = opts.maxMintedHoldings ?? 3;

    const savedBandit = deps.memory.getFact<unknown>('seller.variantBandit', null);
    this.variantBandit =
      savedBandit === null ? new Bandit([...this.variants], deps.rng) : Bandit.fromJSON(savedBandit, deps.rng);
    for (const v of this.variants) this.variantBandit.addArm(v);

    const savedPrices = deps.memory.getFact<unknown>('seller.priceLearner', null);
    this.priceLearner =
      savedPrices === null ? new PriceLearner(deps.rng) : PriceLearner.fromJSON(savedPrices, deps.rng);

    this.subscribe(['INVENTORY_ADDED'], (e) => this.onInventoryAdded(e));
  }

  get prices(): PriceLearner {
    return this.priceLearner;
  }

  get copy(): Bandit {
    return this.variantBandit;
  }

  liveOffers(): LiveOffer[] {
    return [...this.offers.values()].map((o) => ({ ...o }));
  }

  stats(): { published: number; sold: number; refusedBelowCost: number; writeoffs: number; openOffers: number; holdings: number } {
    return {
      published: this.published,
      sold: this.sold,
      refusedBelowCost: this.refusedBelowCost,
      writeoffs: this.writeoffs,
      openOffers: this.offers.size,
      holdings: this.inventory.size,
    };
  }

  // --------------------------------------------------------------- inventory --

  private onInventoryAdded(e: Envelope): void {
    // Our own mint announcements come back round the bus; ignore them.
    if (e.from === this.id) return;
    const p = e.payload as Record<string, unknown>;
    const holding = p['holding'] as Holding | undefined;
    if (!holding || typeof holding.id !== 'string') {
      this.log.warn('seller.inventory_added_malformed', { from: e.from, tick: e.tick });
      return;
    }
    if (this.inventory.has(holding.id)) return;
    this.addInventory(holding, {
      traceId: e.traceId,
      meta: { source: e.from, estResaleMinor: p['estResaleMinor'] ?? null, acquiredCostMinor: p['costMinor'] ?? null },
    });
    this.log.info('seller.inventory_received', {
      holdingId: holding.id,
      channel: holding.channel,
      sku: holding.sku,
      qty: holding.qty,
      unitCostMinor: holding.unitCost.amount,
      traceId: e.traceId,
    });
  }

  // -------------------------------------------------------------------- tick --

  override async onTick(tick: number): Promise<void> {
    await this.act('poll-fills', () => this.pollFills(tick));
    await this.act('poll-expired', () => this.pollExpiries(tick));
    await this.act('mint', () => this.mintProducts(tick));
    await this.act('list', () => this.listHoldings(tick));
  }

  private sellables(): Array<[string, ChannelAdapter]> {
    return [...this.deps.channels.entries()].filter(([, a]) => a.capabilities.canSell);
  }

  // ------------------------------------------------------------------- fills --

  private async pollFills(tick: number): Promise<void> {
    for (const [name, adapter] of this.sellables()) {
      let fills: Fill[];
      try {
        fills = await adapter.poll(tick);
      } catch (err) {
        this.log.error('seller.poll_failed', { channel: name, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      for (const f of fills) this.bookFill(name, f);
    }
  }

  private bookFill(channel: string, f: Fill): void {
    const live = this.offers.get(f.offerId);
    if (live === undefined) {
      // Not ours (or already reconciled). Never invent inventory to match a fill.
      this.log.warn('seller.orphan_fill', { channel, offerId: f.offerId, qty: f.qty });
      return;
    }
    const qty = Math.max(0, Math.min(f.qty, live.remaining));
    if (qty === 0) return;
    const grossMinor = f.unitPrice.amount * qty;
    const feeMinor = Math.max(0, f.feeMinor);
    const cogsMinor = live.unitCostMinor * qty;
    const proceedsMinor = grossMinor - feeMinor;
    const netMinor = proceedsMinor - cogsMinor;

    // `f.tick` is the SETTLEMENT tick — when the cash is actually available.
    // Booking it at the sale tick would overstate the cash position for the
    // whole settlement delay, which is exactly the lie this simulator punishes.
    this.deps.ledger.append({
      tick: f.tick,
      type: 'SALE',
      agentId: this.id,
      currency: this.cfg.baseCurrency,
      legs: [
        { account: 'cash', amount: proceedsMinor },
        { account: 'fees', amount: feeMinor },
        { account: 'revenue', amount: -grossMinor },
        { account: 'cogs', amount: cogsMinor },
        { account: 'inventory', amount: -cogsMinor },
      ],
      idempotencyKey: idempotencyKey(['seller.sale', this.id, f.offerId, f.tick, qty, f.unitPrice.amount]),
      meta: {
        channel,
        sku: live.sku,
        offerId: f.offerId,
        holdingId: live.holdingId,
        qty,
        unitPriceMinor: f.unitPrice.amount,
        variant: live.variant,
        multiplier: live.multiplier,
        settlementTick: f.tick,
      },
    });

    live.remaining -= qty;
    this.sold += qty;
    const rec = this.inventory.get(live.holdingId);
    if (rec !== undefined) {
      rec.remaining = Math.max(0, rec.remaining - qty);
      if (rec.remaining === 0) this.inventory.delete(live.holdingId);
    }
    if (live.remaining === 0) {
      this.offers.delete(live.offerId);
      this.offerByHolding.delete(live.holdingId);
      this.attempts.delete(live.holdingId);
    }

    // Learning: the price step that sold, and the copy variant that carried it.
    this.priceLearner.observe(live.sku, live.multiplier, true);
    try {
      this.variantBandit.update(live.variant, netMinor > 0 ? 1 : 0);
    } catch (err) {
      this.log.error('seller.variant_update_failed', { variant: live.variant, error: err instanceof Error ? err.message : String(err) });
    }
    this.observeFeeBps(channel, grossMinor, feeMinor);

    this.emit('SALE_FILLED', {
      channel,
      offerId: f.offerId,
      holdingId: live.holdingId,
      sku: live.sku,
      qty,
      unitPriceMinor: f.unitPrice.amount,
      grossMinor,
      feeMinor,
      cogsMinor,
      // Cash in, before cost of goods: what the buyer's round trip actually got.
      proceedsMinor,
      netMinor,
      remaining: live.remaining,
      disposition: 'sold',
      variant: live.variant,
      traceId: live.traceId,
      tick: f.tick,
    });
    this.learn({
      strategyId: `${this.strategyId}/${live.variant}`,
      agentId: this.id,
      tick: f.tick,
      netMinor,
      success: netMinor > 0,
      meta: { kind: 'sale', channel, sku: live.sku, offerId: f.offerId, qty, variant: live.variant, multiplier: live.multiplier },
    });
    this.persist();
  }

  private observeFeeBps(channel: string, grossMinor: Minor, feeMinor: Minor): void {
    if (grossMinor <= 0) return;
    this.deps.memory.observe(`feeBps:${channel}`, (feeMinor * 10_000) / grossMinor);
  }

  private feeBps(channel: string): number {
    const s = this.deps.memory.stat(`feeBps:${channel}`);
    if (s === null || !Number.isFinite(s.ewma) || s.ewma < 0) return DEFAULT_SELL_FEE_BPS;
    // Never assume fees are cheaper than the conservative default until there
    // is real evidence; then trust the observed rate but keep a safety margin.
    return s.n >= 3 ? s.ewma * 1.1 : DEFAULT_SELL_FEE_BPS;
  }

  // ----------------------------------------------------------------- expiry --

  /**
   * pollExpired() is not optional bookkeeping. With a settlement delay, an offer
   * that has gone quiet is indistinguishable from one that sold and has not paid
   * out yet; guessing produces phantom inventory. The expiry notice is the only
   * authoritative "this did NOT sell".
   */
  private async pollExpiries(tick: number): Promise<void> {
    for (const [name, adapter] of this.sellables()) {
      const cap = asExpiryCapable(adapter);
      if (cap === null) continue;
      let expired: ExpiredListing[];
      try {
        expired = await cap.pollExpired(tick);
      } catch (err) {
        this.log.error('seller.poll_expired_failed', { channel: name, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      for (const x of expired) this.handleExpiry(name, x, tick);
    }
  }

  private handleExpiry(channel: string, x: ExpiredListing, tick: number): void {
    const live = this.offers.get(x.offerId);
    if (live === undefined) return;
    this.offers.delete(x.offerId);
    this.offerByHolding.delete(live.holdingId);
    // The price step that FAILED to sell — the other half of the price signal.
    this.priceLearner.observe(live.sku, live.multiplier, false);
    try {
      this.variantBandit.update(live.variant, 0);
    } catch {
      /* an unknown variant cannot be learned from; the listing is still handled */
    }

    const rec = this.inventory.get(live.holdingId);
    const attempts = (this.attempts.get(live.holdingId) ?? 0) + 1;
    this.attempts.set(live.holdingId, attempts);
    this.log.info('seller.listing_expired', {
      channel,
      offerId: x.offerId,
      sku: x.sku,
      remaining: x.remaining,
      attempts,
      priceMinor: x.priceMinor,
    });
    if (rec === undefined) return;
    if (attempts >= MAX_RELIST_ATTEMPTS) {
      this.abandon(live.holdingId, tick, `abandoned after ${attempts} unsold listings`);
    }
    // Otherwise the holding simply returns to the listing queue next tick, where
    // the decay in listOne() marks it down.
  }

  // ------------------------------------------------------------------- mint --

  private async mintProducts(tick: number): Promise<void> {
    if (this.inventory.size >= this.maxMinted) return;
    for (const [name, adapter] of this.deps.channels) {
      const minter = asMintCapable(adapter);
      if (minter === null) continue;
      if (adapter.capabilities.canBuy) continue; // a mintable channel has no buy path
      const wanted = this.variantBandit.select();
      const budget = money(Math.max(0, this.deps.budget.availableCash(this.id)), this.cfg.baseCurrency);
      const opportunities = await adapter.scan(tick, budget);
      const zeroCost = opportunities.filter((o) => o.askPrice.amount === 0);
      if (zeroCost.length === 0) continue;
      const chosen = zeroCost.find((o) => o.meta['variant'] === wanted) ?? (zeroCost[0] as Opportunity);
      const idem = idempotencyKey(['seller.mint', this.id, name, chosen.id, tick]);
      const { holding } = await minter.mint(chosen, 1, tick, idem);
      if (this.inventory.has(holding.id)) continue;
      // Zero acquisition cost means there is nothing to book: a ledger entry of
      // all-zero legs would be noise in an auditor's chain, not information.
      this.addInventory(holding, {
        traceId: null,
        meta: { source: 'mint', estResaleMinor: chosen.estResaleValue.amount, variant: chosen.meta['variant'] ?? wanted },
      });
      this.emit('INVENTORY_ADDED', {
        holding,
        channel: name,
        sku: holding.sku,
        qty: holding.qty,
        unitCostMinor: 0,
        costMinor: 0,
        estResaleMinor: chosen.estResaleValue.amount,
        buyerId: this.id,
        minted: true,
        tick,
      });
      this.log.info('seller.minted', { channel: name, sku: holding.sku, holdingId: holding.id, tick });
      if (this.inventory.size >= this.maxMinted) return;
    }
  }

  // ---------------------------------------------------------------- listing --

  private async listHoldings(tick: number): Promise<void> {
    for (const [holdingId, rec] of [...this.inventory.entries()]) {
      if (this.offerByHolding.has(holdingId)) continue;
      if (rec.remaining <= 0) {
        this.inventory.delete(holdingId);
        continue;
      }
      const adapter = this.deps.channels.get(rec.holding.channel);
      if (adapter === undefined || !adapter.capabilities.canSell) {
        this.log.warn('seller.unsellable_channel', { holdingId, channel: rec.holding.channel });
        continue;
      }
      await this.listOne(adapter, holdingId, tick);
    }
  }

  private async listOne(adapter: ChannelAdapter, holdingId: string, tick: number): Promise<void> {
    const rec = this.inventory.get(holdingId);
    if (rec === undefined) return;
    const channel = adapter.name;
    const qty = rec.remaining;
    const attempts = this.attempts.get(holdingId) ?? 0;
    const variant = this.variantBandit.select();

    // 1. Baseline: what the market is thought to bear, floored at what it cost.
    const estResale = Number(rec.meta['estResaleMinor']);
    const baselineMinor = Math.max(
      1,
      Number.isFinite(estResale) && estResale > 0 ? Math.round(estResale) : Math.round(rec.unitCostMinor * 1.5) || 1,
    );
    const baseline = money(baselineMinor, this.cfg.baseCurrency);
    const suggested = this.priceLearner.suggest(rec.holding.sku, baseline);

    // 2. Demand scales the learned price: a slack market marks it down, a hot
    //    one lets it hold. Then the decay for every listing that already failed.
    let demand = 0.5;
    try {
      demand = await adapter.demandSignal(rec.holding.sku, suggested, tick);
    } catch (err) {
      this.log.warn('seller.demand_signal_failed', { channel, error: err instanceof Error ? err.message : String(err) });
    }
    const demandScale = DEMAND_LO + (DEMAND_HI - DEMAND_LO) * Math.min(1, Math.max(0, demand));
    const decay = Math.pow(this.style.decay, attempts);
    const price = mul(suggested, demandScale * this.style.aggression * decay);
    const priceMinor = Math.max(1, price.amount);
    const multiplier = priceMinor / baselineMinor;

    // 3. THE FLOOR. Below cogs + fees is refused unless the holding is past TTL.
    const carryingMinor = rec.unitCostMinor * qty;
    const proceedsMinor = priceMinor * qty;
    const listingFeeMinor = this.listingFeeByChannel.get(channel) ?? 0;
    const sellFeeMinor = Math.ceil((proceedsMinor * this.feeBps(channel)) / 10_000);
    const ageTicks = tick - rec.acquiredTick;
    const decision = listingDecision({
      carryingMinor,
      proceedsMinor,
      sellFeeMinor,
      listingFeeMinor,
      ageTicks,
      ttlTicks: this.style.ttlTicks,
    });
    if (!decision.allowed) {
      this.refusedBelowCost++;
      this.log.warn('seller.below_cost_refused', {
        holdingId,
        channel,
        sku: rec.holding.sku,
        priceMinor,
        floorMinor: decision.floorMinor,
        shortfallMinor: decision.shortfallMinor,
        ageTicks,
        ttlTicks: this.style.ttlTicks,
        reason: decision.reason,
      });
      return;
    }
    if (decision.writeoffMinor > 0) {
      this.writeOff(holdingId, decision.writeoffMinor, tick, decision.reason);
    }

    // 4. Policy, then publish.
    const current = this.inventory.get(holdingId);
    if (current === undefined) return; // fully written off
    this.offerSeq += 1;
    const offer: Offer = {
      id: `${this.id}-of${String(this.offerSeq).padStart(5, '0')}`,
      holdingId,
      channel,
      sku: rec.holding.sku,
      title: `${rec.holding.sku} [${variant}]`,
      price: money(priceMinor, this.cfg.baseCurrency),
      qty,
      createdTick: tick,
      variant,
      meta: {
        variant,
        multiplier,
        demand,
        attempts,
        carryingMinor: current.unitCostMinor * qty,
        writtenOffMinor: decision.writeoffMinor,
      },
    };
    try {
      this.deps.policy.checkSell(adapter, offer, tick);
    } catch (err) {
      if (err instanceof PolicyDenied) {
        this.emit('POLICY_DENIED', { channel, sku: offer.sku, code: err.code, reason: err.message, stage: 'sell', tick });
        this.log.warn('seller.policy_denied', { channel, sku: offer.sku, code: err.code });
        return;
      }
      throw err;
    }

    const idem = idempotencyKey(['seller.publish', this.id, channel, offer.id, tick]);
    const { offerId, feeMinor } = await adapter.publish(offer, tick, idem);
    this.listingFeeByChannel.set(channel, Math.max(0, feeMinor));
    if (feeMinor > 0) {
      this.deps.ledger.append({
        tick,
        type: 'LISTING_FEE',
        agentId: this.id,
        currency: this.cfg.baseCurrency,
        legs: [
          { account: 'fees', amount: feeMinor },
          { account: 'cash', amount: -feeMinor },
        ],
        idempotencyKey: idem,
        meta: { channel, sku: offer.sku, offerId, holdingId, priceMinor, variant },
      });
    }

    const live: LiveOffer = {
      offerId,
      channel,
      sku: offer.sku,
      holdingId,
      qty,
      remaining: qty,
      priceMinor,
      multiplier,
      variant,
      unitCostMinor: current.unitCostMinor,
      traceId: current.traceId,
      listedTick: tick,
      attempts,
    };
    this.offers.set(offerId, live);
    this.offerByHolding.set(holdingId, offerId);
    this.published++;
    this.emit('OFFER_PUBLISHED', {
      channel,
      offerId,
      holdingId,
      sku: offer.sku,
      qty,
      priceMinor,
      variant,
      multiplier,
      demand,
      feeMinor,
      writtenOffMinor: decision.writeoffMinor,
      traceId: current.traceId,
      tick,
    });
    this.persist();
  }

  // ---------------------------------------------------------------- writeoff --

  /**
   * Recognise an impairment on a holding: writeoff debited, inventory credited,
   * and the holding's carrying value reduced by exactly the same integer amount
   * so the books and the agent's own bookkeeping cannot drift apart. The holding
   * stays on the shelf — this is a markdown, not a disposal.
   */
  private writeOff(holdingId: string, requestedMinor: Minor, tick: number, reason: string): Minor {
    const rec = this.inventory.get(holdingId);
    if (rec === undefined) return 0;
    const carrying = rec.remaining * rec.unitCostMinor;
    const wanted = Math.min(carrying, Math.max(0, Math.round(requestedMinor)));
    if (wanted <= 0) return 0;
    // Integer carrying value: pick the new per-unit cost first, then write off
    // exactly the difference, so remaining * unitCost always equals the books.
    const newUnitCost = rec.remaining > 0 ? Math.floor((carrying - wanted) / rec.remaining) : 0;
    const amount = carrying - newUnitCost * rec.remaining;
    if (amount <= 0) return 0;
    this.deps.ledger.append({
      tick,
      type: 'WRITEOFF',
      agentId: this.id,
      currency: this.cfg.baseCurrency,
      legs: [
        { account: 'writeoff', amount },
        { account: 'inventory', amount: -amount },
      ],
      idempotencyKey: idempotencyKey(['seller.writeoff', this.id, holdingId, tick, amount, rec.remaining]),
      meta: {
        holdingId,
        channel: rec.holding.channel,
        sku: rec.holding.sku,
        qty: rec.remaining,
        reason,
        carryingBeforeMinor: carrying,
        unitCostBeforeMinor: rec.unitCostMinor,
        unitCostAfterMinor: newUnitCost,
      },
    });
    rec.unitCostMinor = newUnitCost;
    this.writeoffs++;
    this.log.warn('seller.writeoff', {
      holdingId,
      sku: rec.holding.sku,
      amountMinor: amount,
      unitCostAfterMinor: newUnitCost,
      reason,
      tick,
    });
    this.learn({
      strategyId: `${this.strategyId}/writeoff`,
      agentId: this.id,
      tick,
      netMinor: -amount,
      success: false,
      meta: { kind: 'writeoff', holdingId, sku: rec.holding.sku, reason, amountMinor: amount },
    });
    return amount;
  }

  /**
   * Give up on a holding: write off whatever it is still carried at and take it
   * off the shelf for good. The buyer that paid for it is told, because a
   * written-off unit is a disposal with ZERO proceeds and that — not the
   * optimistic estimate that justified the purchase — is what its bandit must
   * learn from.
   */
  private abandon(holdingId: string, tick: number, reason: string): void {
    const rec = this.inventory.get(holdingId);
    if (rec === undefined) return;
    const qty = rec.remaining;
    const written = this.writeOff(holdingId, rec.remaining * rec.unitCostMinor, tick, reason);
    this.inventory.delete(holdingId);
    const live = this.offerByHolding.get(holdingId);
    if (live !== undefined) this.offers.delete(live);
    this.offerByHolding.delete(holdingId);
    this.attempts.delete(holdingId);
    this.emit('SALE_FILLED', {
      channel: rec.holding.channel,
      offerId: live ?? null,
      holdingId,
      sku: rec.holding.sku,
      qty,
      unitPriceMinor: 0,
      grossMinor: 0,
      feeMinor: 0,
      cogsMinor: written,
      proceedsMinor: 0,
      netMinor: -written,
      remaining: 0,
      disposition: 'writeoff',
      reason,
      traceId: rec.traceId,
      tick,
    });
    this.log.warn('seller.abandoned', { holdingId, sku: rec.holding.sku, qty, writtenOffMinor: written, reason, tick });
  }

  // ------------------------------------------------------------- persistence --

  private persist(): void {
    try {
      this.deps.memory.setFact('seller.variantBandit', this.variantBandit.toJSON());
      this.deps.memory.setFact('seller.priceLearner', this.priceLearner.toJSON());
    } catch (err) {
      this.log.error('seller.persist_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  protected override async onTerminate(_reason: string): Promise<void> {
    this.persist();
    this.deps.memory.setFact('seller.variantWeights', this.variantBandit.weights());
    this.deps.memory.flush();
  }
}

/** Factory shape the registry uses when it respawns a seller. */
export function sellerFactory(opts: SellerOptions = {}) {
  return (id: AgentId, strategyId: string, deps: AgentDeps): SellerAgent => new SellerAgent(id, strategyId, deps, opts);
}
