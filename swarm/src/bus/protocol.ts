/**
 * bus/protocol.ts — the wire vocabulary of the swarm. Data only, no behaviour.
 * Invariant: every message crossing the bus is an Envelope carrying traceId
 * (constant along a causal chain), causationId (immediate parent) and hops.
 * Callers: bus, every agent, runtime, api.
 */

import type { AgentId } from '../core/types.js';

export type MsgType =
  | 'OPPORTUNITY_FOUND'
  | 'BUY_REQUEST'
  | 'BUY_RESULT'
  | 'INVENTORY_ADDED'
  | 'OFFER_PUBLISHED'
  | 'SALE_FILLED'
  | 'PRICE_ADVICE'
  | 'AUDIT_TICK'
  | 'BUDGET_DENIED'
  | 'HALT'
  | 'AGENT_TERMINATED'
  | 'AGENT_SPAWNED'
  | 'STRATEGY_OUTCOME'
  | 'POLICY_DENIED';

export const MSG_TYPES: readonly MsgType[] = [
  'OPPORTUNITY_FOUND',
  'BUY_REQUEST',
  'BUY_RESULT',
  'INVENTORY_ADDED',
  'OFFER_PUBLISHED',
  'SALE_FILLED',
  'PRICE_ADVICE',
  'AUDIT_TICK',
  'BUDGET_DENIED',
  'HALT',
  'AGENT_TERMINATED',
  'AGENT_SPAWNED',
  'STRATEGY_OUTCOME',
  'POLICY_DENIED',
];

export function isMsgType(v: unknown): v is MsgType {
  return typeof v === 'string' && (MSG_TYPES as readonly string[]).includes(v);
}

export interface Envelope<T = unknown> {
  id: string;
  type: MsgType;
  from: AgentId | 'system';
  to: AgentId | '*';
  tick: number;
  ts: number;
  traceId: string;
  causationId: string | null;
  hops: number;
  payload: T;
}
