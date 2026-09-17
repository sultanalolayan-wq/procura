/**
 * index.ts — the process entry point: load config, bootstrap the swarm, install
 * the signal handlers and run until told to stop.
 * Invariants: a bad configuration or an unsafe API bind exits NON-ZERO before
 * anything starts; SIGINT/SIGTERM shut down gracefully and exit 0; a second
 * signal forces the process down; nothing here reimplements orchestration —
 * it only starts it. Callers: `npm start`, the Dockerfile's CMD.
 */

import { loadConfig } from './core/config.js';
import { AresError } from './core/errors.js';
import { bootstrap, startupExitCode } from './runtime/orchestrator.js';

export { bootstrap } from './runtime/orchestrator.js';
export { Supervisor } from './runtime/supervisor.js';
export { ApiServer } from './api/server.js';

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const ares = await bootstrap(cfg, { installSignalHandlers: true });

  ares.logger.info('ares.running', {
    mode: cfg.mode,
    tickIntervalMs: cfg.tickIntervalMs,
    api: `http://${ares.api.host}:${String(ares.api.port)}/`,
    channels: [...ares.channels.keys()],
    note: 'PAPER mode: simulated market, no real funds, no real orders.',
  });

  ares.supervisor.start();
  // Resolves when the loop leaves, which for a 24/7 process means a signal or
  // an operator halt has already run the graceful path.
  await ares.supervisor.done();
  await ares.shutdown('loop ended');
}

// Only run when executed, not when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined && /(?:^|[\\/])dist[\\/]src[\\/]index\.js$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    // Configuration and bind refusals land here. They go to stderr as one
    // readable block — this is the one place a human is definitely watching.
    const code = err instanceof AresError ? err.code : 'STARTUP_FAILED';
    const msg = err instanceof Error ? err.message : String(err);
    // A corrupt ledger exits with its OWN code (and leaves a sentinel file), so
    // a restart policy cannot quietly turn a broken audit trail into an
    // indistinguishable crash loop.
    const exitCode = startupExitCode(err);
    process.stderr.write(`ARES failed to start [${code}] (exit ${String(exitCode)})\n${msg}\n`);
    process.exit(exitCode);
  });
}
