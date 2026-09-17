/**
 * core/types.ts — the shared domain vocabulary of the swarm.
 * Invariant: these are pure data shapes; no behaviour, no imports beyond money.
 * Every price/cost field is Money (integer minor units), never a float.
 * Callers: agents, channels, governance, memory, api.
 */

import type { Minor, Money } from './money.js';

export type AgentId = string;
export type AgentRole = 'scout' | 'seller' | 'treasury' | 'orchestrator' | 'trader';
export type AgentStatus = 'active' | 'probation' | 'quarantined' | 'terminated';

export interface Opportunity {
  id: string;
  channel: string;
  sku: string;
  title: string;
  askPrice: Money;
  estResaleValue: Money;
  confidence: number;
  ttlTicks: number;
  meta: Record<string, unknown>;
}

export interface Holding {
  id: string;
  channel: string;
  sku: string;
  qty: number;
  unitCost: Money;
  acquiredTick: number;
  meta: Record<string, unknown>;
}

export interface Offer {
  id: string;
  holdingId: string | null;
  channel: string;
  sku: string;
  title: string;
  price: Money;
  qty: number;
  createdTick: number;
  variant: string;
  meta: Record<string, unknown>;
}

export interface Fill {
  offerId: string;
  qty: number;
  unitPrice: Money;
  feeMinor: Minor;
  tick: number;
}

export interface StrategyOutcome {
  strategyId: string;
  agentId: AgentId;
  tick: number;
  netMinor: Minor;
  success: boolean;
  meta: Record<string, unknown>;
}
