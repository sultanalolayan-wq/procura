/**
 * core/config.ts — parse + validate process.env exactly once into a frozen AresConfig.
 * Invariant: ALL validation problems are accumulated and reported in a single
 * ConfigError; mode is PAPER or the process refuses to start (LIVE is a
 * declared-but-refused path). Callers: runtime/orchestrator, tests, api.
 */

import { ConfigError } from './errors.js';
import { isCurrency, type Currency, type Minor } from './money.js';
import { isLevel, type Level } from './logger.js';

export interface AresConfig {
  mode: 'PAPER';
  seed: number;
  baseCurrency: Currency;
  tickIntervalMs: number;
  dataDir: string;
  logLevel: Level;
  /** Ticks between state snapshots. 0 disables snapshots entirely. */
  snapshotEveryTicks: number;
  /** How many snapshot files to keep on disk. Older ones are deleted. */
  snapshotRetain: number;
  api: { host: string; port: number; token: string | null };
  budget: {
    globalCashCapMinor: Minor;
    startingCashMinor: Minor;
    maxDrawdownMinor: Minor;
    perAgentCashCapMinor: Minor;
    perTradeCapMinor: Minor;
    globalTokenCap: number;
    perAgentTokenCap: number;
    tokenPriceMinorPerMTok: Minor;
  };
  survival: {
    windowTicks: number;
    graceWindows: number;
    minSamples: number;
    probationWindows: number;
    minNetMinor: Minor;
  };
  limits: {
    maxActionsPerAgentPerTick: number;
    maxHops: number;
    maxQueueDepth: number;
    repeatWindow: number;
    repeatThreshold: number;
    externalCallsPerMinute: number;
    tickWatchdogMs: number;
    maxAgentCrashes: number;
  };
  channels: string[];
}

export type Env = Record<string, string | undefined>;

/**
 * Shortest ARES_API_TOKEN the loader will accept. The token is the ONLY thing
 * between a reachable socket and an irreversible halt; a one-character token
 * was accepted before this floor existed.
 */
export const MIN_API_TOKEN_LENGTH = 32;

/** Default ticks between snapshots (ARES_SNAPSHOT_EVERY). */
export const DEFAULT_SNAPSHOT_EVERY_TICKS = 20;

/** Default number of snapshot files retained on disk (ARES_SNAPSHOT_RETAIN). */
export const DEFAULT_SNAPSHOT_RETAIN = 48;

class Problems {
  readonly list: string[] = [];
  add(msg: string): void {
    this.list.push(msg);
  }
}

function raw(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function intOf(env: Env, key: string, def: number, p: Problems, opts: { min?: number; max?: number } = {}): number {
  const v = raw(env, key);
  if (v === undefined) return def;
  if (!/^-?\d+$/.test(v)) {
    p.add(`${key}: expected an integer, got ${JSON.stringify(v)}`);
    return def;
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    p.add(`${key}: ${v} is not a safe integer`);
    return def;
  }
  if (opts.min !== undefined && n < opts.min) {
    p.add(`${key}: ${n} is below the minimum of ${opts.min}`);
    return def;
  }
  if (opts.max !== undefined && n > opts.max) {
    p.add(`${key}: ${n} is above the maximum of ${opts.max}`);
    return def;
  }
  return n;
}

export function loadConfig(env: Env = process.env): AresConfig {
  const p = new Problems();

  // ---- mode: the hard refusal -------------------------------------------
  const modeRaw = raw(env, 'ARES_MODE') ?? 'PAPER';
  const mode = modeRaw.toUpperCase();
  if (mode !== 'PAPER') {
    p.add(
      `ARES_MODE: refused value ${JSON.stringify(modeRaw)}. ARES only runs in PAPER mode — ` +
        `LIVE execution is deliberately not implemented (no real funds, no real orders).`,
    );
  }

  const seed = intOf(env, 'ARES_SEED', 1337, p);

  const curRaw = raw(env, 'ARES_BASE_CURRENCY') ?? 'SAR';
  let baseCurrency: Currency = 'SAR';
  if (!isCurrency(curRaw)) p.add(`ARES_BASE_CURRENCY: expected SAR or USD, got ${JSON.stringify(curRaw)}`);
  else baseCurrency = curRaw;

  const tickIntervalMs = intOf(env, 'ARES_TICK_MS', 5000, p, { min: 250 });
  const dataDir = raw(env, 'ARES_DATA_DIR') ?? './var';

  const lvlRaw = raw(env, 'ARES_LOG_LEVEL') ?? 'info';
  let logLevel: Level = 'info';
  if (!isLevel(lvlRaw)) p.add(`ARES_LOG_LEVEL: expected debug|info|warn|error, got ${JSON.stringify(lvlRaw)}`);
  else logLevel = lvlRaw;

  const apiHost = raw(env, 'ARES_API_HOST') ?? '127.0.0.1';
  // 0 is legal and means "ask the OS for an ephemeral port": tests and
  // sidecar deployments need a port nobody else can predict or collide with.
  // The bound port is reported back by ApiServer.start().
  const apiPort = intOf(env, 'ARES_API_PORT', 8787, p, { min: 0, max: 65535 });
  const apiToken = raw(env, 'ARES_API_TOKEN') ?? null;
  if (apiToken !== null && apiToken.length < MIN_API_TOKEN_LENGTH) {
    p.add(
      `ARES_API_TOKEN: a token of ${apiToken.length} character(s) is not a secret. ` +
        `It gates the route that halts the swarm and it is accepted on a 0.0.0.0 bind, so at least ` +
        `${MIN_API_TOKEN_LENGTH} characters are required (e.g. \`openssl rand -hex 32\`).`,
    );
  }

  // Snapshots live on the SAME volume as the ledger, and under read_only:true
  // that volume is the only writable path there is. An unbounded snapshot
  // directory therefore fills the disk the audit trail depends on, so the
  // retention count is configuration, not a constant.
  const snapshotEveryTicks = intOf(env, 'ARES_SNAPSHOT_EVERY', DEFAULT_SNAPSHOT_EVERY_TICKS, p, { min: 0 });
  const snapshotRetain = intOf(env, 'ARES_SNAPSHOT_RETAIN', DEFAULT_SNAPSHOT_RETAIN, p, { min: 1 });

  const budget = {
    globalCashCapMinor: intOf(env, 'ARES_CASH_CAP', 100_000, p, { min: 0 }),
    startingCashMinor: intOf(env, 'ARES_STARTING_CASH', 100_000, p, { min: 0 }),
    maxDrawdownMinor: intOf(env, 'ARES_MAX_DRAWDOWN', 20_000, p, { min: 0 }),
    perAgentCashCapMinor: intOf(env, 'ARES_AGENT_CASH_CAP', 25_000, p, { min: 0 }),
    perTradeCapMinor: intOf(env, 'ARES_TRADE_CAP', 5_000, p, { min: 0 }),
    globalTokenCap: intOf(env, 'ARES_TOKEN_CAP', 2_000_000, p, { min: 0 }),
    perAgentTokenCap: intOf(env, 'ARES_AGENT_TOKEN_CAP', 500_000, p, { min: 0 }),
    tokenPriceMinorPerMTok: intOf(env, 'ARES_TOKEN_PRICE', 1875, p, { min: 0 }),
  };
  if (budget.startingCashMinor > budget.globalCashCapMinor) {
    p.add(
      `ARES_STARTING_CASH (${budget.startingCashMinor}) must not exceed ARES_CASH_CAP (${budget.globalCashCapMinor})`,
    );
  }
  if (budget.perTradeCapMinor > budget.perAgentCashCapMinor) {
    p.add(
      `ARES_TRADE_CAP (${budget.perTradeCapMinor}) must not exceed ARES_AGENT_CASH_CAP (${budget.perAgentCashCapMinor})`,
    );
  }
  if (budget.perAgentTokenCap > budget.globalTokenCap) {
    p.add(`ARES_AGENT_TOKEN_CAP (${budget.perAgentTokenCap}) must not exceed ARES_TOKEN_CAP (${budget.globalTokenCap})`);
  }

  // The three survival guards all have a floor of 0 ON PURPOSE: 0 is the
  // operator's literal zero-tolerance policy (no grace period, no statistical
  // floor, terminate on the first failing mature window) and a policy that
  // cannot be expressed in the environment is not really a policy. The defaults
  // keep the guards on; setting them to 0 is a deliberate, auditable choice.
  const survival = {
    windowTicks: intOf(env, 'ARES_WINDOW_TICKS', 20, p, { min: 1 }),
    graceWindows: intOf(env, 'ARES_GRACE_WINDOWS', 2, p, { min: 0 }),
    minSamples: intOf(env, 'ARES_MIN_SAMPLES', 8, p, { min: 0 }),
    probationWindows: intOf(env, 'ARES_PROBATION_WINDOWS', 1, p, { min: 0 }),
    minNetMinor: intOf(env, 'ARES_MIN_NET', 0, p),
  };

  const limits = {
    maxActionsPerAgentPerTick: intOf(env, 'ARES_MAX_ACTIONS', 4, p, { min: 1 }),
    maxHops: intOf(env, 'ARES_MAX_HOPS', 6, p, { min: 0 }),
    maxQueueDepth: intOf(env, 'ARES_MAX_QUEUE', 1000, p, { min: 1 }),
    repeatWindow: intOf(env, 'ARES_REPEAT_WINDOW', 12, p, { min: 1 }),
    repeatThreshold: intOf(env, 'ARES_REPEAT_THRESHOLD', 4, p, { min: 1 }),
    externalCallsPerMinute: intOf(env, 'ARES_RATE_PER_MIN', 120, p, { min: 1 }),
    tickWatchdogMs: intOf(env, 'ARES_TICK_WATCHDOG_MS', 20_000, p, { min: 1 }),
    maxAgentCrashes: intOf(env, 'ARES_MAX_CRASHES', 3, p, { min: 1 }),
  };

  const channelsRaw = raw(env, 'ARES_CHANNELS') ?? 'dataproducts,digitalassets,ksa_ecom';
  const channels = channelsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (channels.length === 0) p.add(`ARES_CHANNELS: at least one channel name is required`);
  if (new Set(channels).size !== channels.length) p.add(`ARES_CHANNELS: duplicate channel names in ${channelsRaw}`);

  if (p.list.length > 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `Invalid ARES configuration (${p.list.length} problem${p.list.length === 1 ? '' : 's'}):\n` +
        p.list.map((m) => `  - ${m}`).join('\n'),
      { problems: p.list },
    );
  }

  const cfg: AresConfig = {
    mode: 'PAPER',
    seed,
    baseCurrency,
    tickIntervalMs,
    dataDir,
    logLevel,
    snapshotEveryTicks,
    snapshotRetain,
    api: { host: apiHost, port: apiPort, token: apiToken },
    budget,
    survival,
    limits,
    channels,
  };
  return deepFreeze(cfg);
}

function deepFreeze<T>(o: T): T {
  if (o === null || typeof o !== 'object') return o;
  for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(o);
}
