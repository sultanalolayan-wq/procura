/**
 * agents/base.ts — the shared body of every agent: the action budget, the halt
 * gate, crash containment, the learning hook and an idempotent terminate().
 * THE COMPUTE CHARGE (amendment A9). act() charges a MODELLED per-action compute
 * cost to the budget governor. Be honest about what that number is: these agents
 * are deterministic heuristics with no LLM behind them, so nothing here MEASURES
 * token usage — ACTION_TOKENS is an estimate of what an action of this shape
 * would cost if it were served by a model, priced through ARES_TOKEN_PRICE. It
 * is a modelled operating cost, not a meter reading. It exists because with zero
 * compute charged, balanceOf('compute') was permanently 0, ARES_TOKEN_CAP /
 * ARES_AGENT_TOKEN_CAP / ARES_TOKEN_PRICE were inert brakes that .env.example
 * advertised as live, and — worst of all — ANY gross trading margin read as
 * profit, so the survival rule could never see the cost of running the swarm.
 * The caps are load-bearing now: an agent that has exhausted its token cap is
 * refused its next action, exactly as it is refused a cash reservation.
 *
 * It is ACCRUED per action and BOOKED once per tick. Every action is charged and
 * the cap is enforced at the moment of the action — the accrual is subtracted
 * from the headroom before the next one is allowed — but the ledger gets ONE
 * TOKEN_SPEND entry per agent per tick instead of one per action. A ledger entry
 * is ~640 bytes and the chain is re-hashed in full every tick, so writing one per
 * action to record a few halalas would have made compute charges ~96% of all
 * ledger entries (measured: 1,108 of 1,150 over a 200-tick run) and multiplied
 * the growth rate of a file that has no rotation. The books are never more than
 * one tick stale, and an agent that dies mid-tick settles in terminate().
 *
 * Invariants: act() consults the kill switch BEFORE anything else and NEVER lets
 * an exception escape into the supervisor; the action cap is per agent per tick;
 * the compute charge happens after both gates and before the work, so a refused
 * action is never charged; terminate() releases every reservation, liquidates
 * paper inventory and writes a postmortem, and is safe to call twice; an
 * AgentDeps whose PolicyEngine has no kill switch is REFUSED at construction
 * (see assertPolicyWired below).
 * Callers: scout/seller/treasury, registry, runtime/supervisor.
 */

import { AresError, HaltedError } from '../core/errors.js';
import { idempotencyKey } from '../core/ids.js';
import type { AresConfig } from '../core/config.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Rng } from '../core/rng.js';
import type { Ledger } from '../core/ledger.js';
import type { Minor } from '../core/money.js';
import type { AgentId, AgentRole, AgentStatus, Holding, StrategyOutcome } from '../core/types.js';
import type { Bus } from '../bus/bus.js';
import type { Envelope, MsgType } from '../bus/protocol.js';
import type { BudgetGovernor, Reservation, Resource } from '../governance/budget.js';
import type { KillSwitch } from '../governance/killswitch.js';
import type { PolicyEngine } from '../governance/policy.js';
import type { SurvivalEvaluator } from '../governance/survival.js';
import type { MemoryStore, PostmortemRecord } from '../memory/store.js';
import type { ChannelAdapter } from '../channels/adapter.js';

export interface AgentDeps {
  cfg: AresConfig;
  bus: Bus;
  ledger: Ledger;
  budget: BudgetGovernor;
  policy: PolicyEngine;
  killSwitch: KillSwitch;
  survival: SurvivalEvaluator;
  /** This agent's private memory scope. */
  memory: MemoryStore;
  /** The shared, swarm-wide memory scope ('task'). */
  taskMemory: MemoryStore;
  clock: Clock;
  rng: Rng;
  logger: Logger;
  channels: Map<string, ChannelAdapter>;
  /**
   * Modelled tokens charged per act(). Optional; defaults to ACTION_TOKENS.
   * 0 disables the charge entirely, which is a deliberate, auditable choice and
   * not the default — see the compute-charge note in the file header.
   */
  tokensPerAction?: number;
}

/**
 * The modelled token cost of one agent action. At the default ARES_TOKEN_PRICE
 * of 1875 minor units per million tokens this is 2 minor units (rounded up) per
 * action — small, deliberately conservative, and above all NOT zero.
 */
export const ACTION_TOKENS = 1_000;

export interface AgentSnapshot {
  id: AgentId;
  role: AgentRole;
  strategyId: string;
  status: AgentStatus;
  tick: number;
  actionsThisTick: number;
  actionCap: number;
  actionsTaken: number;
  actionsRefused: number;
  crashes: number;
  haltRefusals: number;
  /** Actions refused because the agent had no token headroom left. */
  tokenRefusals: number;
  /** Modelled tokens charged to the compute account so far. */
  tokensCharged: number;
  lastError: string | null;
  openReservations: number;
  holdings: number;
  holdingValueMinor: Minor;
  terminated: boolean;
}

/** A paper holding plus the bookkeeping the agent needs to liquidate it. */
export interface HeldInventory {
  holding: Holding;
  /** Units still on the books (a partial sale reduces this). */
  remaining: number;
  /** Carrying cost per unit in minor units; a writeoff may reduce it. */
  unitCostMinor: Minor;
  acquiredTick: number;
  traceId: string | null;
  meta: Record<string, unknown>;
}

/**
 * Read the kill switch a PolicyEngine is actually consulting.
 *
 * PolicyEngine takes its kill switch through `opts.killSwitch` or
 * setKillSwitch(), NOT through its constructor's positional arguments. If it is
 * never wired, `policy.checkBuy`/`checkSell` silently skip the halt rule while
 * every other rule keeps firing — a partial failure that looks healthy from the
 * outside and is strictly more dangerous than an outright crash. TypeScript's
 * `private` is erased at compile time, so reading the field back is the only way
 * to VERIFY the wiring without editing governance/policy.ts.
 */
export function policyKillSwitch(policy: PolicyEngine): KillSwitch | null {
  const probe = policy as unknown as { killSwitch?: KillSwitch | null };
  return probe.killSwitch ?? null;
}

/** Throws unless `policy` is consulting exactly `killSwitch`. */
export function assertPolicyWired(policy: PolicyEngine, killSwitch: KillSwitch): void {
  const wired = policyKillSwitch(policy);
  if (wired === null) {
    throw new AresError(
      'POLICY_KILLSWITCH_UNWIRED',
      'AgentDeps refused: the PolicyEngine has no kill switch. Without it the halt rule ' +
        'is a silent no-op while every other policy rule still fires, so a halted swarm ' +
        'would keep buying and selling. Pass { killSwitch } to the PolicyEngine constructor ' +
        'or call policy.setKillSwitch(killSwitch) — makeAgentDeps() does this for you.',
      {},
    );
  }
  if (wired !== killSwitch) {
    throw new AresError(
      'POLICY_KILLSWITCH_MISMATCH',
      'AgentDeps refused: the PolicyEngine is consulting a DIFFERENT kill switch from the ' +
        'one the agents and the budget governor use. Tripping one would leave the other live.',
      {},
    );
  }
}

/**
 * The only blessed way to build an AgentDeps: it wires the kill switch into the
 * policy engine and then verifies the wiring took.
 */
export function makeAgentDeps(deps: AgentDeps): AgentDeps {
  if (deps === null || typeof deps !== 'object') {
    throw new AresError('AGENT_DEPS_INVALID', 'makeAgentDeps: deps must be an object', {});
  }
  if (!deps.killSwitch || typeof deps.killSwitch.assertLive !== 'function') {
    throw new AresError('AGENT_DEPS_INVALID', 'makeAgentDeps: a KillSwitch is required', {});
  }
  if (!deps.policy || typeof deps.policy.checkBuy !== 'function') {
    throw new AresError('AGENT_DEPS_INVALID', 'makeAgentDeps: a PolicyEngine is required', {});
  }
  deps.policy.setKillSwitch(deps.killSwitch);
  assertPolicyWired(deps.policy, deps.killSwitch);
  return deps;
}

export abstract class BaseAgent {
  readonly id: AgentId;
  readonly role: AgentRole;
  readonly strategyId: string;
  status: AgentStatus = 'active';

  protected readonly deps: AgentDeps;
  protected readonly cfg: AresConfig;
  protected readonly log: Logger;
  /** The inventory this agent carries on paper, keyed by holding id. */
  protected readonly inventory = new Map<string, HeldInventory>();

  private readonly openRes = new Map<string, Reservation>();
  private readonly unsubscribes: Array<() => void> = [];
  private tickNo = -1;
  private actionsThisTick = 0;
  private actionsTaken = 0;
  private actionsRefused = 0;
  private crashCount = 0;
  private haltRefusals = 0;
  private tokenRefusals = 0;
  private tokensCharged = 0;
  /** Modelled tokens taken this tick but not yet written to the ledger. */
  private tokensPending = 0;
  private tokensPendingTick = -1;
  private lastErrorMsg: string | null = null;
  private terminatedFlag = false;
  private readonly tokensPerAction: number;

  constructor(id: AgentId, role: AgentRole, strategyId: string, deps: AgentDeps) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new AresError('AGENT_BAD_ID', 'BaseAgent: id must be a non-empty string', { id });
    }
    if (typeof strategyId !== 'string' || strategyId.length === 0) {
      throw new AresError('AGENT_BAD_STRATEGY', 'BaseAgent: strategyId must be a non-empty string', { strategyId });
    }
    // The wiring check that must never be skipped. A silently permissive policy
    // engine is the failure mode this whole class exists to prevent.
    assertPolicyWired(deps.policy, deps.killSwitch);
    this.id = id;
    this.role = role;
    this.strategyId = strategyId;
    this.deps = deps;
    this.cfg = deps.cfg;
    this.log = deps.logger.child({ agentId: id, role, strategyId });
    const t = deps.tokensPerAction;
    this.tokensPerAction = Number.isSafeInteger(t) && (t as number) >= 0 ? (t as number) : ACTION_TOKENS;
    if (!deps.budget.has(id)) deps.budget.register(id);
  }

  // ------------------------------------------------------------- lifecycle --

  abstract onTick(tick: number): Promise<void>;

  /**
   * The supervisor's entry point. Resets the per-tick action budget, runs
   * onTick and swallows everything: one agent's bad tick must never abort its
   * siblings or the loop. Returns true when the tick completed cleanly.
   */
  async runTick(tick: number): Promise<boolean> {
    this.tickNo = tick;
    this.actionsThisTick = 0;
    if (this.terminatedFlag || this.status === 'terminated') return false;
    if (this.status === 'quarantined') return false;
    if (this.deps.killSwitch.tripped) {
      this.haltRefusals++;
      this.log.warn('agent.tick_skipped_halted', { tick, reason: this.deps.killSwitch.reason });
      return false;
    }
    try {
      // Stamp the policy audit trail with the tick every decision belongs to.
      this.deps.policy.setTick(tick);
      await this.onTick(tick);
      return true;
    } catch (err) {
      this.noteCrash('onTick', err);
      return false;
    } finally {
      // Whatever the tick did, what it consumed is booked before it ends.
      this.settleCompute();
    }
  }

  /**
   * Write this tick's accrued compute to the ledger as ONE entry. Safe to call
   * when nothing is pending; safe to call twice.
   */
  protected settleCompute(): void {
    const tokens = this.tokensPending;
    const tick = this.tokensPendingTick;
    if (tokens <= 0 || tick < 0) {
      this.tokensPending = 0;
      return;
    }
    this.tokensPending = 0;
    try {
      this.deps.budget.chargeTokens(this.id, tokens, tick);
      this.tokensCharged += tokens;
    } catch (err) {
      this.log.error('agent.token_settle_failed', {
        tick,
        tokens,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Current tick as last set by runTick(). -1 before the first tick. */
  get tick(): number {
    return this.tickNo;
  }

  get crashes(): number {
    return this.crashCount;
  }

  get isTerminated(): boolean {
    return this.terminatedFlag;
  }

  /** Marks the agent as quarantined; the supervisor stops ticking it. */
  quarantine(reason: string): void {
    if (this.terminatedFlag) return;
    this.status = 'quarantined';
    this.log.error('agent.quarantined', { reason, crashes: this.crashCount });
  }

  // ---------------------------------------------------------------- actions --

  /**
   * Run one guarded unit of work. In order: halt check, action cap, then the
   * work itself under a try/catch. Returns null for every refusal and every
   * failure — callers branch on null, they never see an exception.
   */
  protected async act<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    // 1. The halt gate comes FIRST, before the cap and before any work, so a
    //    kill switch tripped mid-tick stops the rest of this tick immediately.
    try {
      this.deps.killSwitch.assertLive();
    } catch (err) {
      this.haltRefusals++;
      this.log.warn('agent.action_halted', {
        action: name,
        tick: this.tickNo,
        reason: err instanceof HaltedError ? err.message : String(err),
      });
      return null;
    }
    // 2. The per-agent per-tick action cap.
    const cap = this.cfg.limits.maxActionsPerAgentPerTick;
    if (this.actionsThisTick >= cap) {
      this.actionsRefused++;
      this.log.warn('agent.action_cap_reached', { action: name, tick: this.tickNo, cap });
      return null;
    }
    // 3. THE COMPUTE CHARGE. An action costs something to run; accruing it here
    //    is what makes balanceOf('compute') real and the token caps load-bearing.
    //    The pending accrual is subtracted from the headroom, so the cap is
    //    enforced at the moment of the action even though the ledger entry for
    //    the whole tick is written once, at the end of it.
    if (this.tokensPerAction > 0) {
      const tick = this.tickNo < 0 ? 0 : this.tickNo;
      if (tick !== this.tokensPendingTick) {
        this.settleCompute();
        this.tokensPendingTick = tick;
      }
      const free = this.deps.budget.availableTokens(this.id) - this.tokensPending;
      if (free < this.tokensPerAction) {
        this.tokenRefusals++;
        this.log.warn('agent.token_cap_reached', {
          action: name,
          tick: this.tickNo,
          need: this.tokensPerAction,
          free,
          pending: this.tokensPending,
        });
        return null;
      }
      this.tokensPending += this.tokensPerAction;
    }
    this.actionsThisTick++;
    this.actionsTaken++;
    const started = this.deps.clock.now();
    try {
      const out = await fn();
      this.log.debug('agent.action', { action: name, tick: this.tickNo, ms: this.deps.clock.now() - started });
      return out;
    } catch (err) {
      this.noteCrash(name, err);
      return null;
    }
  }

  /** Actions still available this tick. */
  protected get actionsLeft(): number {
    return Math.max(0, this.cfg.limits.maxActionsPerAgentPerTick - this.actionsThisTick);
  }

  private noteCrash(action: string, err: unknown): void {
    this.crashCount++;
    this.lastErrorMsg = err instanceof Error ? err.message : String(err);
    this.log.error('agent.action_failed', {
      action,
      tick: this.tickNo,
      crashes: this.crashCount,
      code: err instanceof AresError ? err.code : null,
      error: this.lastErrorMsg,
    });
  }

  // ------------------------------------------------------------------- bus --

  protected emit<T>(
    type: MsgType,
    payload: T,
    opts: { to?: AgentId | '*'; causation?: Envelope | null; traceId?: string } = {},
  ): Envelope<T> {
    return this.deps.bus.publish<T>({
      type,
      from: this.id,
      to: opts.to ?? '*',
      tick: this.tickNo < 0 ? 0 : this.tickNo,
      payload,
      causation: opts.causation ?? null,
      ...(opts.traceId !== undefined ? { traceId: opts.traceId } : {}),
    });
  }

  /** Subscribe, remembering the unsubscribe so terminate() can undo it. */
  protected subscribe(types: MsgType[], handler: (e: Envelope) => void | Promise<void>): void {
    this.unsubscribes.push(this.deps.bus.subscribe(this.id, types, handler));
  }

  // -------------------------------------------------------------- learning --

  /**
   * The single learning path: the survival evaluator, episodic memory and the
   * bus all see the SAME outcome. Never called with an estimate — callers feed
   * realised cash effects only.
   */
  protected learn(o: StrategyOutcome): void {
    try {
      this.deps.survival.record(o);
    } catch (err) {
      this.log.error('agent.learn_survival_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      this.deps.memory.remember({
        tick: o.tick,
        kind: typeof o.meta['kind'] === 'string' ? (o.meta['kind'] as string) : 'outcome',
        net: o.netMinor,
        success: o.success,
        meta: { ...o.meta, strategyId: o.strategyId },
      });
      this.deps.memory.observe(`net:${o.strategyId}`, o.netMinor);
      // A per-agent series too: strategyId may carry an arm suffix, and the
      // postmortem needs one stable key to summarise the whole agent by.
      this.deps.memory.observe('net:agent', o.netMinor);
    } catch (err) {
      this.log.error('agent.learn_memory_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    this.emit('STRATEGY_OUTCOME', o);
  }

  // ---------------------------------------------------------- reservations --

  /** Reserve and remember, so terminate() can always give it back. */
  protected reserve(resource: Resource, amount: number, tick: number): Reservation {
    const res = this.deps.budget.reserve(this.id, resource, amount, tick);
    this.openRes.set(res.id, res);
    return res;
  }

  protected commitReservation(res: Reservation, actual: number, meta: Record<string, unknown> = {}): void {
    this.deps.budget.commit(res, actual, meta);
    this.openRes.delete(res.id);
  }

  protected releaseReservation(res: Reservation): void {
    try {
      this.deps.budget.release(res);
    } catch (err) {
      // An already-settled reservation is not an error worth propagating here.
      this.log.debug('agent.release_noop', { id: res.id, error: err instanceof Error ? err.message : String(err) });
    }
    this.openRes.delete(res.id);
  }

  /** Reservations this agent has open right now. */
  outstandingReservations(): Reservation[] {
    return [...this.openRes.values()].map((r) => ({ ...r }));
  }

  // ---------------------------------------------------------- paper stock --

  protected addInventory(h: Holding, extra: { traceId?: string | null; meta?: Record<string, unknown> } = {}): HeldInventory {
    const rec: HeldInventory = {
      holding: h,
      remaining: h.qty,
      unitCostMinor: h.unitCost.amount,
      acquiredTick: h.acquiredTick,
      traceId: extra.traceId ?? null,
      meta: { ...h.meta, ...(extra.meta ?? {}) },
    };
    this.inventory.set(h.id, rec);
    return rec;
  }

  /** Total carrying value of everything still on the books. */
  protected inventoryValueMinor(): Minor {
    let s = 0;
    for (const rec of this.inventory.values()) s += rec.remaining * rec.unitCostMinor;
    return s;
  }

  holdings(): HeldInventory[] {
    return [...this.inventory.values()].map((r) => ({ ...r, holding: { ...r.holding } }));
  }

  // ------------------------------------------------------------- terminate --

  /**
   * End the agent for good. Idempotent: the second call is a logged no-op, which
   * matters because both the registry and the supervisor may race to call it.
   */
  async terminate(reason: string): Promise<void> {
    if (this.terminatedFlag) {
      this.log.debug('agent.terminate_repeat', { reason });
      return;
    }
    this.terminatedFlag = true;
    this.status = 'terminated';
    // An agent that dies mid-tick still consumed what it consumed.
    this.settleCompute();
    const why = typeof reason === 'string' && reason.length > 0 ? reason : 'unspecified';
    const tick = this.tickNo < 0 ? 0 : this.tickNo;

    // 1. Every outstanding reservation goes back to the pool. Nothing in flight
    //    may outlive the agent that promised to spend it.
    const released: string[] = [];
    for (const res of [...this.openRes.values()]) {
      try {
        this.deps.budget.release(res);
        released.push(res.id);
      } catch (err) {
        this.log.warn('agent.terminate_release_failed', {
          id: res.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.openRes.delete(res.id);
    }

    // 2. Liquidate paper inventory: whatever is still on the books is written
    //    off against the writeoff account at its carrying value.
    let writtenOffMinor = 0;
    for (const [id, rec] of [...this.inventory.entries()]) {
      const carrying = rec.remaining * rec.unitCostMinor;
      if (carrying > 0) {
        try {
          this.deps.ledger.append({
            tick,
            type: 'LIQUIDATION',
            agentId: this.id,
            currency: this.cfg.baseCurrency,
            legs: [
              { account: 'writeoff', amount: carrying },
              { account: 'inventory', amount: -carrying },
            ],
            idempotencyKey: idempotencyKey(['agent.liquidate', this.id, id, rec.remaining, rec.unitCostMinor]),
            meta: { reason: why, holdingId: id, sku: rec.holding.sku, qty: rec.remaining, channel: rec.holding.channel },
          });
          writtenOffMinor += carrying;
        } catch (err) {
          this.log.error('agent.terminate_liquidation_failed', {
            holdingId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.inventory.delete(id);
    }

    // 3. The postmortem. This is what the replacement agent reads instead of
    //    rediscovering the same failure at full token cost.
    const netStat = this.deps.memory.stat('net:agent') ?? this.deps.memory.stat(`net:${this.strategyId}`);
    const meta: Record<string, unknown> = {
      agentId: this.id,
      role: this.role,
      strategyId: this.strategyId,
      reason: why,
      tick,
      crashes: this.crashCount,
      actionsTaken: this.actionsTaken,
      actionsRefused: this.actionsRefused,
      haltRefusals: this.haltRefusals,
      tokenRefusals: this.tokenRefusals,
      tokensCharged: this.tokensCharged,
      reservationsReleased: released.length,
      writtenOffMinor,
      netMeanMinor: netStat ? netStat.mean : null,
      netSamples: netStat ? netStat.n : 0,
      lastError: this.lastErrorMsg,
    };
    try {
      this.deps.memory.postmortem(
        `agent ${this.id} (${this.role}/${this.strategyId}) terminated at tick ${tick}: ${why}. ` +
          `${released.length} reservation(s) released, ${writtenOffMinor} minor units written off, ` +
          `${this.crashCount} crash(es), mean net ${netStat ? netStat.mean.toFixed(2) : 'n/a'} over ` +
          `${netStat ? netStat.n : 0} sample(s).`,
        meta,
      );
      this.deps.memory.flush();
      // The shared scope keeps it too: the replacement gets a fresh private
      // memory, but the swarm's collective record must not restart with it.
      this.deps.taskMemory.postmortem(`${this.role}/${this.strategyId} died: ${why}`, meta);
      this.deps.taskMemory.flush();
    } catch (err) {
      this.log.error('agent.terminate_postmortem_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    for (const un of this.unsubscribes.splice(0)) {
      try {
        un();
      } catch {
        /* an unsubscribe that throws must not block termination */
      }
    }
    this.log.warn('agent.terminated', meta);
    await this.onTerminate(why).catch((err: unknown) => {
      this.log.error('agent.on_terminate_failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  /** Subclass hook, run at the very end of terminate(). Must not throw. */
  protected async onTerminate(_reason: string): Promise<void> {
    /* default: nothing */
  }

  /**
   * Live operational state a successor must take over. The registry reads this
   * BEFORE terminate() runs and writes it into the successor's memory, so an
   * obligation that is still live on a channel — a published listing that can
   * still fill, above all — does not die with the agent that created it.
   * Default: nothing to hand over.
   */
  handoverState(): Record<string, unknown> {
    return {};
  }

  /**
   * The most recent postmortem this agent wrote, or null. The registry reads it
   * when it spawns a replacement so the successor inherits the lesson.
   */
  lastPostmortem(): PostmortemRecord | null {
    try {
      return this.deps.memory.postmortems(1)[0] ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------- snapshot --

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      role: this.role,
      strategyId: this.strategyId,
      status: this.status,
      tick: this.tickNo,
      actionsThisTick: this.actionsThisTick,
      actionCap: this.cfg.limits.maxActionsPerAgentPerTick,
      actionsTaken: this.actionsTaken,
      actionsRefused: this.actionsRefused,
      crashes: this.crashCount,
      haltRefusals: this.haltRefusals,
      tokenRefusals: this.tokenRefusals,
      tokensCharged: this.tokensCharged,
      lastError: this.lastErrorMsg,
      openReservations: this.openRes.size,
      holdings: this.inventory.size,
      holdingValueMinor: this.inventoryValueMinor(),
      terminated: this.terminatedFlag,
    };
  }
}
