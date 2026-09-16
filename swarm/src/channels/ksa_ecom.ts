/**
 * channels/ksa_ecom.ts — Saudi marketplace channel. SELL side only, in SAR.
 * Invariant: buy() throws PolicyDenied UNCONDITIONALLY — automated purchasing is
 * prohibited by the marketplaces' terms of service, so the refusal lives in the
 * adapter itself and not merely in a capability flag the policy engine reads.
 * Callers: seller agent (publish/poll/demandSignal), policy engine, orchestrator.
 */

import { AdapterError, PolicyDenied } from '../core/errors.js';
import type { Minor, Money } from '../core/money.js';
import type { Holding, Offer, Opportunity } from '../core/types.js';
import type { ChannelCapabilities } from './adapter.js';
import { MarketSimulator, SimulatedChannelAdapter, type ChannelParams } from './simulator.js';

export const KSA_ECOM_TOS_NOTE =
  'Automated purchasing is PROHIBITED by the terms of service of the Saudi marketplace ' +
  'platforms this channel models (automated ordering, bots and scripted checkout are ' +
  'disallowed). The buy path therefore requires a human in the loop: a person must review ' +
  'and place any purchase manually. Selling/listing is permitted for a merchant account. ' +
  'Jurisdiction: SA.';

/**
 * ASSUMPTION — NOT VERIFIED LAW. The VAT rate is a configuration parameter
 * (params.vatRateBps), defaulted in simulator.ts, and the prices this channel
 * displays follow a VAT-INCLUSIVE convention. Nothing in this code should be
 * read as a statement of the current statutory rate; the legal reviewer must
 * confirm both the rate and the display obligation before any real use.
 */
export const VAT_ASSUMPTION_NOTE =
  'CONFIGURABLE ASSUMPTION, PENDING LEGAL REVIEW: displayed prices are treated as ' +
  'VAT-inclusive at params.vatRateBps. The rate is not asserted to be the current ' +
  'statutory rate and must be confirmed by the legal reviewer.';

export interface VatBreakdown {
  /** The VAT-inclusive price as displayed to a buyer. */
  grossMinor: Minor;
  /** Price excluding VAT. */
  netMinor: Minor;
  /** VAT component, gross - net. */
  vatMinor: Minor;
  vatRateBps: number;
  vatInclusive: true;
  assumption: string;
}

export class KsaEcomAdapter extends SimulatedChannelAdapter {
  readonly name = 'ksa_ecom';

  readonly capabilities: ChannelCapabilities = Object.freeze({
    canBuy: true,
    // The flag the policy engine reads...
    buyRequiresHumanApproval: true,
    canSell: true,
    jurisdiction: 'SA',
    tosNote: KSA_ECOM_TOS_NOTE,
  });

  constructor(sim: MarketSimulator, overrides: Partial<ChannelParams> = {}) {
    super(sim);
    // SAR is not negotiable on this channel, whatever the caller passes.
    sim.registerChannel('ksa_ecom', { ...overrides, currency: 'SAR' });
  }

  /** Split a VAT-inclusive SAR price into net + VAT. Integer math throughout. */
  vatBreakdown(grossMinor: Minor): VatBreakdown {
    const rate = this.params.vatRateBps;
    const netMinor = Math.round((grossMinor * 10_000) / (10_000 + rate));
    return {
      grossMinor,
      netMinor,
      vatMinor: grossMinor - netMinor,
      vatRateBps: rate,
      vatInclusive: true,
      assumption: VAT_ASSUMPTION_NOTE,
    };
  }

  protected buildOpportunities(tick: number, budget: Money): Opportunity[] {
    const listings = this.sim.listings(this.name, tick);
    const out: Opportunity[] = [];
    for (const l of listings) {
      if (l.askMinor > budget.amount) continue;
      out.push({
        id: l.id,
        channel: this.name,
        sku: l.sku,
        title: l.title,
        askPrice: this.m(l.askMinor),
        estResaleValue: this.m(l.estResaleMinor),
        confidence: l.confidence,
        ttlTicks: l.ttlTicks,
        meta: {
          kind: 'ksa_listing',
          currency: this.currency,
          // Surfaced so a human reviewer sees the constraint on the same screen.
          buyRequiresHumanApproval: true,
          automatedPurchaseProhibited: true,
          tosNote: KSA_ECOM_TOS_NOTE,
          vat: this.vatBreakdown(l.askMinor),
        },
      });
    }
    return out;
  }

  /**
   * ALWAYS DENIES. Defence in depth: this refusal is unconditional and comes
   * BEFORE the init/ready check, so a mis-wired caller, a replayed idempotency
   * key or a policy engine bug can never turn into an automated purchase.
   */
  override async buy(o: Opportunity, qty: number, tick: number, idem: string): Promise<{ holding: Holding; feeMinor: Minor }> {
    throw new PolicyDenied(
      'TOS_AUTOMATED_PURCHASE_PROHIBITED',
      `${this.name}.buy() refused: automated purchasing is prohibited by the terms of service of the ` +
        `Saudi marketplace platforms this channel models. Any purchase requires a human in the loop. ` +
        `This adapter has no automated buy path at all.`,
      {
        channel: this.name,
        jurisdiction: this.capabilities.jurisdiction,
        buyRequiresHumanApproval: true,
        tosNote: KSA_ECOM_TOS_NOTE,
        sku: o?.sku ?? null,
        qty: qty ?? null,
        tick: tick ?? null,
        idem: idem ?? null,
        note: 'this refusal precedes the init/ready check on purpose',
      },
    );
  }

  /** Quoting is informational only; it can never lead to an automated purchase. */
  override async quote(o: Opportunity, tick: number): Promise<{ unitCost: Money; feeMinor: Minor }> {
    this.assertReady('quote');
    this.assertCurrency(o.askPrice, 'quote');
    this.sim.advanceTo(tick);
    // No buy commission is quoted because there is no automated buy path.
    return { unitCost: o.askPrice, feeMinor: 0 };
  }

  protected override decorateListing(offer: Offer, offerId: string, tick: number): void {
    if (offer.price.currency !== 'SAR') {
      throw new AdapterError('ADAPTER_CURRENCY_MISMATCH', `${this.name}: offers must be priced in SAR`, {
        actual: offer.price.currency,
      });
    }
    offer.meta['channelListingId'] = offerId;
    offer.meta['listedTick'] = tick;
    offer.meta['vat'] = this.vatBreakdown(offer.price.amount);
    offer.meta['priceDisplay'] = 'VAT_INCLUSIVE';
    offer.meta['jurisdiction'] = 'SA';
  }
}
