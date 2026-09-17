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

import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** Default number of snapshot files kept on disk when config says nothing. */
export const DEFAULT_SNAPSHOT_RETAIN = 48;

/** Filename prefix every snapshot shares, so pruning cannot eat a stranger. */
export const SNAPSHOT_PREFIX = 'tick-';

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
  /** Injected so a test can observe the snapshot's durability sequence. */
  fsync?: (fd: number) => void;
}

export interface SupervisorOptions {
  /** Ticks between snapshot+flush. 0 disables snapshots. */
  snapshotEveryTicks?: number;
  /** Snapshot files kept on disk; older ones are deleted. */
  snapshotRetain?: number;
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
  /** Wall time the tick spanned, INCLUDING event-loop time that was not ours. */
  lastTickWallMs: number;
  /** Event-loop time other work (an HTTP handler) stole during the last tick. */
  lastExternalBlockedMs: number;
  maxTickMs: number;
  overruns: number;
  consecutiveOverruns: number;
  watchdogMs: number;
  tickIntervalMs: number;
  nextTickDueAt: number | null;
  /** How far past its deadline the next tick is. 0 when the loop is on time. */
  tickOverdueMs: number;
  /** The loop has missed its deadline by more than a whole interval. */
  stalled: boolean;
  /** Set when the loop itself threw. The swarm is dead; nothing will tick. */
  loopCrashed: boolean;
  snapshotEveryTicks: number;
  snapshotRetain: number;
  snapshots: number;
  snapshotsPruned: number;
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
  private readonly snapshotRetain: number;
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
  private lastTickWallMs = 0;
  private lastExternalBlockedMs = 0;
  private externalBlockedThisTick = 0;
  private externalBlockedTotalMs = 0;
  private loopCrashed = false;
  private maxTickMs = 0;
  private overruns = 0;
  private consecutiveOverruns = 0;
  private snapshots = 0;
  private snapshotsPruned = 0;
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
    const retain = opts.snapshotRetain ?? deps.cfg.snapshotRetain ?? DEFAULT_SNAPSHOT_RETAIN;
    this.snapshotRetain = Number.isFinite(retain) && retain >= 1 ? Math.floor(retain) : DEFAULT_SNAPSHOT_RETAIN;
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
      // A crashed loop USED to log and return, leaving running=true — so
      // /readyz said ready, /healthz said 200, ares_up said 1 and the Docker
      // healthcheck stayed green over a swarm that was dead. The only honest
      // response is to stop claiming to be alive and latch the kill switch, so
      // that every gate in the system agrees the swarm has stopped.
      const message = err instanceof Error ? err.message : String(err);
      this.running = false;
      this.loopCrashed = true;
      this.log.error('supervisor.loop_crashed', { error: message, tick: this.tickNo });
      try {
        this.deps.killSwitch.trip(`supervisor loop crashed: ${message}`, { tick: this.tickNo, fatal: true });
      } catch (tripErr) {
        this.log.error('supervisor.loop_crash_trip_failed', {
          error: tripErr instanceof Error ? tripErr.message : String(tripErr),
        });
      }
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
      // The FULL O(n) check, streamed from the authoritative file. This is one
      // of exactly two places that pays for it (the other is boot); every
      // other caller gets the bounded incremental check.
      const v = this.deps.ledger.verify({ full: true });
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
    this.externalBlockedThisTick = 0;
    // WORK, not wall time. The watchdog latches the kill switch after three
    // consecutive overruns, so whatever it measures is a halt primitive: if it
    // measured wall time, anything that blocks the shared event loop — an
    // unauthenticated GET that re-hashes the ledger, say — could stop the
    // swarm without ever presenting a credential. It therefore measures only
    // the spans the tick itself is executing in, and subtracts blocking that
    // another component has declared via noteExternalBlocking().
    let work = 0;
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
      const phaseStart = this.clock.now();
      await this.runPhase(phase, tick);
      work += Math.max(0, this.clock.now() - phaseStart);
    }

    const drainStart = this.clock.now();
    try {
      await this.deps.bus.drain();
    } catch (err) {
      this.log.error('supervisor.drain_failed', { tick, error: err instanceof Error ? err.message : String(err) });
    }
    work += Math.max(0, this.clock.now() - drainStart);

    const wall = this.clock.now() - started;
    const stolen = this.externalBlockedThisTick;
    this.externalBlockedThisTick = 0;
    const elapsed = Math.max(0, work - stolen);
    this.lastTickMs = elapsed;
    this.lastTickWallMs = wall;
    this.lastExternalBlockedMs = stolen;
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

  /**
   * Declare event-loop time that was spent on work which is NOT this tick's —
   * an HTTP handler, a signal handler, anything sharing the single thread. The
   * watchdog subtracts it, so external load can slow the swarm down but can
   * never latch its emergency stop. Callers pass their own measured duration;
   * a bogus value can only ever make the watchdog MORE forgiving, never make
   * it trip, which is the safe direction for a caller-supplied number.
   */
  noteExternalBlocking(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.externalBlockedThisTick += ms;
    this.externalBlockedTotalMs += ms;
  }

  /** Total event-loop time other components have declared. Observability only. */
  get externalBlockedMs(): number {
    return this.externalBlockedTotalMs;
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
      // Same sequence MemoryStore.flush() uses: open, write, FSYNC, close,
      // rename. The old code wrote and renamed with no fsync at all, so the
      // comment above promised a durability guarantee the code did not give:
      // after a power cut the rename could be visible with no bytes behind it.
      const sync = this.deps.fsync ?? fsyncSync;
      const fd = openSync(tmp, 'w');
      try {
        writeFileSync(fd, JSON.stringify(body) + '\n', 'utf8');
        sync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
      try {
        const dfd = openSync(dir, 'r');
        try {
          fsyncSync(dfd);
        } finally {
          closeSync(dfd);
        }
      } catch {
        /* directory fsync is not supported everywhere; the file itself is durable */
      }
      this.snapshots += 1;
      const pruned = this.pruneSnapshots(dir);
      this.log.info('supervisor.snapshot', { tick, file, memoriesFlushed: flushed, pruned });
      return file;
    } catch (err) {
      this.log.error('supervisor.snapshot_failed', {
        tick,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Keep only the newest `snapshotRetain` snapshots.
   *
   * Nothing used to delete these: ~864 files a day, ~315k a year, each holding
   * full state, on the SAME volume as the ledger. Under read_only:true that
   * volume is the only writable path in the container, so filling it does not
   * just lose snapshots — it stops ledger appends, and the audit trail is the
   * second thing to fail.
   */
  private pruneSnapshots(dir: string): number {
    let removed = 0;
    try {
      const files = readdirSync(dir)
        .filter((f) => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith('.json'))
        .sort(); // zero-padded tick numbers sort chronologically
      const excess = files.length - this.snapshotRetain;
      for (let i = 0; i < excess; i++) {
        const victim = files[i];
        if (victim === undefined) continue;
        try {
          unlinkSync(join(dir, victim));
          removed += 1;
          this.snapshotsPruned += 1;
        } catch (err) {
          this.log.warn('supervisor.snapshot_prune_failed', {
            file: victim,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      this.log.warn('supervisor.snapshot_prune_list_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return removed;
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
      lastTickWallMs: this.lastTickWallMs,
      lastExternalBlockedMs: this.lastExternalBlockedMs,
      maxTickMs: this.maxTickMs,
      overruns: this.overruns,
      consecutiveOverruns: this.consecutiveOverruns,
      watchdogMs: this.cfg.limits.tickWatchdogMs,
      tickIntervalMs: this.cfg.tickIntervalMs,
      nextTickDueAt: this.nextDueAt(),
      tickOverdueMs: this.tickOverdueMs(),
      stalled: this.isStalled(),
      loopCrashed: this.loopCrashed,
      snapshotEveryTicks: this.snapshotEvery,
      snapshotRetain: this.snapshotRetain,
      snapshots: this.snapshots,
      snapshotsPruned: this.snapshotsPruned,
      quarantined: [...this.quarantined],
      phaseHalts: this.phaseHalts,
      agentCrashes: this.agentCrashes,
      halted: this.deps.killSwitch.tripped,
      haltReason: this.deps.killSwitch.reason,
    };
  }

  /** Milliseconds past the current tick's deadline, floored at 0. */
  tickOverdueMs(): number {
    const due = this.nextDueAt();
    if (due === null) return 0;
    const late = this.clock.now() - due;
    return late > 0 ? late : 0;
  }

  /**
   * True when the loop has missed its deadline by MORE THAN a whole interval,
   * or has crashed outright. /readyz reports this: a frozen tick counter was
   * previously the only symptom of a dead swarm, and nobody alerts on that.
   */
  isStalled(): boolean {
    if (this.loopCrashed) return true;
    if (!this.running || this.shuttingDown || this.stoppedFlag) return false;
    return this.tickOverdueMs() > this.cfg.tickIntervalMs;
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
