/**
 * runtime/supervisor.ts — the 24/7 loop. Ordered phases (scouts, sellers,
 * treasury LAST so the auditor sees the whole tick), drift-corrected scheduling
 * off a fixed epoch, a watchdog that latches the kill switch after three
 * consecutive overruns, per-agent crash quarantine, periodic snapshots and an
 * idempotent graceful shutdown that a second signal can force past.
 * Invariants: killSwitch.assertLive() runs BEFORE EVERY PHASE, never once per
 * tick; a slow tick SKIPS the ticks it missed instead of bursting to catch up;
 * quarantine never terminates (termination is the Treasury's decision);
 * start()/stop() are safe to call twice and leave no timer longer than one
 * sleep slice behind. Callers: runtime/orchestrator, src/index.ts, tests.
 */

import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import type { AresConfig } from '../core/config.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Ledger } from '../core/ledger.js';
import type { AgentId, AgentRole } from '../core/types.js';
import type { Bus } from '../bus/bus.js';
import type { BudgetGovernor } from '../governance/budget.js';
import type { KillSwitch } from '../governance/killswitch.js';
import type { MemoryStore } from '../memory/store.js';
import type { AgentRegistry } from '../agents/registry.js';

/** The phases, in the only order the auditor's snapshot is meaningful in. */
export const PHASES: readonly AgentRole[] = Object.freeze(['scout', 'seller', 'treasury']);

/** Consecutive watchdog overruns that latch the kill switch. */
export const WATCHDOG_TRIP_AFTER = 3;

/** Default number of ticks between state snapshots. */
export const DEFAULT_SNAPSHOT_EVERY = 20;

/**
 * Longest single clock.sleep() the loop will park in. The inter-tick wait is
 * sliced so that a stop() arriving mid-sleep can never leave a real timer
 * holding the process open for a whole tick interval; the wake latch below
 * makes the common case instant, and this bounds the pathological one.
 */
export const SLEEP_SLICE_MS = 200;

export interface SupervisorDeps {
  cfg: AresConfig;
  clock: Clock;
  logger: Logger;
  bus: Bus;
  ledger: Ledger;
  budget: BudgetGovernor;
  killSwitch: KillSwitch;
  registry: AgentRegistry;
  /** Every MemoryStore the process owns; flushed on snapshot and on shutdown. */
  memories: () => MemoryStore[];
  /** Ran once, at the very end of a graceful stop (adapters close here). */
  onShutdown?: () => Promise<void>;
  /** Injected so tests can observe the force-exit path without dying. */
  exit?: (code: number) => void;
}

export interface SupervisorOptions {
  /** Ticks between snapshot+flush. 0 disables snapshots. */
  snapshotEveryTicks?: number;
  /** First tick number. Default 0. */
  startTick?: number;
  /** Stop by itself after this many executed ticks. Tests use it; 0 = forever. */
  maxTicks?: number;
  /** Override the sleep slice (tests). */
  sleepSliceMs?: number;
}

export interface SupervisorSnapshot {
  running: boolean;
  shuttingDown: boolean;
  stopped: boolean;
  mode: 'PAPER';
  startedAt: number | null;
  epoch: number | null;
  tick: number;
  ticksExecuted: number;
  ticksSkipped: number;
  skipEvents: number;
  lastTickMs: number;
  maxTickMs: number;
  overruns: number;
  consecutiveOverruns: number;
  watchdogMs: number;
  tickIntervalMs: number;
  nextTickDueAt: number | null;
  snapshotEveryTicks: number;
  snapshots: number;
  quarantined: AgentId[];
  phaseHalts: number;
  agentCrashes: number;
  halted: boolean;
  haltReason: string | null;
}

/** A deferred that stop() resolves to break the loop out of a sleep at once. */
interface Latch {
  promise: Promise<void>;
  open: () => void;
}

function makeLatch(): Latch {
  let open = (): void => {};
  const promise = new Promise<void>((res) => {
    open = res;
  });
  return { promise, open };
}

export class Supervisor {
  private readonly cfg: AresConfig;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly deps: SupervisorDeps;
  private readonly snapshotEvery: number;
  private readonly maxTicks: number;
  private readonly sliceMs: number;

  private running = false;
  private shuttingDown = false;
  private stoppedFlag = false;
  private loopPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private tickInFlight: Promise<void> | null = null;
  private wake: Latch = makeLatch();
  private signalsInstalled: Array<{ sig: NodeJS.Signals; fn: () => void }> = [];

  private epoch: number | null = null;
  private startedAt: number | null = null;
  private tickNo: number;
  private ticksExecuted = 0;
  private ticksSkipped = 0;
  private skipEvents = 0;
  private lastTickMs = 0;
  private maxTickMs = 0;
  private overruns = 0;
  private consecutiveOverruns = 0;
  private snapshots = 0;
  private phaseHalts = 0;
  private agentCrashes = 0;
  private readonly quarantined = new Set<AgentId>();

  constructor(deps: SupervisorDeps, opts: SupervisorOptions = {}) {
    this.deps = deps;
    this.cfg = deps.cfg;
    this.clock = deps.clock;
    this.log = deps.logger.child({ mod: 'supervisor' });
    const every = opts.snapshotEveryTicks;
    this.snapshotEvery = every === undefined ? DEFAULT_SNAPSHOT_EVERY : Math.max(0, Math.floor(every));
    this.maxTicks = Math.max(0, Math.floor(opts.maxTicks ?? 0));
    const slice = opts.sleepSliceMs ?? SLEEP_SLICE_MS;
    this.sliceMs = Number.isFinite(slice) && slice > 0 ? slice : SLEEP_SLICE_MS;
    this.tickNo = Math.max(0, Math.floor(opts.startTick ?? 0));
  }

  // ------------------------------------------------------------- lifecycle --

  get isRunning(): boolean {
    return this.running;
  }

  get currentTick(): number {
    return this.tickNo;
  }

  /**
   * Begin ticking. Calling it twice is a logged no-op — never a second loop,
   * which would double every agent's actions and corrupt the books.
   */
  start(): void {
    if (this.stoppedFlag) {
      this.log.warn('supervisor.start_after_stop_refused', {});
      return;
    }
    if (this.running) {
      this.log.warn('supervisor.start_repeat', { tick: this.tickNo });
      return;
    }
    this.running = true;
    this.wake = makeLatch();
    this.startedAt = this.clock.now();
    // The epoch is fixed HERE and never moved. Every deadline is
    // epoch + n*interval, so the schedule cannot drift with the work.
    this.epoch = this.startedAt - this.tickNo * this.cfg.tickIntervalMs;
    this.log.info('supervisor.started', {
      tick: this.tickNo,
      tickIntervalMs: this.cfg.tickIntervalMs,
      watchdogMs: this.cfg.limits.tickWatchdogMs,
      snapshotEveryTicks: this.snapshotEvery,
      maxAgentCrashes: this.cfg.limits.maxAgentCrashes,
    });
    this.loopPromise = this.loop().catch((err: unknown) => {
      this.log.error('supervisor.loop_crashed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  /** Resolves when the loop has left for good (after stop(), or maxTicks). */
  async done(): Promise<void> {
    if (this.loopPromise !== null) await this.loopPromise;
  }

  /**
   * Graceful shutdown. Idempotent and re-entrant: every caller awaits the same
   * promise, so a signal racing an operator halt cannot run it twice.
   */
  stop(reason = 'stop() called'): Promise<void> {
    if (this.stopPromise !== null) {
      this.log.debug('supervisor.stop_repeat', { reason });
      return this.stopPromise;
    }
    this.stopPromise = this.doStop(reason);
    return this.stopPromise;
  }

  private async doStop(reason: string): Promise<void> {
    this.shuttingDown = true;
    this.running = false;
    // Break the loop out of its inter-tick sleep immediately.
    this.wake.open();
    this.log.warn('supervisor.stopping', { reason, tick: this.tickNo });

    // 1. Let the in-flight tick finish. Half a tick is half a ledger story.
    try {
      if (this.tickInFlight !== null) await this.tickInFlight;
      if (this.loopPromise !== null) await this.loopPromise;
    } catch (err) {
      this.log.error('supervisor.stop_loop_error', { error: err instanceof Error ? err.message : String(err) });
    }

    // 2. Stop accepting new traffic, then let what is queued be delivered.
    try {
      this.deps.bus.close();
      await this.deps.bus.drain();
    } catch (err) {
      this.log.error('supervisor.stop_drain_failed', { error: err instanceof Error ? err.message : String(err) });
    }

    // 3. Everything learned this run reaches disk.
    const flushed = this.flushMemories();

    // 4. The final integrity statement. This is what an auditor reads first.
    let verified = false;
    let brokenAtSeq: number | null = null;
    try {
      const v = this.deps.ledger.verify();
      verified = v.ok;
      brokenAtSeq = v.brokenAtSeq ?? null;
      if (!v.ok) this.log.error('supervisor.final_verify_failed', { brokenAtSeq });
    } catch (err) {
      this.log.error('supervisor.final_verify_threw', { error: err instanceof Error ? err.message : String(err) });
    }

    // 5. Adapters and anything else the orchestrator owns.
    if (this.deps.onShutdown) {
      try {
        await this.deps.onShutdown();
      } catch (err) {
        this.log.error('supervisor.on_shutdown_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.stoppedFlag = true;
    this.log.warn('supervisor.stopped', {
      reason,
      tick: this.tickNo,
      ticksExecuted: this.ticksExecuted,
      ticksSkipped: this.ticksSkipped,
      memoriesFlushed: flushed,
      ledgerVerified: verified,
      ledgerEntries: this.deps.ledger.size(),
      brokenAtSeq,
      halted: this.deps.killSwitch.tripped,
      haltReason: this.deps.killSwitch.reason,
    });
  }

  // ------------------------------------------------------------------ loop --

  private async loop(): Promise<void> {
    while (this.running) {
      await this.waitForNextTick();
      if (!this.running) break;

      // Drift correction + missed-tick SKIP. The tick index is derived from the
      // clock, never incremented blindly, so a tick that overran its interval
      // resumes at the tick that is due NOW instead of firing a catch-up burst.
      const due = this.dueIndex();
      if (due > this.tickNo) {
        const skipped = due - this.tickNo;
        this.ticksSkipped += skipped;
        this.skipEvents += 1;
        this.log.warn('supervisor.ticks_skipped', {
          skipped,
          from: this.tickNo,
          resumingAt: due,
          reason: 'a tick overran its interval; catching up in a burst is how a slow tick becomes a runaway loop',
        });
        this.tickNo = due;
      }

      const p = this.runTick(this.tickNo);
      this.tickInFlight = p;
      try {
        await p;
      } finally {
        this.tickInFlight = null;
      }

      this.tickNo += 1;
      if (this.maxTicks > 0 && this.ticksExecuted >= this.maxTicks) {
        this.log.info('supervisor.max_ticks_reached', { maxTicks: this.maxTicks });
        this.running = false;
        break;
      }
    }
  }

  /** The tick index the clock says is due right now. */
  private dueIndex(): number {
    if (this.epoch === null) return this.tickNo;
    const elapsed = this.clock.now() - this.epoch;
    return Math.max(0, Math.floor(elapsed / this.cfg.tickIntervalMs));
  }

  private nextDueAt(): number | null {
    if (this.epoch === null) return null;
    return this.epoch + this.tickNo * this.cfg.tickIntervalMs;
  }

  /** Sleep, in bounded slices, until this.tickNo's deadline (or a stop()). */
  private async waitForNextTick(): Promise<void> {
    for (;;) {
      if (!this.running) return;
      const target = this.nextDueAt();
      if (target === null) return;
      const remaining = target - this.clock.now();
      if (remaining <= 0) return;
      const slice = Math.min(remaining, this.sliceMs);
      await Promise.race([this.clock.sleep(slice), this.wake.promise]);
      if (!this.running) return;
    }
  }

  // ------------------------------------------------------------------ tick --

  /**
   * One whole tick. Public so a test (or an operator tool) can step the swarm
   * deterministically without the scheduler. Never throws.
   */
  async runTick(tick: number): Promise<void> {
    const started = this.clock.now();
    this.ticksExecuted += 1;
    this.log.debug('supervisor.tick_begin', { tick });

    for (const phase of PHASES) {
      // The halt gate is re-read BEFORE EVERY PHASE. A kill switch tripped by
      // the scouts' phase must stop the sellers and the treasury in the same
      // tick; checking once per tick would let a halted swarm keep trading for
      // the remainder of it.
      if (this.deps.killSwitch.tripped) {
        this.phaseHalts += 1;
        this.log.warn('supervisor.phase_skipped_halted', {
          tick,
          phase,
          reason: this.deps.killSwitch.reason,
          skippedPhases: PHASES.slice(PHASES.indexOf(phase)),
        });
        break;
      }
      await this.runPhase(phase, tick);
    }

    try {
      await this.deps.bus.drain();
    } catch (err) {
      this.log.error('supervisor.drain_failed', { tick, error: err instanceof Error ? err.message : String(err) });
    }

    const elapsed = this.clock.now() - started;
    this.lastTickMs = elapsed;
    if (elapsed > this.maxTickMs) this.maxTickMs = elapsed;
    this.checkWatchdog(tick, elapsed);

    if (this.snapshotEvery > 0 && this.ticksExecuted % this.snapshotEvery === 0) {
      this.writeSnapshot(tick);
    }
    this.log.debug('supervisor.tick_end', { tick, ms: elapsed });
  }

  private async runPhase(phase: AgentRole, tick: number): Promise<void> {
    for (const agent of this.deps.registry.activeByRole(phase)) {
      // Re-checked per agent too: an agent can trip the switch itself.
      if (this.deps.killSwitch.tripped) {
        this.phaseHalts += 1;
        this.log.warn('supervisor.agent_skipped_halted', { tick, phase, agentId: agent.id });
        return;
      }
      if (agent.status === 'quarantined') continue;
      const crashesBefore = agent.crashes;
      try {
        await agent.runTick(tick);
      } catch (err) {
        // runTick() is documented never to throw; if it ever does, the loop
        // still has to survive it.
        this.log.error('supervisor.agent_tick_threw', {
          tick,
          phase,
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const gained = agent.crashes - crashesBefore;
      if (gained > 0) {
        this.agentCrashes += gained;
        this.log.warn('supervisor.agent_crashed', {
          tick,
          phase,
          agentId: agent.id,
          crashes: agent.crashes,
          limit: this.cfg.limits.maxAgentCrashes,
        });
      }
      // Widened on purpose: `status` was narrowed by the skip check above, and
      // the agent may have changed it during its own tick.
      const statusNow: string = agent.status;
      if (agent.crashes >= this.cfg.limits.maxAgentCrashes && statusNow !== 'quarantined' && !agent.isTerminated) {
        // QUARANTINE, NOT TERMINATION. Termination liquidates inventory,
        // reallocates budget and spawns a successor — all of which are the
        // Treasury's judgement to make from the books, not the supervisor's
        // from a crash counter. The supervisor only stops calling it.
        agent.quarantine(`crashed ${agent.crashes} times (limit ${this.cfg.limits.maxAgentCrashes})`);
        this.quarantined.add(agent.id);
        this.log.error('supervisor.agent_quarantined', {
          tick,
          phase,
          agentId: agent.id,
          role: agent.role,
          strategyId: agent.strategyId,
          crashes: agent.crashes,
          limit: this.cfg.limits.maxAgentCrashes,
          note: 'skipped from now on; termination remains the Treasury decision',
        });
      }
    }
  }

  private checkWatchdog(tick: number, elapsed: number): void {
    const limit = this.cfg.limits.tickWatchdogMs;
    if (elapsed <= limit) {
      this.consecutiveOverruns = 0;
      return;
    }
    this.overruns += 1;
    this.consecutiveOverruns += 1;
    this.log.warn('supervisor.tick_watchdog', {
      tick,
      ms: elapsed,
      watchdogMs: limit,
      consecutive: this.consecutiveOverruns,
      tripsAt: WATCHDOG_TRIP_AFTER,
    });
    if (this.consecutiveOverruns >= WATCHDOG_TRIP_AFTER && !this.deps.killSwitch.tripped) {
      const reason =
        `tick watchdog: ${this.consecutiveOverruns} consecutive ticks over ${limit}ms ` +
        `(last ${elapsed}ms) — the loop is not keeping up and is halting itself`;
      this.deps.killSwitch.trip(reason, { tick, ms: elapsed, watchdogMs: limit, consecutive: this.consecutiveOverruns });
      this.log.error('supervisor.watchdog_tripped', { tick, ms: elapsed, consecutive: this.consecutiveOverruns });
    }
  }

  // -------------------------------------------------------------- snapshot --

  private flushMemories(): number {
    let n = 0;
    let stores: MemoryStore[] = [];
    try {
      stores = this.deps.memories();
    } catch (err) {
      this.log.error('supervisor.memories_enumeration_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
    for (const m of stores) {
      try {
        m.flush();
        n += 1;
      } catch (err) {
        this.log.error('supervisor.memory_flush_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return n;
  }

  /**
   * Persist the swarm's state and flush every memory store. Written tmp+rename
   * so a crash mid-write cannot leave a half-parsed snapshot behind.
   */
  writeSnapshot(tick: number): string | null {
    const flushed = this.flushMemories();
    const dir = join(resolvePath(this.cfg.dataDir), 'snapshots');
    const file = join(dir, `tick-${String(tick).padStart(8, '0')}.json`);
    const body = {
      version: 1,
      mode: this.cfg.mode,
      tick,
      ts: this.clock.now(),
      supervisor: this.snapshot(),
      killSwitch: this.deps.killSwitch.snapshot(),
      budget: this.deps.budget.snapshot(),
      ledger: { size: this.deps.ledger.size(), head: this.deps.ledger.head(), balances: this.deps.ledger.balances() },
      bus: this.deps.bus.stats(),
      registry: this.deps.registry.snapshot(),
      memoriesFlushed: flushed,
    };
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(body) + '\n', 'utf8');
      renameSync(tmp, file);
      this.snapshots += 1;
      this.log.info('supervisor.snapshot', { tick, file, memoriesFlushed: flushed });
      return file;
    } catch (err) {
      this.log.error('supervisor.snapshot_failed', {
        tick,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  snapshot(): SupervisorSnapshot {
    return {
      running: this.running,
      shuttingDown: this.shuttingDown,
      stopped: this.stoppedFlag,
      mode: this.cfg.mode,
      startedAt: this.startedAt,
      epoch: this.epoch,
      tick: this.tickNo,
      ticksExecuted: this.ticksExecuted,
      ticksSkipped: this.ticksSkipped,
      skipEvents: this.skipEvents,
      lastTickMs: this.lastTickMs,
      maxTickMs: this.maxTickMs,
      overruns: this.overruns,
      consecutiveOverruns: this.consecutiveOverruns,
      watchdogMs: this.cfg.limits.tickWatchdogMs,
      tickIntervalMs: this.cfg.tickIntervalMs,
      nextTickDueAt: this.nextDueAt(),
      snapshotEveryTicks: this.snapshotEvery,
      snapshots: this.snapshots,
      quarantined: [...this.quarantined],
      phaseHalts: this.phaseHalts,
      agentCrashes: this.agentCrashes,
      halted: this.deps.killSwitch.tripped,
      haltReason: this.deps.killSwitch.reason,
    };
  }

  // --------------------------------------------------------------- signals --

  /**
   * SIGINT/SIGTERM -> graceful stop -> exit 0. A SECOND signal while the first
   * shutdown is still running forces the process down immediately: a shutdown
   * that hangs is worse than an abrupt one, because the operator's only
   * remaining tool is SIGKILL, which skips the final ledger verify entirely.
   */
  installSignalHandlers(signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']): () => void {
    this.removeSignalHandlers();
    for (const sig of signals) {
      const fn = (): void => this.onSignal(sig);
      process.on(sig, fn);
      this.signalsInstalled.push({ sig, fn });
    }
    this.log.info('supervisor.signal_handlers_installed', { signals });
    return () => this.removeSignalHandlers();
  }

  removeSignalHandlers(): void {
    for (const { sig, fn } of this.signalsInstalled.splice(0)) process.off(sig, fn);
  }

  /** The handler body, exposed so the double-signal path is testable. */
  onSignal(sig: string): void {
    if (this.shuttingDown) {
      this.log.error('supervisor.signal_forced_exit', {
        signal: sig,
        note: 'second signal during shutdown — forcing exit without finishing the drain',
      });
      this.forceExit(1);
      return;
    }
    this.log.warn('supervisor.signal', { signal: sig });
    void this.stop(`signal ${sig}`).then(
      () => {
        this.removeSignalHandlers();
        this.exitProcess(0);
      },
      (err: unknown) => {
        this.log.error('supervisor.shutdown_failed', { error: err instanceof Error ? err.message : String(err) });
        this.removeSignalHandlers();
        this.exitProcess(1);
      },
    );
  }

  private forceExit(code: number): void {
    this.removeSignalHandlers();
    this.exitProcess(code);
  }

  private exitProcess(code: number): void {
    const fn = this.deps.exit ?? ((c: number) => process.exit(c));
    fn(code);
  }
}
