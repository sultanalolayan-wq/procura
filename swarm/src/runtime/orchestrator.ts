/**
 * runtime/orchestrator.ts — the boot sequence: config -> ledger -> governance ->
 * channels (policy-gated) -> agents -> supervisor -> api, in dependency order.
 * Invariants: every AgentDeps goes through makeAgentDeps() so a miswired policy
 * engine fails LOUDLY at boot instead of silently skipping the halt rule;
 * budget.bootstrap() runs before any agent exists so drawdownMinor() is
 * meaningful from tick 0; a channel that fails policy.checkChannel is REJECTED
 * and logged, and booting with zero usable channels is an explicit refusal, not
 * a silently idle swarm. Callers: src/index.ts, tests.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { AresError, IntegrityError, PolicyDenied } from '../core/errors.js';
import { systemClock, type Clock } from '../core/clock.js';
import { createLogger, type Logger } from '../core/logger.js';
import { makeRng } from '../core/rng.js';
import { Ledger } from '../core/ledger.js';
import type { AresConfig } from '../core/config.js';
import type { AgentId, AgentRole } from '../core/types.js';
import { Bus } from '../bus/bus.js';
import { BudgetGovernor } from '../governance/budget.js';
import { KillSwitch } from '../governance/killswitch.js';
import { PolicyEngine } from '../governance/policy.js';
import { SurvivalEvaluator } from '../governance/survival.js';
import { MemoryStore } from '../memory/store.js';
import type { ChannelAdapter, ChannelContext } from '../channels/adapter.js';
import { MarketSimulator } from '../channels/simulator.js';
import { DataProductsAdapter } from '../channels/dataproducts.js';
import { DigitalAssetsAdapter } from '../channels/digitalassets.js';
import { KsaEcomAdapter } from '../channels/ksa_ecom.js';
import { makeAgentDeps, assertPolicyWired, type AgentDeps } from '../agents/base.js';
import { AgentRegistry } from '../agents/registry.js';
import { ScoutAgent, SCOUT_STRATEGIES } from '../agents/scout.js';
import { SellerAgent, SELLER_STRATEGIES } from '../agents/seller.js';
import { TreasuryAgent, treasuryFactory } from '../agents/treasury.js';
import { ApiServer } from '../api/server.js';
import { Supervisor } from './supervisor.js';

/** Channel name -> constructor. The only three channels that exist. */
const CHANNEL_BUILDERS: Readonly<Record<string, (sim: MarketSimulator, p: { currency: 'SAR' | 'USD' }) => ChannelAdapter>> =
  Object.freeze({
    dataproducts: (sim, p) => new DataProductsAdapter(sim, p),
    digitalassets: (sim, p) => new DigitalAssetsAdapter(sim, p),
    ksa_ecom: (sim, p) => new KsaEcomAdapter(sim, p),
  });

/** The agents a fresh swarm starts with. */
export const SEED_AGENTS: ReadonlyArray<{ id: AgentId; role: AgentRole; strategyId: string }> = Object.freeze([
  Object.freeze({ id: 'scout-1', role: 'scout' as AgentRole, strategyId: 'edge-hunter' }),
  Object.freeze({ id: 'seller-1', role: 'seller' as AgentRole, strategyId: 'margin-keeper' }),
  Object.freeze({ id: 'treasury-1', role: 'treasury' as AgentRole, strategyId: 'auditor' }),
]);

export interface BootstrapOptions {
  clock?: Clock;
  logger?: Logger;
  /** Start the HTTP listener. Default true. */
  startApi?: boolean;
  /** Install SIGINT/SIGTERM handlers on the supervisor. Default false. */
  installSignalHandlers?: boolean;
  /** Ticks between state snapshots; cfg.snapshotEveryTicks when omitted. */
  snapshotEveryTicks?: number;
  /** Stop after N ticks (tests). */
  maxTicks?: number;
  /** Poll interval for the HALT file watcher. */
  haltWatchIntervalMs?: number;
  /** Injected exit for the supervisor's signal path (tests). */
  exit?: (code: number) => void;
}

export interface ChannelRejection {
  name: string;
  code: string;
  reason: string;
}

export interface Ares {
  cfg: AresConfig;
  clock: Clock;
  logger: Logger;
  ledger: Ledger;
  bus: Bus;
  budget: BudgetGovernor;
  policy: PolicyEngine;
  killSwitch: KillSwitch;
  survival: SurvivalEvaluator;
  registry: AgentRegistry;
  channels: Map<string, ChannelAdapter>;
  rejectedChannels: ChannelRejection[];
  memories: Map<string, MemoryStore>;
  supervisor: Supervisor;
  api: ApiServer;
  treasury: TreasuryAgent;
  depsFor: (id: AgentId, strategyId: string, role: AgentRole) => AgentDeps;
  shutdown: (reason?: string) => Promise<void>;
}

/**
 * Exit code for "the ledger on disk is not a valid chain". Distinct from an
 * ordinary crash so that `restart: unless-stopped` does not turn a corrupt
 * audit trail into a silent, permanent crash loop that looks like any other
 * flap. A sentinel file is written beside the ledger for the same reason.
 */
export const EXIT_LEDGER_CORRUPT = 3;

/** Written into the data directory when the ledger refuses to open. */
export const LEDGER_SENTINEL_FILE = 'LEDGER_CORRUPT';

/** Process exit code for a startup failure, by kind. */
export function startupExitCode(err: unknown): number {
  return err instanceof IntegrityError ? EXIT_LEDGER_CORRUPT : 1;
}

/**
 * Wire the whole swarm. Throws — loudly, with a code — rather than returning a
 * half-built system: every failure here is a failure to be safe, not a feature
 * to degrade.
 */
export async function bootstrap(cfg: AresConfig, opts: BootstrapOptions = {}): Promise<Ares> {
  const clock = opts.clock ?? systemClock;
  const logger =
    opts.logger ?? createLogger({ level: cfg.logLevel, clock, base: { app: 'ares', mode: cfg.mode, seed: cfg.seed } });
  const log = logger.child({ mod: 'orchestrator' });
  const dataDir = resolvePath(cfg.dataDir);
  mkdirSync(dataDir, { recursive: true });
  log.info('boot.begin', {
    mode: cfg.mode,
    dataDir,
    seed: cfg.seed,
    tickIntervalMs: cfg.tickIntervalMs,
    channels: cfg.channels,
  });

  // 1. The books come first: everything below writes to them.
  //
  // REFUSING to open a broken chain is correct and stays. What is added is
  // visibility: a sentinel file and a distinct exit code, so an operator can
  // tell "the audit trail is corrupt, stop restarting me" apart from an
  // ordinary crash under `restart: unless-stopped`.
  let ledger: Ledger;
  try {
    ledger = Ledger.open(dataDir, clock, logger);
  } catch (err) {
    if (err instanceof IntegrityError) {
      const sentinel = join(dataDir, LEDGER_SENTINEL_FILE);
      try {
        writeFileSync(
          sentinel,
          JSON.stringify(
            {
              code: err.code,
              message: err.message,
              meta: err.meta ?? {},
              at: clock.now(),
              exitCode: EXIT_LEDGER_CORRUPT,
              note:
                'ARES refused to open the ledger because its hash chain does not verify. ' +
                'This file is written on every such refusal. Restarting will NOT fix it: ' +
                'inspect ledger.jsonl at the seq named above, then move it aside deliberately.',
            },
            null,
            2,
          ) + '\n',
          'utf8',
        );
      } catch (writeErr) {
        log.error('boot.ledger_sentinel_write_failed', {
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }
      log.error('boot.ledger_corrupt', { code: err.code, brokenAtSeq: err.meta?.['brokenAtSeq'] ?? null, sentinel });
    }
    throw err;
  }

  // 2. The kill switch, and the file an operator can create to stop the swarm
  //    without an API token at all.
  const killSwitch = new KillSwitch(logger, clock);
  const stopWatching = killSwitch.watchFile(
    dataDir,
    clock,
    opts.haltWatchIntervalMs !== undefined ? { intervalMs: opts.haltWatchIntervalMs } : {},
  );

  // 3. The budget governor, bootstrapped so the opening cash/equity entry
  //    exists. Without it cashOnHand() is zero and drawdownMinor() is
  //    meaningless — the drawdown brake would have nothing to measure against.
  const budget = new BudgetGovernor(cfg, ledger, logger, killSwitch);
  budget.bootstrap(0);
  log.info('boot.budget_bootstrapped', {
    startingCashMinor: cfg.budget.startingCashMinor,
    cashOnHandMinor: budget.cashOnHand(),
    drawdownMinor: budget.drawdownMinor(),
  });

  // 4. The compliance gate, with the kill switch wired at construction.
  const policy = new PolicyEngine(cfg, logger, { killSwitch });
  policy.assertMode();

  const survival = new SurvivalEvaluator(cfg, ledger, logger);
  const bus = new Bus(cfg, clock, logger);
  const registry = new AgentRegistry(logger);

  // 5. Channels, each one gated by policy BEFORE it is initialised.
  const sim = new MarketSimulator({ rng: makeRng(cfg.seed), clock, logger });
  const ctx: ChannelContext = { cfg, rng: makeRng(cfg.seed + 1), clock, logger };
  const channels = new Map<string, ChannelAdapter>();
  const rejectedChannels: ChannelRejection[] = [];
  for (const name of cfg.channels) {
    const build = CHANNEL_BUILDERS[name];
    if (build === undefined) {
      rejectedChannels.push({ name, code: 'CHANNEL_UNKNOWN', reason: `no adapter is implemented for "${name}"` });
      log.error('boot.channel_unknown', { channel: name, known: Object.keys(CHANNEL_BUILDERS) });
      continue;
    }
    const adapter = build(sim, { currency: cfg.baseCurrency });
    try {
      policy.checkChannel(adapter);
    } catch (err) {
      const code = err instanceof AresError ? err.code : 'CHANNEL_REJECTED';
      const reason = err instanceof Error ? err.message : String(err);
      rejectedChannels.push({ name, code, reason });
      log.warn('boot.channel_rejected', { channel: name, code, reason });
      if (!(err instanceof PolicyDenied)) throw err;
      continue;
    }
    await adapter.init(ctx);
    channels.set(adapter.name, adapter);
    log.info('boot.channel_registered', {
      channel: adapter.name,
      canBuy: adapter.capabilities.canBuy,
      canSell: adapter.capabilities.canSell,
      jurisdiction: adapter.capabilities.jurisdiction,
    });
  }
  if (channels.size === 0) {
    // A swarm with no usable channel cannot buy, cannot sell and cannot learn.
    // It would look healthy on every dashboard while doing nothing at all, so
    // it refuses to boot instead.
    throw new AresError(
      'BOOT_NO_USABLE_CHANNELS',
      `Refusing to boot: none of the configured channels (${cfg.channels.join(', ')}) passed the policy gate. ` +
        `A swarm with no usable channel is idle, not safe — it would report healthy while doing nothing. ` +
        `Rejections: ${rejectedChannels.map((r) => `${r.name} (${r.code})`).join('; ') || 'none recorded'}.`,
      { configured: cfg.channels, rejected: rejectedChannels.map((r) => ({ name: r.name, code: r.code })) },
    );
  }

  // 6. Memory scopes. Every store the process opens is tracked so the
  //    supervisor can flush all of them on snapshot and on shutdown.
  const memories = new Map<string, MemoryStore>();
  const taskMemory = MemoryStore.open(dataDir, 'task', logger);
  memories.set('task', taskMemory);

  const depsFor = (id: AgentId, _strategyId?: string, _role?: AgentRole): AgentDeps => {
    let mem = memories.get(id);
    if (mem === undefined) {
      mem = MemoryStore.open(dataDir, id, logger);
      memories.set(id, mem);
    }
    // makeAgentDeps wires the kill switch into the policy engine and then
    // VERIFIES the wiring. A policy engine without one silently skips the halt
    // rule while every other rule keeps firing.
    return makeAgentDeps({
      cfg,
      bus,
      ledger,
      budget,
      policy,
      killSwitch,
      survival,
      memory: mem,
      taskMemory,
      clock,
      // A per-agent deterministic stream, so one agent's draws cannot shift
      // another's and a seeded run replays identically.
      rng: makeRng(cfg.seed + id.length * 31 + id.charCodeAt(0)),
      logger,
      channels,
    });
  };

  // Belt and braces: prove the wiring once here too, so a boot failure names
  // the orchestrator rather than the first agent that happens to construct.
  assertPolicyWired(policy, killSwitch);

  // 7. Strategy menus, so the treasury can respawn onto an untried strategy.
  registry.registerStrategies('scout', [...SCOUT_STRATEGIES], (id, strat, deps) => new ScoutAgent(id, strat, deps));
  registry.registerStrategies('seller', [...SELLER_STRATEGIES], (id, strat, deps) => new SellerAgent(id, strat, deps));

  // 8. The seed roster.
  const scout = new ScoutAgent('scout-1', 'edge-hunter', depsFor('scout-1'));
  const seller = new SellerAgent('seller-1', 'margin-keeper', depsFor('seller-1'));
  registry.register(scout);
  registry.register(seller);

  const treasuryOpts = { registry, depsFor };
  registry.registerStrategies('treasury', ['auditor'], treasuryFactory(treasuryOpts));
  const treasury = new TreasuryAgent('treasury-1', 'auditor', depsFor('treasury-1'), treasuryOpts);
  registry.register(treasury);
  log.info('boot.agents_registered', {
    agents: registry.all().map((a) => ({ id: a.id, role: a.role, strategyId: a.strategyId })),
  });

  // 9. The loop.
  //
  // EVERY teardown step hangs off the supervisor's onShutdown hook rather than
  // off a separate shutdown() path. That is deliberate: the supervisor's signal
  // handler exits the process as soon as stop() resolves, so anything not
  // inside stop() would be racing process.exit(). Adapters, the halt-file
  // watcher, the HTTP listener and the ledger fd all close here, after the
  // final ledger.verify() and before the process is allowed to leave.
  let torndown = false;
  let apiRef: ApiServer | null = null;
  const finalise = async (): Promise<void> => {
    if (torndown) return;
    torndown = true;
    for (const [name, a] of channels) {
      try {
        await a.close();
      } catch (err) {
        log.error('shutdown.channel_close_failed', {
          channel: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      stopWatching();
    } catch {
      /* the watcher also stops itself once the switch is tripped */
    }
    if (apiRef !== null) {
      try {
        await apiRef.stop();
      } catch (err) {
        log.error('shutdown.api_stop_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    try {
      ledger.close();
    } catch (err) {
      log.error('shutdown.ledger_close_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    log.warn('shutdown.complete', {});
  };

  const supervisor = new Supervisor(
    {
      cfg,
      clock,
      logger,
      bus,
      ledger,
      budget,
      killSwitch,
      registry,
      memories: () => [...memories.values()],
      onShutdown: finalise,
      ...(opts.exit ? { exit: opts.exit } : {}),
    },
    {
      snapshotEveryTicks: opts.snapshotEveryTicks ?? cfg.snapshotEveryTicks,
      snapshotRetain: cfg.snapshotRetain,
      ...(opts.maxTicks !== undefined ? { maxTicks: opts.maxTicks } : {}),
    },
  );

  // 10. The control surface. Constructing it is itself a security check: it
  //     refuses a non-loopback bind with no token.
  const api = new ApiServer({
    cfg,
    clock,
    logger,
    ledger,
    bus,
    budget,
    policy,
    killSwitch,
    survival,
    registry,
    supervisor,
    channels,
    treasury,
  });
  apiRef = api;
  if (opts.startApi !== false) await api.start();
  if (opts.installSignalHandlers === true) supervisor.installSignalHandlers();

  // The supervisor's stop() IS the shutdown: it drains the bus, flushes every
  // memory store, runs the final ledger.verify() and then calls finalise().
  // Calling it twice returns the same promise, so this is idempotent too.
  const shutdown = (reason = 'shutdown() called'): Promise<void> => {
    supervisor.removeSignalHandlers();
    return supervisor.stop(reason);
  };

  log.info('boot.complete', {
    channels: [...channels.keys()],
    rejectedChannels: rejectedChannels.map((r) => r.name),
    agents: registry.size(),
    apiPort: api.port,
    apiHost: api.host,
  });

  return {
    cfg,
    clock,
    logger,
    ledger,
    bus,
    budget,
    policy,
    killSwitch,
    survival,
    registry,
    channels,
    rejectedChannels,
    memories,
    supervisor,
    api,
    treasury,
    depsFor,
    shutdown,
  };
}
