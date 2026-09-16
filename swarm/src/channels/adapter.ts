/**
 * channels/adapter.ts — the ONLY contract between the swarm and the outside world.
 * Invariant: this file declares behaviour, it never implements it; every adapter
 * is policy-gated before use and in PAPER mode must never move real funds.
 * Callers: policy engine, scout/seller agents, orchestrator. Implemented in WAVE B3.
 */

import type { AresConfig } from '../core/config.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Rng } from '../core/rng.js';
import type { Minor, Money } from '../core/money.js';
import type { Fill, Holding, Offer, Opportunity } from '../core/types.js';

export interface ChannelCapabilities {
  canBuy: boolean;
  canSell: boolean;
  buyRequiresHumanApproval: boolean;
  tosNote: string;
  jurisdiction: string;
}

export interface ChannelContext {
  cfg: AresConfig;
  rng: Rng;
  clock: Clock;
  logger: Logger;
}

export interface ChannelAdapter {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  init(ctx: ChannelContext): Promise<void>;
  scan(tick: number, budget: Money): Promise<Opportunity[]>;
  quote(o: Opportunity, tick: number): Promise<{ unitCost: Money; feeMinor: Minor }>;
  buy(o: Opportunity, qty: number, tick: number, idem: string): Promise<{ holding: Holding; feeMinor: Minor }>;
  publish(offer: Offer, tick: number, idem: string): Promise<{ offerId: string; feeMinor: Minor }>;
  /** Fills accumulated since the previous poll. */
  poll(tick: number): Promise<Fill[]>;
  /** Estimated sell-through probability in [0,1]. */
  demandSignal(sku: string, price: Money, tick: number): Promise<number>;
  close(): Promise<void>;
}
