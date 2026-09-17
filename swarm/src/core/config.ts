/**
 * core/config.ts — parse + validate process.env exactly once into a frozen AresConfig.
 * Invariant: ALL validation problems are accumulated and reported in a single
 * ConfigError; mode is PAPER or the process refuses to start (LIVE is a
 * declared-but-refused path). Callers: runtime/orchestrator, tests, api.
 */

import { ConfigError } from './errors.js';
import { isCurrency, type Currency, type Minor } from './money.js';
import { isLevel, type Level } from './logger.js';
// Type-only for Venue (erased at compile time) and one pure date predicate.
// market/feed.ts imports nothing from config, so there is no cycle in either
// direction — the market block is additive and self-contained.
import { isDayUtc } from '../market/feed.js';
import type { Venue } from '../market/feed.js';

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
  market: MarketConfig;
}

/* ------------------------------------------------------------ market block */

/**
 * Cost parameters for ONE venue. Every number that separates a printed price
 * from the cash that actually moves is here, named, and none of it is buried as
 * a magic number anywhere else. Shape-identical to VenueCostModel in
 * channels/equities.ts; kept structural here so config stays dependency-free.
 *
 * UNVERIFIED ASSUMPTIONS. The defaults are plausible retail figures chosen to be
 * pessimistic rather than flattering; no broker tariff has been read or verified.
 * The operator replaces them with their own broker's schedule.
 */
export interface VenueCostConfig {
  /** Commission per SIDE, in basis points of notional. */
  commissionBps: number;
  /** Floor on the per-side commission, in minor units of the venue's currency. */
  minCommissionMinor: Minor;
  /** Half the quoted bid-ask, charged adversely on every fill, in bps. */
  halfSpreadBps: number;
  /** Adverse move between decision and execution, in bps. */
  slippageBps: number;
  /** Settlement delay in SESSIONS, not calendar days. T+2 by default. */
  settlementSessions: number;
  /** Minimum tradeable increment, in shares. */
  lotSize: number;
}

export interface MarketConfig {
  /** Master switch. OFF by default: no market module runs unless asked for. */
  enabled: boolean;
  /** First session of the run (YYYY-MM-DD), or null to let the caller choose. */
  startDay: string | null;
  /**
   * Nominal run length in SESSIONS. It is applied PER VENUE, and ten US sessions
   * and ten Tadawul sessions are different calendar windows — the run controller
   * reports both.
   */
  sessions: number;
  /** Instrument universe per venue. Empty means "the caller must supply one". */
  symbols: Record<Venue, string[]>;
  /**
   * Exchange holidays per venue, operator-supplied. SHIPS EMPTY ON PURPOSE: a
   * stale hardcoded holiday list is worse than none because it is believed. See
   * market/calendar.ts DEFAULT_HOLIDAYS for the full reasoning.
   */
  holidays: Record<Venue, string[]>;
  costs: Record<Venue, VenueCostConfig>;
  fx: {
    /** SAR per USD, as a number for arithmetic. */
    sarPerUsd: number;
    /** The same rate as an exact integer count of millionths, for auditing. */
    sarPerUsdMicros: number;
    /** Why this is an assumption and not a constant. */
    note: string;
  };
  http: {
    /** Host allowlist. EMPTY BY DEFAULT: deny everything until told otherwise. */
    hosts: string[];
    timeoutMs: number;
    maxBytes: number;
    maxRedirects: number;
    perMinute: number;
    failureThreshold: number;
    cooldownMs: number;
    halfOpenMax: number;
  };
  csv: { maxBytes: number; maxRows: number };
}

/**
 * CONFIGURED ASSUMPTION — NOT A LAW OF NATURE, and labelled here exactly as the
 * VAT rate is labelled in channels/ksa_ecom.ts. The riyal's peg to the dollar is
 * a central-bank policy; policies change, and a rate that has held for decades is
 * still a decision rather than a constant.
 */
export const FX_SAR_PER_USD_NOTE =
  'CONFIGURABLE ASSUMPTION, PENDING OPERATOR CONFIRMATION: ARES_MARKET_FX_SAR_PER_USD is a ' +
  'single fixed rate applied to every conversion. No live rate is fetched and no conversion ' +
  'spread is modelled. The SAR/USD peg is a policy of the Saudi Central Bank, not a law of ' +
  'nature, and cross-currency P&L is only as good as this one number.';

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

/* --------------------------------------------------- market block helpers -- */

/** Comma-separated list -> trimmed, de-duplicated, non-empty entries. */
function listOf(env: Env, key: string, def: string, p: Problems): string[] {
  const v = raw(env, key) ?? def;
  const items = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (new Set(items).size !== items.length) p.add(`${key}: duplicate entries in ${JSON.stringify(v)}`);
  return [...new Set(items)];
}

function boolOf(env: Env, key: string, def: boolean, p: Problems): boolean {
  const v = raw(env, key);
  if (v === undefined) return def;
  const t = v.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  p.add(`${key}: expected a boolean (true/false), got ${JSON.stringify(v)}`);
  return def;
}

/**
 * A decimal rate parsed into an EXACT integer count of millionths. There is no
 * float parsing here and no silent rounding: "3.75" is 3_750_000 micros, and a
 * rate with more than six decimal places is refused rather than truncated, for
 * the same reason market/feed.ts refuses a price it cannot hold exactly.
 */
function microsOf(env: Env, key: string, def: string, p: Problems): number {
  const v = raw(env, key) ?? def;
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v);
  if (m === null) {
    p.add(`${key}: expected a positive decimal with at most 6 decimal places, got ${JSON.stringify(v)}`);
    return 0;
  }
  const micros = Number(`${m[1]}${(m[2] ?? '').padEnd(6, '0')}`);
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    p.add(`${key}: ${JSON.stringify(v)} must be greater than zero`);
    return 0;
  }
  return micros;
}

/** A YYYY-MM-DD list, each entry checked against the real calendar. */
function daysOf(env: Env, key: string, p: Problems): string[] {
  const items = listOf(env, key, '', p);
  for (const d of items) {
    if (!isDayUtc(d)) p.add(`${key}: ${JSON.stringify(d)} is not a real YYYY-MM-DD date`);
  }
  return items;
}

/** Per-venue cost block. Every field is an ARES_MARKET_<VENUE>_* variable. */
function costsOf(env: Env, venue: Venue, p: Problems, def: VenueCostConfig): VenueCostConfig {
  const k = (suffix: string): string => `ARES_MARKET_${venue}_${suffix}`;
  return {
    commissionBps: intOf(env, k('COMMISSION_BPS'), def.commissionBps, p, { min: 0, max: 10_000 }),
    minCommissionMinor: intOf(env, k('MIN_COMMISSION'), def.minCommissionMinor, p, { min: 0 }),
    halfSpreadBps: intOf(env, k('HALF_SPREAD_BPS'), def.halfSpreadBps, p, { min: 0, max: 10_000 }),
    slippageBps: intOf(env, k('SLIPPAGE_BPS'), def.slippageBps, p, { min: 0, max: 10_000 }),
    settlementSessions: intOf(env, k('SETTLEMENT_SESSIONS'), def.settlementSessions, p, { min: 0, max: 30 }),
    lotSize: intOf(env, k('LOT_SIZE'), def.lotSize, p, { min: 1 }),
  };
}

/** Defaults justified in channels/equities.ts DEFAULT_COSTS. */
const DEFAULT_VENUE_COSTS: Readonly<Record<Venue, VenueCostConfig>> = Object.freeze({
  US: Object.freeze({
    commissionBps: 10,
    minCommissionMinor: 100,
    halfSpreadBps: 2,
    slippageBps: 3,
    settlementSessions: 2,
    lotSize: 1,
  }),
  TADAWUL: Object.freeze({
    commissionBps: 16,
    minCommissionMinor: 100,
    halfSpreadBps: 5,
    slippageBps: 5,
    settlementSessions: 2,
    lotSize: 1,
  }),
});

/**
 * The market block. It is entirely additive: with ARES_MARKET_ENABLED unset the
 * defaults describe a module that reaches nothing (empty host allowlist), trades
 * nothing (empty symbol lists) and assumes no holidays it was not given.
 */
function marketOf(env: Env, p: Problems): MarketConfig {
  const enabled = boolOf(env, 'ARES_MARKET_ENABLED', false, p);
  const startRaw = raw(env, 'ARES_MARKET_START_DAY') ?? null;
  if (startRaw !== null && !isDayUtc(startRaw)) {
    p.add(`ARES_MARKET_START_DAY: expected a real YYYY-MM-DD date, got ${JSON.stringify(startRaw)}`);
  }
  const micros = microsOf(env, 'ARES_MARKET_FX_SAR_PER_USD', '3.75', p);
  const hosts = listOf(env, 'ARES_MARKET_HOSTS', '', p).map((h) => h.toLowerCase());
  for (const h of hosts) {
    if (h.includes('/') || h.includes(':') || h.includes('*')) {
      p.add(`ARES_MARKET_HOSTS: ${JSON.stringify(h)} must be a bare hostname (no scheme, port or wildcard)`);
    }
  }
  return {
    enabled,
    startDay: startRaw !== null && isDayUtc(startRaw) ? startRaw : null,
    sessions: intOf(env, 'ARES_MARKET_SESSIONS', 10, p, { min: 2, max: 2_000 }),
    symbols: {
      US: listOf(env, 'ARES_MARKET_US_SYMBOLS', '', p),
      TADAWUL: listOf(env, 'ARES_MARKET_TADAWUL_SYMBOLS', '', p),
    },
    holidays: {
      US: daysOf(env, 'ARES_MARKET_US_HOLIDAYS', p),
      TADAWUL: daysOf(env, 'ARES_MARKET_TADAWUL_HOLIDAYS', p),
    },
    costs: {
      US: costsOf(env, 'US', p, DEFAULT_VENUE_COSTS.US),
      TADAWUL: costsOf(env, 'TADAWUL', p, DEFAULT_VENUE_COSTS.TADAWUL),
    },
    fx: { sarPerUsd: micros / 1_000_000, sarPerUsdMicros: micros, note: FX_SAR_PER_USD_NOTE },
    http: {
      hosts,
      timeoutMs: intOf(env, 'ARES_MARKET_HTTP_TIMEOUT_MS', 8_000, p, { min: 100, max: 120_000 }),
      maxBytes: intOf(env, 'ARES_MARKET_HTTP_MAX_BYTES', 2_000_000, p, { min: 1_024 }),
      maxRedirects: intOf(env, 'ARES_MARKET_HTTP_MAX_REDIRECTS', 2, p, { min: 0, max: 10 }),
      perMinute: intOf(env, 'ARES_MARKET_HTTP_PER_MIN', 30, p, { min: 1 }),
      failureThreshold: intOf(env, 'ARES_MARKET_HTTP_FAILURES', 3, p, { min: 1 }),
      cooldownMs: intOf(env, 'ARES_MARKET_HTTP_COOLDOWN_MS', 60_000, p, { min: 0 }),
      halfOpenMax: intOf(env, 'ARES_MARKET_HTTP_HALF_OPEN_MAX', 1, p, { min: 1 }),
    },
    csv: {
      maxBytes: intOf(env, 'ARES_MARKET_CSV_MAX_BYTES', 33_554_432, p, { min: 1_024 }),
      maxRows: intOf(env, 'ARES_MARKET_CSV_MAX_ROWS', 200_000, p, { min: 1 }),
    },
  };
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

  const market = marketOf(env, p);
  if (market.enabled) {
    // Only enforced when the module is actually switched on: an operator who has
    // not asked for market data should not have to configure it.
    if (market.startDay === null) p.add('ARES_MARKET_START_DAY is required when ARES_MARKET_ENABLED is true');
    if (market.symbols.US.length === 0 && market.symbols.TADAWUL.length === 0) {
      p.add('ARES_MARKET_ENABLED is true but neither ARES_MARKET_US_SYMBOLS nor ARES_MARKET_TADAWUL_SYMBOLS names an instrument');
    }
  }

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
    market,
  };
  return deepFreeze(cfg);
}

function deepFreeze<T>(o: T): T {
  if (o === null || typeof o !== 'object') return o;
  for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(o);
}
