/**
 * governance/budget.ts — the reservation protocol that stops two agents from
 * spending the same riyal in the same tick.
 * Invariants: reserve() fails CLOSED (every refusal is a BudgetDenied with a
 * distinct reason code); OUTSTANDING reservations reduce availability exactly
 * like spent money; a reservation settles at most once; committing more than
 * was reserved is impossible; token cost is integer minor units, rounded UP.
 * Callers: agents (via AgentDeps), treasury (reallocate/drawdown), api.
 */

import { BudgetDenied } from '../core/errors.js';
import { idempotencyKey } from '../core/ids.js';
import type { AresConfig } from '../core/config.js';
import type { Ledger } from '../core/ledger.js';
import type { Logger } from '../core/logger.js';
import type { Minor } from '../core/money.js';
import type { AgentId } from '../core/types.js';
import type { KillSwitch } from './killswitch.js';

export type Resource = 'cash' | 'tokens';

export interface Reservation {
  id: string;
  agentId: AgentId;
  resource: Resource;
  amount: number;
  tick: number;
}

/** Every way a spend can be refused. Stable strings — alerts key off these. */
export const BudgetDeny = {
  HALTED: 'BUDGET_HALTED',
  UNKNOWN_AGENT: 'BUDGET_UNKNOWN_AGENT',
  AGENT_TERMINATED: 'BUDGET_AGENT_TERMINATED',
  INVALID_AMOUNT: 'BUDGET_INVALID_AMOUNT',
  INVALID_RESOURCE: 'BUDGET_INVALID_RESOURCE',
  TRADE_CAP: 'BUDGET_TRADE_CAP',
  AGENT_CAP: 'BUDGET_AGENT_CAP',
  GLOBAL_CAP: 'BUDGET_GLOBAL_CAP',
  INSUFFICIENT_CASH: 'BUDGET_INSUFFICIENT_CASH',
  INSUFFICIENT_TOKENS: 'BUDGET_INSUFFICIENT_TOKENS',
  UNKNOWN_RESERVATION: 'BUDGET_UNKNOWN_RESERVATION',
  RESERVATION_SETTLED: 'BUDGET_RESERVATION_SETTLED',
  OVERSPEND: 'BUDGET_OVERSPEND',
  REALLOCATE_SELF: 'BUDGET_REALLOCATE_SELF',
  DUPLICATE_AGENT: 'BUDGET_DUPLICATE_AGENT',
} as const;
export type BudgetDenyCode = (typeof BudgetDeny)[keyof typeof BudgetDeny];

export interface AgentBudgetSnapshot {
  agentId: AgentId;
  terminated: boolean;
  cashCapMinor: Minor;
  cashSpentMinor: Minor;
  cashOutstandingMinor: Minor;
  availableCashMinor: Minor;
  tokenCap: number;
  tokensUsed: number;
  tokensOutstanding: number;
  availableTokens: number;
}

export interface BudgetSnapshot {
  halted: boolean;
  cash: {
    onHandMinor: Minor;
    startingMinor: Minor;
    globalCapMinor: Minor;
    spentMinor: Minor;
    outstandingMinor: Minor;
    drawdownMinor: Minor;
  };
  tokens: { globalCap: number; used: number; outstanding: number; costMinor: Minor };
  reservationsOpen: number;
  agents: AgentBudgetSnapshot[];
}

type ReservationState = 'open' | 'committed' | 'released';

interface AgentRow {
  agentId: AgentId;
  terminated: boolean;
  cashCapMinor: Minor;
  tokenCap: number;
  cashSpentMinor: Minor;
  tokensUsed: number;
}

interface Held {
  res: Reservation;
  state: ReservationState;
}

const TOKENS_PER_MTOK = 1_000_000;

/**
 * Integer cost of `tokens` tokens at `pricePerMTok` minor units per million
 * tokens, rounded UP so token spend is never under-charged to the ledger.
 */
export function tokenCostMinor(tokens: number, pricePerMTok: Minor): Minor {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new BudgetDenied(BudgetDeny.INVALID_AMOUNT, `tokenCostMinor: tokens must be a non-negative integer, got ${String(tokens)}`, {
      tokens,
    });
  }
  if (!Number.isSafeInteger(pricePerMTok) || pricePerMTok < 0) {
    throw new BudgetDenied(BudgetDeny.INVALID_AMOUNT, `tokenCostMinor: price must be a non-negative integer, got ${String(pricePerMTok)}`, {
      pricePerMTok,
    });
  }
  const product = tokens * pricePerMTok;
  if (!Number.isSafeInteger(product)) {
    throw new BudgetDenied(BudgetDeny.INVALID_AMOUNT, `tokenCostMinor: ${tokens} x ${pricePerMTok} overflows safe integers`, {
      tokens,
      pricePerMTok,
    });
  }
  const whole = Math.floor(product / TOKENS_PER_MTOK);
  return product % TOKENS_PER_MTOK === 0 ? whole : whole + 1;
}

export class BudgetGovernor {
  private readonly agents = new Map<AgentId, AgentRow>();
  private readonly held = new Map<string, Held>();
  /** Per (agent|tick|model) call counter, so each charge gets its own key. */
  private readonly chargeSeq = new Map<string, number>();
  private resSeq = 0;
  private tokenCostSpentMinor: Minor = 0;

  constructor(
    private readonly cfg: AresConfig,
    private readonly ledger: Ledger,
    private readonly logger: Logger,
    private readonly killSwitch: KillSwitch,
  ) {}

  // ---------------------------------------------------------------- agents --

  /** Enrol an agent with its caps (defaults come from config). */
  register(agentId: AgentId, caps: { cashCapMinor?: Minor; tokenCap?: number } = {}): void {
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw new BudgetDenied(BudgetDeny.UNKNOWN_AGENT, 'register(): agentId must be a non-empty string', { agentId });
    }
    if (this.agents.has(agentId)) {
      throw new BudgetDenied(BudgetDeny.DUPLICATE_AGENT, `register(): agent ${agentId} is already registered`, {
        agentId,
      });
    }
    this.agents.set(agentId, {
      agentId,
      terminated: false,
      cashCapMinor: clampInt(caps.cashCapMinor ?? this.cfg.budget.perAgentCashCapMinor),
      tokenCap: clampInt(caps.tokenCap ?? this.cfg.budget.perAgentTokenCap),
      cashSpentMinor: 0,
      tokensUsed: 0,
    });
    this.logger.info('budget.agent_registered', { agentId });
  }

  has(agentId: AgentId): boolean {
    return this.agents.has(agentId);
  }

  /** Mark an agent dead: releases its open reservations and zeroes its caps. */
  terminateAgent(agentId: AgentId, reason = 'terminated'): void {
    const row = this.mustAgent(agentId, false);
    this.releaseAllFor(agentId, `agent_terminated:${reason}`);
    row.terminated = true;
    row.cashCapMinor = row.cashSpentMinor;
    row.tokenCap = row.tokensUsed;
    this.logger.warn('budget.agent_terminated', { agentId, reason });
  }

  /** Treasury uses this to halve caps on PROBATION. Never below what is spent. */
  setCaps(agentId: AgentId, caps: { cashCapMinor?: Minor; tokenCap?: number }): void {
    const row = this.mustAgent(agentId, false);
    if (caps.cashCapMinor !== undefined) row.cashCapMinor = Math.max(row.cashSpentMinor, clampInt(caps.cashCapMinor));
    if (caps.tokenCap !== undefined) row.tokenCap = Math.max(row.tokensUsed, clampInt(caps.tokenCap));
    this.logger.info('budget.caps_set', { agentId, cashCapMinor: row.cashCapMinor, tokenCap: row.tokenCap });
  }

  /**
   * Book the opening balance (cash debit / equity credit) exactly once, so that
   * drawdown and cash-on-hand have a truthful basis. Idempotent by key.
   */
  bootstrap(tick = 0): void {
    const starting = this.cfg.budget.startingCashMinor;
    if (starting <= 0) return;
    const key = idempotencyKey(['budget.opening', this.cfg.baseCurrency, starting]);
    if (this.ledger.has(key)) return;
    this.ledger.append({
      tick,
      type: 'OPENING_BALANCE',
      agentId: 'system',
      currency: this.cfg.baseCurrency,
      legs: [
        { account: 'cash', amount: starting },
        { account: 'equity', amount: -starting },
      ],
      idempotencyKey: key,
      meta: { startingCashMinor: starting },
    });
  }

  // ----------------------------------------------------------- reservations --

  /**
   * Reserve headroom BEFORE spending. Checked in order: halt, agent liveness,
   * amount shape, per-trade cap (cash only), per-agent cap, global cap, and
   * finally what is actually available once every other open reservation is
   * subtracted. Every failure throws BudgetDenied with a distinct code.
   */
  reserve(agentId: AgentId, resource: Resource, amount: number, tick: number): Reservation {
    if (this.killSwitch.tripped) {
      throw this.deny(BudgetDeny.HALTED, `reserve refused: swarm halted (${this.killSwitch.reason ?? 'unknown'})`, {
        agentId,
        resource,
        amount,
        tick,
      });
    }
    const row = this.agents.get(agentId);
    if (row === undefined) {
      throw this.deny(BudgetDeny.UNKNOWN_AGENT, `reserve refused: agent ${String(agentId)} is not registered`, {
        agentId,
        resource,
        amount,
      });
    }
    if (row.terminated) {
      throw this.deny(BudgetDeny.AGENT_TERMINATED, `reserve refused: agent ${agentId} is terminated`, {
        agentId,
        resource,
        amount,
      });
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw this.deny(BudgetDeny.INVALID_AMOUNT, `reserve refused: amount must be a positive integer, got ${String(amount)}`, {
        agentId,
        resource,
        amount,
      });
    }
    if (resource !== 'cash' && resource !== 'tokens') {
      throw this.deny(BudgetDeny.INVALID_RESOURCE, `reserve refused: unknown resource ${String(resource)}`, {
        agentId,
        resource,
      });
    }

    if (resource === 'cash') this.checkCash(row, amount, tick);
    else this.checkTokens(row, amount, tick);

    this.resSeq++;
    const res: Reservation = {
      id: `res_${String(this.resSeq).padStart(8, '0')}_${agentId}`,
      agentId,
      resource,
      amount,
      tick,
    };
    this.held.set(res.id, { res, state: 'open' });
    this.logger.debug('budget.reserved', { id: res.id, agentId, resource, amount, tick });
    return res;
  }

  private checkCash(row: AgentRow, amount: number, tick: number): void {
    const b = this.cfg.budget;
    if (amount > b.perTradeCapMinor) {
      throw this.deny(BudgetDeny.TRADE_CAP, `reserve refused: ${amount} exceeds per-trade cap ${b.perTradeCapMinor}`, {
        agentId: row.agentId,
        amount,
        cap: b.perTradeCapMinor,
        tick,
      });
    }
    const agentUsed = row.cashSpentMinor + this.outstandingFor(row.agentId, 'cash');
    if (agentUsed + amount > row.cashCapMinor) {
      throw this.deny(BudgetDeny.AGENT_CAP, `reserve refused: ${amount} would breach agent cash cap ${row.cashCapMinor} (used ${agentUsed})`, {
        agentId: row.agentId,
        amount,
        used: agentUsed,
        cap: row.cashCapMinor,
        tick,
      });
    }
    const globalUsed = this.globalSpent('cash') + this.outstandingFor(null, 'cash');
    if (globalUsed + amount > b.globalCashCapMinor) {
      throw this.deny(BudgetDeny.GLOBAL_CAP, `reserve refused: ${amount} would breach global cash cap ${b.globalCashCapMinor} (used ${globalUsed})`, {
        agentId: row.agentId,
        amount,
        used: globalUsed,
        cap: b.globalCashCapMinor,
        tick,
      });
    }
    // The double-spend guard: real money on hand, minus everything already
    // promised to some other reservation that has not settled yet.
    const free = this.cashOnHand() - this.outstandingFor(null, 'cash');
    if (amount > free) {
      throw this.deny(BudgetDeny.INSUFFICIENT_CASH, `reserve refused: ${amount} exceeds unreserved cash ${free}`, {
        agentId: row.agentId,
        amount,
        free,
        onHand: this.cashOnHand(),
        outstanding: this.outstandingFor(null, 'cash'),
        tick,
      });
    }
  }

  private checkTokens(row: AgentRow, amount: number, tick: number): void {
    const b = this.cfg.budget;
    const agentUsed = row.tokensUsed + this.outstandingFor(row.agentId, 'tokens');
    if (agentUsed + amount > row.tokenCap) {
      throw this.deny(BudgetDeny.AGENT_CAP, `reserve refused: ${amount} tokens would breach agent token cap ${row.tokenCap} (used ${agentUsed})`, {
        agentId: row.agentId,
        amount,
        used: agentUsed,
        cap: row.tokenCap,
        tick,
      });
    }
    const globalUsed = this.globalSpent('tokens') + this.outstandingFor(null, 'tokens');
    if (globalUsed + amount > b.globalTokenCap) {
      throw this.deny(BudgetDeny.GLOBAL_CAP, `reserve refused: ${amount} tokens would breach global token cap ${b.globalTokenCap} (used ${globalUsed})`, {
        agentId: row.agentId,
        amount,
        used: globalUsed,
        cap: b.globalTokenCap,
        tick,
      });
    }
    const free = b.globalTokenCap - globalUsed;
    if (amount > free) {
      throw this.deny(BudgetDeny.INSUFFICIENT_TOKENS, `reserve refused: ${amount} tokens exceed unreserved tokens ${free}`, {
        agentId: row.agentId,
        amount,
        free,
        tick,
      });
    }
  }

  /**
   * Settle a reservation for what was ACTUALLY spent. `actual` may be less than
   * reserved (the slack is returned) but never more. Token commits price the
   * spend into the ledger (compute debit / cash credit) idempotently.
   */
  commit(res: Reservation, actual: number, meta: Record<string, unknown> = {}): void {
    const h = this.mustHeld(res, 'commit');
    if (!Number.isSafeInteger(actual) || actual < 0) {
      throw this.deny(BudgetDeny.INVALID_AMOUNT, `commit refused: actual must be a non-negative integer, got ${String(actual)}`, {
        id: res.id,
        actual,
      });
    }
    if (actual > h.res.amount) {
      throw this.deny(BudgetDeny.OVERSPEND, `commit refused: actual ${actual} exceeds reserved ${h.res.amount}`, {
        id: h.res.id,
        agentId: h.res.agentId,
        reserved: h.res.amount,
        actual,
      });
    }
    const row = this.mustAgent(h.res.agentId, false);
    // State moves BEFORE the ledger write so a throwing ledger cannot leave the
    // reservation open AND charged; the write itself is idempotency-keyed.
    h.state = 'committed';
    if (h.res.resource === 'cash') {
      row.cashSpentMinor += actual;
    } else {
      row.tokensUsed += actual;
      this.writeTokenCost(h.res.agentId, actual, h.res.tick, ['budget.commit', h.res.id], {
        ...meta,
        reservationId: h.res.id,
      });
    }
    this.logger.debug('budget.committed', { id: h.res.id, agentId: h.res.agentId, resource: h.res.resource, actual });
  }

  /** Give back an unused reservation. Throws if it was already settled. */
  release(res: Reservation): void {
    const h = this.mustHeld(res, 'release');
    h.state = 'released';
    this.logger.debug('budget.released', { id: h.res.id, agentId: h.res.agentId, resource: h.res.resource });
  }

  private mustHeld(res: Reservation, op: string): Held {
    const id = res === null || typeof res !== 'object' ? '' : String(res.id ?? '');
    const h = this.held.get(id);
    if (h === undefined) {
      throw this.deny(BudgetDeny.UNKNOWN_RESERVATION, `${op} refused: no such reservation ${id || '<none>'}`, { id });
    }
    if (h.state !== 'open') {
      throw this.deny(BudgetDeny.RESERVATION_SETTLED, `${op} refused: reservation ${id} is already ${h.state}`, {
        id,
        state: h.state,
      });
    }
    return h;
  }

  /** Reservation ids currently open (optionally for one agent). */
  openReservations(agentId?: AgentId): Reservation[] {
    const out: Reservation[] = [];
    for (const h of this.held.values()) {
      if (h.state !== 'open') continue;
      if (agentId !== undefined && h.res.agentId !== agentId) continue;
      out.push({ ...h.res });
    }
    return out;
  }

  private releaseAllFor(agentId: AgentId, reason: string): number {
    let n = 0;
    for (const h of this.held.values()) {
      if (h.state === 'open' && h.res.agentId === agentId) {
        h.state = 'released';
        n++;
      }
    }
    if (n > 0) this.logger.info('budget.released_all', { agentId, count: n, reason });
    return n;
  }

  // ------------------------------------------------------------- accounting --

  /**
   * Charge already-incurred token spend to the ledger: compute debit, cash
   * credit. Idempotent per (agent, tick, call): the Nth call in a given
   * (agent, tick, model) always produces the same idempotency key, so a replay
   * of the same sequence never double-charges.
   */
  chargeTokens(agentId: AgentId, tokens: number, tick: number, model?: string): void {
    const row = this.mustAgent(agentId, false);
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw this.deny(BudgetDeny.INVALID_AMOUNT, `chargeTokens refused: tokens must be a non-negative integer, got ${String(tokens)}`, {
        agentId,
        tokens,
      });
    }
    if (tokens === 0) return;
    const m = model ?? 'default';
    const bucket = `${agentId}|${tick}|${m}`;
    const n = (this.chargeSeq.get(bucket) ?? 0) + 1;
    this.chargeSeq.set(bucket, n);
    row.tokensUsed += tokens;
    this.writeTokenCost(agentId, tokens, tick, ['budget.tokens', m, n], { model: m, call: n });
  }

  private writeTokenCost(
    agentId: AgentId,
    tokens: number,
    tick: number,
    keyParts: unknown[],
    meta: Record<string, unknown>,
  ): void {
    const cost = tokenCostMinor(tokens, this.cfg.budget.tokenPriceMinorPerMTok);
    if (cost === 0) return;
    const key = idempotencyKey([...keyParts, agentId, tick, tokens]);
    if (this.ledger.has(key)) {
      this.logger.debug('budget.token_charge_deduped', { agentId, tick, tokens, key });
      return;
    }
    this.ledger.append({
      tick,
      type: 'TOKEN_SPEND',
      agentId,
      currency: this.cfg.baseCurrency,
      legs: [
        { account: 'compute', amount: cost },
        { account: 'cash', amount: -cost },
      ],
      idempotencyKey: key,
      meta: { ...meta, tokens, costMinor: cost, pricePerMTok: this.cfg.budget.tokenPriceMinorPerMTok },
    });
    this.tokenCostSpentMinor += cost;
  }

  /** Cash the swarm actually holds, per the ledger. */
  cashOnHand(): Minor {
    return this.ledger.balanceOf('cash');
  }

  /** startingCash - cash on hand, floored at 0. */
  drawdownMinor(): Minor {
    const d = this.cfg.budget.startingCashMinor - this.cashOnHand();
    return d > 0 ? d : 0;
  }

  /** Spendable cash for an agent: the tightest of agent cap, global cap, till. */
  availableCash(agentId: AgentId): Minor {
    const row = this.agents.get(agentId);
    if (row === undefined || row.terminated) return 0;
    const agentFree = row.cashCapMinor - row.cashSpentMinor - this.outstandingFor(agentId, 'cash');
    const globalOutstanding = this.outstandingFor(null, 'cash');
    const globalFree = this.cfg.budget.globalCashCapMinor - this.globalSpent('cash') - globalOutstanding;
    const tillFree = this.cashOnHand() - globalOutstanding;
    return Math.max(0, Math.min(agentFree, globalFree, tillFree));
  }

  availableTokens(agentId: AgentId): number {
    const row = this.agents.get(agentId);
    if (row === undefined || row.terminated) return 0;
    const agentFree = row.tokenCap - row.tokensUsed - this.outstandingFor(agentId, 'tokens');
    const globalFree =
      this.cfg.budget.globalTokenCap - this.globalSpent('tokens') - this.outstandingFor(null, 'tokens');
    return Math.max(0, Math.min(agentFree, globalFree));
  }

  /**
   * Move a dead agent's remaining headroom to a survivor. The source's open
   * reservations are released first (nothing in flight may survive the move),
   * and the target is never lifted above the GLOBAL cap.
   */
  reallocate(fromAgent: AgentId, toAgent: AgentId): { cash: Minor; tokens: number } {
    if (fromAgent === toAgent) {
      throw this.deny(BudgetDeny.REALLOCATE_SELF, `reallocate refused: source and target are both ${fromAgent}`, {
        fromAgent,
      });
    }
    const from = this.mustAgent(fromAgent, false);
    const to = this.mustAgent(toAgent, true);

    this.releaseAllFor(fromAgent, 'reallocate');

    const cashRemaining = Math.max(0, from.cashCapMinor - from.cashSpentMinor);
    const tokensRemaining = Math.max(0, from.tokenCap - from.tokensUsed);
    const cashRoom = Math.max(0, this.cfg.budget.globalCashCapMinor - to.cashCapMinor);
    const tokenRoom = Math.max(0, this.cfg.budget.globalTokenCap - to.tokenCap);
    const cash = Math.min(cashRemaining, cashRoom);
    const tokens = Math.min(tokensRemaining, tokenRoom);

    from.cashCapMinor -= cashRemaining;
    from.tokenCap -= tokensRemaining;
    to.cashCapMinor += cash;
    to.tokenCap += tokens;

    this.logger.info('budget.reallocated', { fromAgent, toAgent, cash, tokens, cashRemaining, tokensRemaining });
    return { cash, tokens };
  }

  snapshot(): BudgetSnapshot {
    const agents: AgentBudgetSnapshot[] = [];
    for (const row of this.agents.values()) {
      agents.push({
        agentId: row.agentId,
        terminated: row.terminated,
        cashCapMinor: row.cashCapMinor,
        cashSpentMinor: row.cashSpentMinor,
        cashOutstandingMinor: this.outstandingFor(row.agentId, 'cash'),
        availableCashMinor: this.availableCash(row.agentId),
        tokenCap: row.tokenCap,
        tokensUsed: row.tokensUsed,
        tokensOutstanding: this.outstandingFor(row.agentId, 'tokens'),
        availableTokens: this.availableTokens(row.agentId),
      });
    }
    return {
      halted: this.killSwitch.tripped,
      cash: {
        onHandMinor: this.cashOnHand(),
        startingMinor: this.cfg.budget.startingCashMinor,
        globalCapMinor: this.cfg.budget.globalCashCapMinor,
        spentMinor: this.globalSpent('cash'),
        outstandingMinor: this.outstandingFor(null, 'cash'),
        drawdownMinor: this.drawdownMinor(),
      },
      tokens: {
        globalCap: this.cfg.budget.globalTokenCap,
        used: this.globalSpent('tokens'),
        outstanding: this.outstandingFor(null, 'tokens'),
        costMinor: this.tokenCostSpentMinor,
      },
      reservationsOpen: this.openReservations().length,
      agents,
    };
  }

  // ----------------------------------------------------------------- helpers --

  private outstandingFor(agentId: AgentId | null, resource: Resource): number {
    let s = 0;
    for (const h of this.held.values()) {
      if (h.state !== 'open' || h.res.resource !== resource) continue;
      if (agentId !== null && h.res.agentId !== agentId) continue;
      s += h.res.amount;
    }
    return s;
  }

  private globalSpent(resource: Resource): number {
    let s = 0;
    for (const row of this.agents.values()) s += resource === 'cash' ? row.cashSpentMinor : row.tokensUsed;
    return s;
  }

  private mustAgent(agentId: AgentId, mustBeLive: boolean): AgentRow {
    const row = this.agents.get(agentId);
    if (row === undefined) {
      throw this.deny(BudgetDeny.UNKNOWN_AGENT, `agent ${String(agentId)} is not registered`, { agentId });
    }
    if (mustBeLive && row.terminated) {
      throw this.deny(BudgetDeny.AGENT_TERMINATED, `agent ${agentId} is terminated`, { agentId });
    }
    return row;
  }

  private deny(code: BudgetDenyCode, msg: string, meta: Record<string, unknown>): BudgetDenied {
    this.logger.warn('budget.denied', { code, msg, ...meta });
    return new BudgetDenied(code, msg, meta);
  }
}

function clampInt(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new BudgetDenied(BudgetDeny.INVALID_AMOUNT, `cap must be a non-negative safe integer, got ${String(n)}`, {
      value: n,
    });
  }
  return n;
}
