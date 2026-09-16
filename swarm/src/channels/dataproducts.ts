/**
 * channels/dataproducts.ts — self-produced digital goods. SELL ONLY.
 * Invariant: there is no acquisition path (canBuy=false, buy() refuses); the agent
 * MINTS inventory at zero cost via mint(), so profit is a pure function of pricing
 * and offer quality. High margin, deliberately low and slow demand.
 * Callers: seller agent (mint/publish/poll), policy engine, orchestrator.
 */

import { AdapterError } from '../core/errors.js';
import type { Minor, Money } from '../core/money.js';
import type { Holding, Offer, Opportunity } from '../core/types.js';
import type { ChannelCapabilities } from './adapter.js';
import { MarketSimulator, SimulatedChannelAdapter, type ChannelParams } from './simulator.js';

export const DATAPRODUCTS_TOS_NOTE =
  'Self-produced data products. There is no acquisition path and no third-party marketplace ' +
  'is scraped, ordered from, or automated against: every unit is minted by this system at zero ' +
  'cost, so no purchasing terms of service apply. Selling is first-party.';

/** Copy/packaging variants a seller may A/B. Quality shifts the achievable price. */
export const PRODUCT_VARIANTS: readonly string[] = ['plain', 'benchmarked', 'annotated', 'bundle'];

/** Multiplier on the latent value attributed to the packaging variant. */
const VARIANT_QUALITY: Readonly<Record<string, number>> = Object.freeze({
  plain: 0.9,
  benchmarked: 1.05,
  annotated: 1.12,
  bundle: 1.2,
});

export class DataProductsAdapter extends SimulatedChannelAdapter {
  readonly name = 'dataproducts';

  readonly capabilities: ChannelCapabilities = Object.freeze({
    canBuy: false,
    canSell: true,
    buyRequiresHumanApproval: false,
    jurisdiction: 'GLOBAL',
    tosNote: DATAPRODUCTS_TOS_NOTE,
  });

  constructor(sim: MarketSimulator, overrides: Partial<ChannelParams> = {}) {
    super(sim);
    sim.registerChannel('dataproducts', overrides);
  }

  /**
   * Production opportunities. askPrice is ZERO — the acquisition cost of a data
   * product is zero because the agent makes it. estResaleValue is still only an
   * ESTIMATE of what the market will bear, with the usual error.
   */
  protected buildOpportunities(tick: number, budget: Money): Opportunity[] {
    const listings = this.sim.listings(this.name, tick);
    const out: Opportunity[] = [];
    for (const l of listings) {
      // A zero-cost opportunity is always affordable, but an empty budget still
      // means the agent has nothing to spend on listing fees downstream.
      if (budget.amount < 0) break;
      const variant = PRODUCT_VARIANTS[l.id.length % PRODUCT_VARIANTS.length] ?? 'plain';
      const quality = VARIANT_QUALITY[variant] ?? 1;
      out.push({
        id: l.id,
        channel: this.name,
        sku: l.sku,
        title: `${l.title} (${variant})`,
        askPrice: this.m(0),
        estResaleValue: this.m(Math.max(1, Math.round(l.estResaleMinor * quality))),
        confidence: l.confidence,
        ttlTicks: l.ttlTicks,
        meta: {
          kind: 'production',
          variant,
          qualityMultiplier: quality,
          productionCostMinor: 0,
          currency: this.currency,
          note: 'zero acquisition cost: this unit is minted, not bought',
        },
      });
    }
    return out;
  }

  /**
   * MINT inventory. This is the dataproducts analogue of a buy: it creates a
   * holding at zero unit cost. Idempotent on `idem` — a replay returns the same
   * holding and charges nothing a second time.
   */
  async mint(o: Opportunity, qty: number, tick: number, idem: string): Promise<{ holding: Holding; feeMinor: Minor }> {
    this.assertReady('mint');
    this.assertCurrency(o.askPrice, 'mint');
    if (!Number.isInteger(qty) || qty < 1) {
      throw new AdapterError('SIM_BAD_QTY', `${this.name}.mint(): qty must be a positive integer`, { qty });
    }
    const prior = this.buyIdem.get(idem);
    if (prior) return prior;
    if (o.askPrice.amount !== 0) {
      throw new AdapterError('DATAPRODUCT_NOT_FREE', `${this.name}.mint(): production cost must be zero`, {
        askPrice: o.askPrice.amount,
      });
    }
    const holding: Holding = {
      id: `${this.name}:hold:${idem}`,
      channel: this.name,
      sku: o.sku,
      qty,
      unitCost: this.m(0),
      acquiredTick: tick,
      meta: {
        kind: 'minted',
        opportunityId: o.id,
        variant: o.meta['variant'] ?? 'plain',
        estResaleValueMinor: o.estResaleValue.amount,
      },
    };
    const result = { holding, feeMinor: 0 };
    this.buyIdem.set(idem, result);
    this.log?.info('data product minted', { sku: o.sku, qty, tick, holdingId: holding.id });
    return result;
  }

  /** There is no acquisition path on this channel; mint() is the way in. */
  override async buy(): Promise<{ holding: Holding; feeMinor: Minor }> {
    this.assertReady('buy');
    throw new AdapterError(
      'CHANNEL_CANNOT_BUY',
      `${this.name}: this channel cannot buy — data products are minted at zero cost via mint()`,
      { channel: this.name },
    );
  }

  protected override decorateListing(offer: Offer, offerId: string, tick: number): void {
    offer.meta['channelListingId'] = offerId;
    offer.meta['listedTick'] = tick;
    offer.meta['zeroCostOfGoods'] = true;
  }
}
