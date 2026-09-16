/**
 * channels/digitalassets.ts — genuine two-sided arbitrage, and a trap for the naive.
 * Invariant: buy and sell both go through the simulator's frictions — wide spread,
 * commission on BOTH legs, long settlement, partial fills — so an agent that trades
 * on apparent margin alone loses money. Only a real edge survives the round trip.
 * Callers: scout agent (scan/quote/buy), seller agent (publish/poll), policy engine.
 */

import { AdapterError } from '../core/errors.js';
import type { Minor, Money } from '../core/money.js';
import type { Holding, Offer, Opportunity } from '../core/types.js';
import type { ChannelCapabilities } from './adapter.js';
import { feeOnBps, MarketSimulator, SimulatedChannelAdapter, type ChannelParams } from './simulator.js';

export const DIGITALASSETS_TOS_NOTE =
  'Simulated secondary market for transferable digital assets (licences, credits, domains). ' +
  'PAPER mode only: no external marketplace is contacted and no real order is ever placed. ' +
  'Automated trading here is permitted because the counterparty is the in-process simulator.';

export class DigitalAssetsAdapter extends SimulatedChannelAdapter {
  readonly name = 'digitalassets';

  readonly capabilities: ChannelCapabilities = Object.freeze({
    canBuy: true,
    canSell: true,
    buyRequiresHumanApproval: false,
    jurisdiction: 'GLOBAL',
    tosNote: DIGITALASSETS_TOS_NOTE,
  });

  constructor(sim: MarketSimulator, overrides: Partial<ChannelParams> = {}) {
    super(sim);
    sim.registerChannel('digitalassets', overrides);
  }

  protected buildOpportunities(tick: number, budget: Money): Opportunity[] {
    const listings = this.sim.listings(this.name, tick);
    const p = this.params;
    const out: Opportunity[] = [];
    for (const l of listings) {
      // An opportunity the agent cannot afford at all is noise; drop it early.
      const allIn = l.askMinor + feeOnBps(l.askMinor, p.buyCommissionBps);
      if (allIn > budget.amount) continue;
      out.push({
        id: l.id,
        channel: this.name,
        sku: l.sku,
        title: l.title,
        askPrice: this.m(l.askMinor),
        // NOTE: an ESTIMATE, not the truth. Its error shrinks as confidence rises.
        estResaleValue: this.m(l.estResaleMinor),
        confidence: l.confidence,
        ttlTicks: l.ttlTicks,
        meta: {
          kind: 'arbitrage',
          currency: this.currency,
          spreadBps: p.spreadBps,
          buyCommissionBps: p.buyCommissionBps,
          sellCommissionBps: p.sellCommissionBps,
          settlementDelayTicks: p.settlementDelayTicks,
          // The round-trip cost the agent must beat before it has made anything.
          roundTripFeeMinor: feeOnBps(l.askMinor, p.buyCommissionBps) + feeOnBps(l.askMinor, p.sellCommissionBps),
        },
      });
    }
    return out;
  }

  protected override doBuy(
    o: Opportunity,
    qty: number,
    tick: number,
    idem: string,
  ): { holding: Holding; feeMinor: Minor } {
    if (!Number.isInteger(qty) || qty < 1) {
      throw new AdapterError('SIM_BAD_QTY', `${this.name}.buy(): qty must be a positive integer`, { qty });
    }
    const { filledQty, feeMinor } = this.sim.executeBuy(this.name, o.sku, qty, o.askPrice.amount, tick);
    const holding: Holding = {
      id: `${this.name}:hold:${idem}`,
      channel: this.name,
      sku: o.sku,
      qty: filledQty,
      unitCost: this.m(o.askPrice.amount),
      acquiredTick: tick,
      meta: {
        opportunityId: o.id,
        requestedQty: qty,
        partial: filledQty < qty,
        buyFeeMinor: feeMinor,
        estResaleValueMinor: o.estResaleValue.amount,
        // The cash spent here is NOT recoverable this tick: settlement is slow.
        settlementDelayTicks: this.params.settlementDelayTicks,
      },
    };
    this.log?.info('digital asset acquired', { sku: o.sku, qty: filledQty, requested: qty, feeMinor, tick });
    return { holding, feeMinor };
  }

  protected override decorateListing(offer: Offer, offerId: string, tick: number): void {
    offer.meta['channelListingId'] = offerId;
    offer.meta['listedTick'] = tick;
    offer.meta['settlementDelayTicks'] = this.params.settlementDelayTicks;
  }
}
