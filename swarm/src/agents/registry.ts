/**
 * agents/registry.ts — the roster: who is alive, what strategy each one runs,
 * and how a dead agent is replaced by one that will not repeat its mistake.
 * Invariants: terminate() is idempotent and always leaves the agent in the
 * roster (history is never deleted, only marked dead); spawnAlternative() NEVER
 * picks a strategy in the exclude list, and ALWAYS copies the predecessor's
 * postmortem into the successor's memory before the successor is constructed.
 * Callers: treasury agent, runtime/orchestrator, api.
 */

import { AresError } from '../core/errors.js';
import { nullLogger, type Logger } from '../core/logger.js';
import type { AgentId, AgentRole } from '../core/types.js';
import type { PostmortemRecord } from '../memory/store.js';
import type { AgentDeps, BaseAgent } from './base.js';

/** Builds one agent of a role from an id, a strategy and its dependencies. */
export type AgentFactory = (id: AgentId, strategyId: string, deps: AgentDeps) => BaseAgent;

/**
 * Builds the dependency set for an agent the registry is about to name. The
 * registry mints the id, so a caller that needs per-agent state (a private
 * MemoryStore scope, above all) passes this instead of a fixed AgentDeps.
 */
export type AgentDepsFactory = (id: AgentId, strategyId: string, role: AgentRole) => AgentDeps;

export interface RoleRegistration {
  role: AgentRole;
  /** The full strategy menu for this role, in preference order. */
  strategies: string[];
  factory: AgentFactory;
}

/** What the registry remembers about an agent it has buried. */
export interface GraveRecord {
  id: AgentId;
  role: AgentRole;
  strategyId: string;
  reason: string;
  postmortem: PostmortemRecord | null;
  /**
   * Live operational state the successor must take over — not a lesson, a
   * liability. A dead seller's listings keep filling on the channel long after
   * it stops existing; without this the successor does not recognise the offer
   * the fill names and the revenue is lost (amendment A8).
   */
  handover: Record<string, unknown>;
}

export interface RegistrySnapshot {
  agents: Array<{ id: AgentId; role: AgentRole; strategyId: string; status: string; terminated: boolean }>;
  graves: GraveRecord[];
  spawns: number;
}

export class AgentRegistry {
  private readonly agents = new Map<AgentId, BaseAgent>();
  private readonly roles = new Map<AgentRole, RoleRegistration>();
  private readonly graves: GraveRecord[] = [];
  private readonly logger: Logger;
  private spawnSeq = 0;

  constructor(logger: Logger = nullLogger) {
    this.logger = logger.child({ mod: 'registry' });
  }

  // -------------------------------------------------------------- strategies --

  /** Declare the strategy menu and constructor for a role. */
  registerStrategies(role: AgentRole, strategies: string[], factory: AgentFactory): void {
    if (!Array.isArray(strategies) || strategies.length === 0) {
      throw new AresError('REGISTRY_NO_STRATEGIES', `registerStrategies(${role}): at least one strategy is required`, {
        role,
      });
    }
    if (typeof factory !== 'function') {
      throw new AresError('REGISTRY_NO_FACTORY', `registerStrategies(${role}): a factory function is required`, {
        role,
      });
    }
    const unique = [...new Set(strategies.filter((s) => typeof s === 'string' && s.length > 0))];
    this.roles.set(role, { role, strategies: unique, factory });
    this.logger.info('registry.strategies_registered', { role, strategies: unique });
  }

  /** The strategy menu for a role (empty when the role was never declared). */
  strategies(role: AgentRole): string[] {
    return [...(this.roles.get(role)?.strategies ?? [])];
  }

  // ------------------------------------------------------------------ roster --

  register(a: BaseAgent): void {
    if (this.agents.has(a.id)) {
      throw new AresError('REGISTRY_DUPLICATE_AGENT', `register(): agent ${a.id} is already registered`, { id: a.id });
    }
    this.agents.set(a.id, a);
    this.logger.info('registry.registered', { id: a.id, role: a.role, strategyId: a.strategyId });
  }

  get(id: AgentId): BaseAgent | undefined {
    return this.agents.get(id);
  }

  all(): BaseAgent[] {
    return [...this.agents.values()];
  }

  active(): BaseAgent[] {
    return this.all().filter((a) => !a.isTerminated && a.status !== 'terminated' && a.status !== 'quarantined');
  }

  /**
   * Everything the Treasury may still judge, reclaim or terminate: every agent
   * that is not already dead, INCLUDING quarantined ones.
   *
   * active() deliberately means "will be ticked", which is why it drops
   * quarantined agents — the supervisor must not run them. That is the right
   * answer for scheduling and the wrong one for enforcement: a quarantined agent
   * still holds open reservations against everyone else's headroom and still
   * owns a budget line and a role. Judging only active() meant the Treasury
   * could never reach it, so it was stranded alive forever. This accessor exists
   * rather than a change to active() so the supervisor's meaning is untouched.
   */
  judgeable(): BaseAgent[] {
    return this.all().filter((a) => !a.isTerminated && a.status !== 'terminated');
  }

  byRole(role: AgentRole): BaseAgent[] {
    return this.all().filter((a) => a.role === role);
  }

  /** Live agents of a role: what "who is left to take over?" actually means. */
  activeByRole(role: AgentRole): BaseAgent[] {
    return this.active().filter((a) => a.role === role);
  }

  size(): number {
    return this.agents.size;
  }

  // --------------------------------------------------------------- terminate --

  /**
   * Kill an agent and record its last words. Unknown ids and repeat calls are
   * no-ops: the treasury and the supervisor may both decide the same agent must
   * die in the same tick and neither should blow up.
   */
  async terminate(id: AgentId, reason: string): Promise<void> {
    const a = this.agents.get(id);
    if (a === undefined) {
      this.logger.warn('registry.terminate_unknown', { id, reason });
      return;
    }
    if (a.isTerminated) {
      this.logger.debug('registry.terminate_repeat', { id, reason });
      return;
    }
    // Captured BEFORE terminate() runs: what the agent is holding open right
    // now is what its successor has to inherit.
    let handover: Record<string, unknown> = {};
    try {
      handover = a.handoverState();
    } catch (err) {
      this.logger.error('registry.handover_capture_failed', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await a.terminate(reason);
    this.graves.push({
      id: a.id,
      role: a.role,
      strategyId: a.strategyId,
      reason,
      postmortem: a.lastPostmortem(),
      handover,
    });
    this.logger.warn('registry.terminated', { id, role: a.role, strategyId: a.strategyId, reason });
  }

  /** Everything the registry has buried, newest last. */
  gravesFor(role?: AgentRole): GraveRecord[] {
    const rows = role === undefined ? this.graves : this.graves.filter((g) => g.role === role);
    return rows.map((g) => ({ ...g }));
  }

  // ------------------------------------------------------------------ spawn --

  /**
   * Replace a dead agent with one running a DIFFERENT strategy.
   *
   * `deps` may be a ready-made AgentDeps or an AgentDepsFactory; the factory
   * form is what a caller uses when the successor needs its own memory scope,
   * because only the registry knows the successor's id.
   *
   * `exclude` names the strategies that have already failed; the replacement is
   * chosen from the role's menu minus that list, preferring a strategy no live
   * agent is already running. The predecessor's postmortem is written into
   * `deps.memory` FIRST, so the new agent can read it in its own constructor —
   * the point of the exercise is that generation N+1 starts from generation N's
   * conclusion instead of paying full token cost to rediscover it.
   *
   * Returns null when the menu is exhausted: running out of untried strategies
   * is a real answer, not an error to paper over with a duplicate.
   */
  spawnAlternative(role: AgentRole, deps: AgentDeps | AgentDepsFactory, exclude: string[]): BaseAgent | null {
    const reg = this.roles.get(role);
    if (reg === undefined) {
      this.logger.warn('registry.spawn_unknown_role', { role });
      return null;
    }
    const banned = new Set((exclude ?? []).filter((s) => typeof s === 'string'));
    const candidates = reg.strategies.filter((s) => !banned.has(s));
    if (candidates.length === 0) {
      this.logger.error('registry.spawn_exhausted', { role, exclude: [...banned], menu: reg.strategies });
      return null;
    }
    const inUse = new Set(this.activeByRole(role).map((a) => a.strategyId));
    const fresh = candidates.find((s) => !inUse.has(s));
    const strategyId = fresh ?? (candidates[0] as string);

    this.spawnSeq += 1;
    // Deterministic id: no crypto, so a seeded run replays identically.
    const id = `${role}-${strategyId}-g${String(this.spawnSeq).padStart(3, '0')}`;
    const agentDeps = typeof deps === 'function' ? deps(id, strategyId, role) : deps;

    const graves = this.gravesFor(role);
    const inherited: Array<Record<string, unknown>> = [];
    for (const g of graves) {
      if (g.postmortem === null) continue;
      try {
        agentDeps.memory.postmortem(g.postmortem.text, {
          ...g.postmortem.meta,
          inherited: true,
          inheritedFrom: g.id,
          inheritedStrategy: g.strategyId,
        });
      } catch (err) {
        this.logger.error('registry.postmortem_transfer_failed', {
          from: g.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      inherited.push({ id: g.id, strategyId: g.strategyId, reason: g.reason });
    }
    // The newest grave of this role is the agent this one is replacing, so its
    // open liabilities are the ones that are still live on the channels.
    const predecessor = graves.length > 0 ? (graves[graves.length - 1] as GraveRecord) : null;
    try {
      agentDeps.memory.setFact('inheritedFrom', inherited);
      agentDeps.memory.setFact('avoidStrategies', [...banned]);
      agentDeps.memory.setFact('generation', graves.length + 1);
      agentDeps.memory.setFact('inheritedHandover', predecessor === null ? {} : predecessor.handover);
      agentDeps.memory.flush();
    } catch (err) {
      this.logger.error('registry.inheritance_facts_failed', {
        role,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const agent = reg.factory(id, strategyId, agentDeps);
    this.register(agent);
    this.logger.warn('registry.spawned_alternative', {
      role,
      id,
      strategyId,
      excluded: [...banned],
      inheritedPostmortems: inherited.length,
    });
    return agent;
  }

  snapshot(): RegistrySnapshot {
    return {
      agents: this.all().map((a) => ({
        id: a.id,
        role: a.role,
        strategyId: a.strategyId,
        status: a.status,
        terminated: a.isTerminated,
      })),
      graves: this.gravesFor(),
      spawns: this.spawnSeq,
    };
  }
}
