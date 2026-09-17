/**
 * agents/treasury.ts — the auditor. Verifies the ledger chain, enforces the
 * drawdown limit, judges every other agent's survival and publishes the audit
 * snapshot the dashboard and the operator read.
 *
 * WHY THE TREASURY IS EXEMPT FROM SURVIVAL TERMINATION: it is the only agent
 * that never trades, so it has no revenue line at all and its net cash flow can
 * only ever be zero or negative (any compute it is charged is a pure debit).
 * Judging it against a profit benchmark it is structurally incapable of meeting
 * would terminate the auditor first and fastest, leaving the swarm with no
 * integrity check, no drawdown brake and nobody to trip the kill switch — the
 * rule would reliably remove the only safeguard against the very failures the
 * rule exists to catch. The exemption is by construction, not by luck: the
 * evaluator is never even asked about a treasury agent, and a test pins that.
 *
 * Invariants: ledger.verify() runs EVERY tick and an IntegrityError latches the
 * kill switch; survival verdicts are taken at WINDOW BOUNDARIES, judging the
 * window that just COMPLETED (evaluate() locks a window's verdict on its first
 * call, so evaluating mid-window would judge from that window's first tick);
 * AUDIT_TICK is emitted even on the tick that halts the swarm.
 * Callers: runtime/supervisor, api.
 */

import { IntegrityError } from '../core/errors.js';
import type { AgentId, AgentRole } from '../core/types.js';
import type { Minor } from '../core/money.js';
import type { Verdict } from '../governance/survival.js';
import { BaseAgent, type AgentDeps } from './base.js';
import type { AgentDepsFactory, AgentRegistry } from './registry.js';

export interface TreasuryOptions {
  registry: AgentRegistry;
  /**
   * Builds the dependency set for a replacement agent. Required for respawn:
   * the successor needs its own MemoryStore scope, and only the registry knows
   * the successor's id. Without it the treasury still terminates and
   * reallocates, but it cannot spawn, and it says so loudly.
   */
  depsFor?: AgentDepsFactory;
  /** Fraction the caps are multiplied by on PROBATION (default one half). */
  probationCapFactor?: number;
}

export interface AgentVerdictRow {
  id: AgentId;
  role: AgentRole;
  strategyId: string;
  status: string;
  verdict: Verdict | 'EXEMPT' | 'UNJUDGED';
  netMinor: Minor;
  samples: number;
  windows: number;
  crashes: number;
  reason: string;
}

export class TreasuryAgent extends BaseAgent {
  private readonly registry: AgentRegistry;
  private readonly depsFor: AgentDepsFactory | null;
  private readonly capFactor: number;
  /** The most recent COMPLETED window whose verdicts have been acted on. */
  private lastJudgedWindow = -1;
  private readonly lastVerdict = new Map<AgentId, AgentVerdictRow>();
  /** Strategies that have already been terminated, per role. */
  private readonly burned = new Map<AgentRole, Set<string>>();
  private audits = 0;
  private terminations = 0;
  private probations = 0;
  private spawns = 0;

  constructor(id: AgentId, strategyId: string, deps: AgentDeps, opts: TreasuryOptions) {
    super(id, 'treasury', strategyId, deps);
    if (!opts || !opts.registry) {
      throw new IntegrityError('TREASURY_NO_REGISTRY', 'TreasuryAgent: an AgentRegistry is required', { id });
    }
    this.registry = opts.registry;
    this.depsFor = opts.depsFor ?? null;
    const f = opts.probationCapFactor ?? 0.5;
    this.capFactor = Number.isFinite(f) && f > 0 && f < 1 ? f : 0.5;
  }

  stats(): { audits: number; terminations: number; probations: number; spawns: number; lastJudgedWindow: number } {
    return {
      audits: this.audits,
      terminations: this.terminations,
      probations: this.probations,
      spawns: this.spawns,
      lastJudgedWindow: this.lastJudgedWindow,
    };
  }

  verdicts(): AgentVerdictRow[] {
    return [...this.lastVerdict.values()].map((v) => ({ ...v }));
  }

  // -------------------------------------------------------------------- tick --

  override async onTick(tick: number): Promise<void> {
    await this.act('integrity', () => this.checkIntegrity(tick));
    await this.act('survival', () => this.judgeWindow(tick));
    // The audit snapshot is deliberately NOT inside act(): act() refuses once
    // the kill switch latches, and the snapshot of the tick that halted the
    // swarm is the single most useful record there is.
    this.publishAudit(tick);
  }

  // --------------------------------------------------------------- integrity --

  private async checkIntegrity(tick: number): Promise<void> {
    const v = this.deps.ledger.verify();
    if (!v.ok) {
      const reason = `ledger hash chain broken at seq ${String(v.brokenAtSeq)}`;
      this.deps.killSwitch.trip(reason, { brokenAtSeq: v.brokenAtSeq ?? null, tick, detectedBy: this.id });
      this.emit('HALT', { reason, brokenAtSeq: v.brokenAtSeq ?? null, tick, source: 'ledger_integrity' });
      this.log.error('treasury.integrity_violation', { brokenAtSeq: v.brokenAtSeq, tick });
      // Thrown so act() records it as the fault it is; the latch is already set.
      throw new IntegrityError('LEDGER_CHAIN_BROKEN', reason, { brokenAtSeq: v.brokenAtSeq ?? null, tick });
    }

    const drawdown = this.deps.budget.drawdownMinor();
    const limit = this.cfg.budget.maxDrawdownMinor;
    if (drawdown > limit) {
      const reason = `max drawdown breached: ${drawdown} > ${limit}`;
      this.deps.killSwitch.trip(reason, { drawdownMinor: drawdown, limitMinor: limit, tick, detectedBy: this.id });
      this.emit('HALT', { reason, drawdownMinor: drawdown, limitMinor: limit, tick, source: 'drawdown' });
      this.log.error('treasury.drawdown_breach', { drawdown, limit, tick });
      return;
    }
    this.deps.memory.observe('drawdownMinor', drawdown);
    this.deps.memory.observe('cashOnHandMinor', this.deps.budget.cashOnHand());
  }

  // ---------------------------------------------------------------- survival --

  /**
   * Judge the window that has just finished, once, on its boundary.
   *
   * SurvivalEvaluator.evaluate() locks a window's verdict on the FIRST call
   * inside that window. Calling it every tick would therefore decide window w
   * from the data available at w's very first tick — an empty window judged as a
   * failure. So on the first tick of window w we evaluate at `w*T - 1`, the LAST
   * tick of window w-1, which is complete and has all of its data.
   */
  private async judgeWindow(tick: number): Promise<void> {
    const T = this.cfg.survival.windowTicks;
    const w = Math.floor(Math.max(0, tick) / T);
    if (w < 1) return;
    const completed = w - 1;
    if (completed <= this.lastJudgedWindow) return;
    this.lastJudgedWindow = completed;
    const judgeTick = w * T - 1;

    for (const agent of this.registry.active()) {
      if (agent.id === this.id || agent.role === 'treasury') {
        // Exempt: see the file header. Recorded so the exemption is visible.
        this.lastVerdict.set(agent.id, {
          id: agent.id,
          role: agent.role,
          strategyId: agent.strategyId,
          status: agent.status,
          verdict: 'EXEMPT',
          netMinor: this.deps.ledger.netCashFlow(completed * T, judgeTick, agent.id),
          samples: 0,
          windows: completed + 1,
          crashes: agent.crashes,
          reason: 'treasury is exempt from survival termination by design',
        });
        continue;
      }
      const a = this.deps.survival.evaluate(agent.id, judgeTick);
      this.lastVerdict.set(agent.id, {
        id: agent.id,
        role: agent.role,
        strategyId: agent.strategyId,
        status: agent.status,
        verdict: a.verdict,
        netMinor: a.netMinor,
        samples: a.samples,
        windows: a.windows,
        crashes: agent.crashes,
        reason: a.reason,
      });
      if (a.verdict === 'TERMINATE') {
        await this.executeTermination(agent.id, a.reason, tick);
      } else if (a.verdict === 'PROBATION') {
        this.putOnProbation(agent.id, a.reason, tick);
      } else if (a.verdict === 'PASS' && agent.status === 'probation') {
        agent.status = 'active';
        this.log.info('treasury.probation_cleared', { agentId: agent.id, window: completed, reason: a.reason });
      }
    }
  }

  private putOnProbation(agentId: AgentId, reason: string, tick: number): void {
    const agent = this.registry.get(agentId);
    if (agent === undefined) return;
    agent.status = 'probation';
    this.probations++;
    const row = this.deps.budget.snapshot().agents.find((r) => r.agentId === agentId);
    if (row !== undefined) {
      const cashCapMinor = Math.floor(row.cashCapMinor * this.capFactor);
      const tokenCap = Math.floor(row.tokenCap * this.capFactor);
      this.deps.budget.setCaps(agentId, { cashCapMinor, tokenCap });
      this.log.warn('treasury.probation', {
        agentId,
        reason,
        tick,
        cashCapBefore: row.cashCapMinor,
        cashCapAfter: cashCapMinor,
        tokenCapBefore: row.tokenCap,
        tokenCapAfter: tokenCap,
      });
    }
    this.emit('STRATEGY_OUTCOME', {
      agentId,
      strategyId: agent.strategyId,
      verdict: 'PROBATION',
      reason,
      tick,
      netMinor: 0,
      success: false,
      meta: { kind: 'probation' },
    });
  }

  /**
   * The full cycle: terminate, move the dead agent's remaining headroom to the
   * best survivor, block it in the budget governor, and spawn a replacement on
   * a strategy that has not already failed — carrying the postmortem forward.
   */
  private async executeTermination(agentId: AgentId, reason: string, tick: number): Promise<void> {
    const dead = this.registry.get(agentId);
    if (dead === undefined || dead.isTerminated) return;
    const role = dead.role;
    const deadStrategy = dead.strategyId;
    this.terminations++;

    await this.registry.terminate(agentId, reason);

    // The best surviving non-treasury agent by realised net cash flow so far.
    const best = this.bestSurvivor(agentId, tick);
    let moved: { cash: Minor; tokens: number } | null = null;
    if (best !== null) {
      try {
        moved = this.deps.budget.reallocate(agentId, best);
      } catch (err) {
        this.log.error('treasury.reallocate_failed', {
          from: agentId,
          to: best,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      this.deps.budget.terminateAgent(agentId, reason);
    } catch (err) {
      this.log.warn('treasury.budget_terminate_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.emit('AGENT_TERMINATED', {
      agentId,
      role,
      strategyId: deadStrategy,
      reason,
      tick,
      reallocatedTo: best,
      reallocated: moved,
    });

    const burned = this.burned.get(role) ?? new Set<string>();
    burned.add(deadStrategy);
    this.burned.set(role, burned);

    if (this.depsFor === null) {
      this.log.error('treasury.cannot_spawn', {
        role,
        reason: 'no depsFor factory was supplied, so a replacement cannot be given its own memory scope',
      });
      return;
    }
    const born = this.registry.spawnAlternative(role, this.depsFor, [...burned]);
    if (born === null) {
      this.log.error('treasury.spawn_exhausted', { role, burned: [...burned] });
      return;
    }
    this.spawns++;
    // A new brain deserves a clean sheet: the id is new, but reset() makes the
    // intent explicit and protects against an id ever being reused.
    this.deps.survival.reset(born.id);
    this.emit('AGENT_SPAWNED', {
      agentId: born.id,
      role,
      strategyId: born.strategyId,
      replaces: agentId,
      replacesStrategy: deadStrategy,
      excluded: [...burned],
      inheritedPostmortem: born.lastPostmortem() !== null,
      tick,
    });
    this.log.warn('treasury.replacement_spawned', {
      dead: agentId,
      deadStrategy,
      born: born.id,
      bornStrategy: born.strategyId,
      tick,
    });
  }

  /** The live, non-treasury agent with the best realised net cash flow. */
  private bestSurvivor(excludeId: AgentId, tick: number): AgentId | null {
    let best: AgentId | null = null;
    let bestNet = Number.NEGATIVE_INFINITY;
    for (const a of this.registry.active()) {
      if (a.id === excludeId || a.role === 'treasury' || a.id === this.id) continue;
      if (!this.deps.budget.has(a.id)) continue;
      const net = this.deps.ledger.netCashFlow(0, Math.max(0, tick), a.id);
      if (net > bestNet) {
        bestNet = net;
        best = a.id;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ audit --

  private publishAudit(tick: number): void {
    try {
      const balances = this.deps.ledger.balances();
      const ks = this.deps.killSwitch.snapshot();
      const agents = this.registry.all().map((a) => {
        const v = this.lastVerdict.get(a.id);
        const s = a.snapshot();
        return {
          id: a.id,
          role: a.role,
          strategyId: a.strategyId,
          status: a.status,
          terminated: a.isTerminated,
          crashes: s.crashes,
          holdings: s.holdings,
          holdingValueMinor: s.holdingValueMinor,
          openReservations: s.openReservations,
          netMinor: this.deps.ledger.netCashFlow(0, Math.max(0, tick), a.id),
          verdict: v?.verdict ?? 'UNJUDGED',
          verdictReason: v?.reason ?? '',
        };
      });
      this.audits++;
      this.emit('AUDIT_TICK', {
        tick,
        mode: this.cfg.mode,
        halted: ks.tripped,
        haltReason: ks.reason,
        cashOnHandMinor: this.deps.budget.cashOnHand(),
        drawdownMinor: this.deps.budget.drawdownMinor(),
        maxDrawdownMinor: this.cfg.budget.maxDrawdownMinor,
        balances,
        ledger: { size: this.deps.ledger.size(), head: this.deps.ledger.head(), verified: !ks.tripped },
        budget: this.deps.budget.snapshot(),
        bus: this.deps.bus.stats(),
        policy: this.deps.policy.stats(),
        agents,
        lastJudgedWindow: this.lastJudgedWindow,
        windowTicks: this.cfg.survival.windowTicks,
        treasury: this.stats(),
      });
    } catch (err) {
      this.log.error('treasury.audit_failed', { tick, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Factory shape the registry uses when it (re)builds a treasury. */
export function treasuryFactory(opts: TreasuryOptions) {
  return (id: AgentId, strategyId: string, deps: AgentDeps): TreasuryAgent =>
    new TreasuryAgent(id, strategyId, deps, opts);
}
