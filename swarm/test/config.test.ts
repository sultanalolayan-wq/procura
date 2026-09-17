/**
 * test/config.test.ts — configuration is a safety boundary: every problem must
 * be reported at once, and LIVE mode must be refused loudly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  MIN_API_TOKEN_LENGTH,
  DEFAULT_SNAPSHOT_EVERY_TICKS,
  DEFAULT_SNAPSHOT_RETAIN,
} from '../src/core/config.js';
import { ConfigError } from '../src/core/errors.js';

/** assert.throws() returns void, so capture the error the honest way. */
function caught(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected ConfigError, got ${String(e)}`);
    return e;
  }
  throw new Error('expected loadConfig to throw, but it returned');
}


test('defaults match the spec exactly', () => {
  const c = loadConfig({});
  assert.equal(c.mode, 'PAPER');
  assert.equal(c.seed, 1337);
  assert.equal(c.baseCurrency, 'SAR');
  assert.equal(c.tickIntervalMs, 5000);
  assert.equal(c.dataDir, './var');
  assert.equal(c.logLevel, 'info');
  assert.deepEqual(c.api, { host: '127.0.0.1', port: 8787, token: null });
  assert.deepEqual(c.budget, {
    globalCashCapMinor: 100_000,
    startingCashMinor: 100_000,
    maxDrawdownMinor: 20_000,
    perAgentCashCapMinor: 25_000,
    perTradeCapMinor: 5_000,
    globalTokenCap: 2_000_000,
    perAgentTokenCap: 500_000,
    tokenPriceMinorPerMTok: 1875,
  });
  assert.deepEqual(c.survival, {
    windowTicks: 20,
    graceWindows: 2,
    minSamples: 8,
    probationWindows: 1,
    minNetMinor: 0,
  });
  assert.deepEqual(c.limits, {
    maxActionsPerAgentPerTick: 4,
    maxHops: 6,
    maxQueueDepth: 1000,
    repeatWindow: 12,
    repeatThreshold: 4,
    externalCallsPerMinute: 120,
    tickWatchdogMs: 20_000,
    maxAgentCrashes: 3,
  });
  assert.deepEqual(c.channels, ['dataproducts', 'digitalassets', 'ksa_ecom']);
});

test('the returned config is deeply frozen', () => {
  const c = loadConfig({});
  assert.ok(Object.isFrozen(c));
  assert.ok(Object.isFrozen(c.budget));
  assert.ok(Object.isFrozen(c.limits));
  assert.ok(Object.isFrozen(c.api));
  assert.throws(() => {
    // Justified cast: deliberately attacking readonly-ness at runtime.
    (c.budget as unknown as Record<string, number>)['perTradeCapMinor'] = 99;
  }, TypeError);
});

test('ARES_MODE=LIVE is refused with an explicit "not implemented" message', () => {
  const err = caught(() => loadConfig({ ARES_MODE: 'LIVE' }));
  assert.match(err.message, /ARES_MODE/);
  assert.match(err.message, /PAPER/);
  assert.match(err.message, /LIVE execution is deliberately not implemented/);
});

test('any non-PAPER mode is refused, but PAPER is case-insensitive', () => {
  for (const m of ['live', 'SANDBOX', 'paper-ish', 'prod']) {
    assert.throws(() => loadConfig({ ARES_MODE: m }), ConfigError, `mode ${m} should be refused`);
  }
  assert.equal(loadConfig({ ARES_MODE: 'paper' }).mode, 'PAPER');
  assert.equal(loadConfig({ ARES_MODE: '  PAPER  ' }).mode, 'PAPER');
});

test('ALL validation problems are accumulated into one error', () => {
  const err = caught(() =>
    loadConfig({
      ARES_MODE: 'LIVE',
        ARES_SEED: 'not-a-number',
        ARES_BASE_CURRENCY: 'EUR',
        ARES_TICK_MS: '10',
        ARES_LOG_LEVEL: 'chatty',
        ARES_API_PORT: '70000',
        ARES_MAX_HOPS: '-1',
        ARES_CHANNELS: ' , ',
      }),
  );

  const problems = (err.meta?.['problems'] ?? []) as string[];
  assert.ok(Array.isArray(problems));
  // Eight independent problems must all be present — not just the first.
  for (const key of [
    'ARES_MODE',
    'ARES_SEED',
    'ARES_BASE_CURRENCY',
    'ARES_TICK_MS',
    'ARES_LOG_LEVEL',
    'ARES_API_PORT',
    'ARES_MAX_HOPS',
    'ARES_CHANNELS',
  ]) {
    assert.ok(
      problems.some((p) => p.includes(key)),
      `expected a problem mentioning ${key}, got: ${JSON.stringify(problems)}`,
    );
  }
  assert.equal(problems.length, 8);
  assert.match(err.message, /8 problems/);
  assert.equal(err.code, 'CONFIG_INVALID');
});

test('a single problem is reported in the singular', () => {
  const err = caught(() => loadConfig({ ARES_TICK_MS: '249' }));
  assert.match(err.message, /1 problem\)/);
  assert.match(err.message, /below the minimum of 250/);
});

test('cross-field invariants are validated', () => {
  const err = caught(() =>
    loadConfig({ ARES_STARTING_CASH: '500000', ARES_TRADE_CAP: '999999', ARES_AGENT_TOKEN_CAP: '9999999' }),
  );
  const problems = (err.meta?.['problems'] ?? []) as string[];
  assert.equal(problems.length, 3);
});

test('valid overrides are parsed and trimmed', () => {
  const c = loadConfig({
    ARES_MODE: 'PAPER',
    ARES_SEED: '  99  ',
    ARES_BASE_CURRENCY: 'USD',
    ARES_TICK_MS: '250',
    ARES_DATA_DIR: '/tmp/ares-data',
    ARES_LOG_LEVEL: 'debug',
    ARES_API_HOST: '0.0.0.0',
    ARES_API_PORT: '9000',
    ARES_API_TOKEN: 'a-token-of-at-least-32-characters!!',
    ARES_CHANNELS: 'a, b ,c',
    ARES_REPEAT_WINDOW: '3',
    ARES_REPEAT_THRESHOLD: '2',
  });
  assert.equal(c.seed, 99);
  assert.equal(c.baseCurrency, 'USD');
  assert.equal(c.tickIntervalMs, 250);
  assert.equal(c.dataDir, '/tmp/ares-data');
  assert.equal(c.logLevel, 'debug');
  assert.equal(c.api.host, '0.0.0.0');
  assert.equal(c.api.port, 9000);
  assert.equal(c.api.token, 'a-token-of-at-least-32-characters!!');
  assert.deepEqual(c.channels, ['a', 'b', 'c']);
  assert.equal(c.limits.repeatWindow, 3);
});

test('empty-string env vars fall back to defaults, duplicates are rejected', () => {
  const c = loadConfig({ ARES_API_TOKEN: '   ', ARES_SEED: '' });
  assert.equal(c.api.token, null);
  assert.equal(c.seed, 1337);
  assert.throws(() => loadConfig({ ARES_CHANNELS: 'a,b,a' }), ConfigError);
});

test('non-integer numeric env vars are rejected rather than coerced', () => {
  assert.throws(() => loadConfig({ ARES_TICK_MS: '5000.5' }), ConfigError);
  assert.throws(() => loadConfig({ ARES_MAX_QUEUE: '1e3' }), ConfigError);
});

/* ------------------------------------------------- AMENDMENT A1: zero floors */

test('the survival guards accept 0 so the literal zero-tolerance policy is reachable from the environment', () => {
  const c = loadConfig({
    ARES_GRACE_WINDOWS: '0',
    ARES_MIN_SAMPLES: '0',
    ARES_PROBATION_WINDOWS: '0',
  });
  assert.equal(c.survival.graceWindows, 0);
  assert.equal(c.survival.minSamples, 0);
  assert.equal(c.survival.probationWindows, 0);
  // The other survival fields keep their defaults and their own validation.
  assert.equal(c.survival.windowTicks, 20);
  assert.equal(c.survival.minNetMinor, 0);
});

test('zero is the floor, not the absence of a floor: negatives are still refused', () => {
  for (const key of ['ARES_GRACE_WINDOWS', 'ARES_MIN_SAMPLES', 'ARES_PROBATION_WINDOWS']) {
    const err = caught(() => loadConfig({ [key]: '-1' }));
    assert.match(err.message, new RegExp(key));
    assert.match(err.message, /below the minimum of 0/);
  }
  // windowTicks is NOT one of the guards and still requires at least one tick.
  assert.throws(() => loadConfig({ ARES_WINDOW_TICKS: '0' }), ConfigError);
});


/* ------------------------------------------------- FIX B8: config + ops gaps */

test('ARES_API_PORT accepts 0, which means "ask the OS for an ephemeral port"', () => {
  const c = loadConfig({ ARES_API_PORT: '0' });
  assert.equal(c.api.port, 0, 'port 0 is a legal request, not a validation failure');
  // The rest of the range is unchanged, including the ceiling.
  assert.equal(loadConfig({ ARES_API_PORT: '65535' }).api.port, 65535);
  const err = caught(() => loadConfig({ ARES_API_PORT: '-1' }));
  assert.match(err.message, /ARES_API_PORT/);
  assert.match(err.message, /below the minimum of 0/);
  assert.throws(() => loadConfig({ ARES_API_PORT: '65536' }), ConfigError);
});

test('a short ARES_API_TOKEN is refused with a message that says what to do', () => {
  const err = caught(() => loadConfig({ ARES_API_TOKEN: 'x' }));
  assert.match(err.message, /ARES_API_TOKEN/);
  assert.match(err.message, new RegExp(String(MIN_API_TOKEN_LENGTH)));
  assert.match(err.message, /openssl rand/);
  // It is refused even on the host where it is most dangerous.
  assert.throws(
    () => loadConfig({ ARES_API_HOST: '0.0.0.0', ARES_API_TOKEN: 'short' }),
    ConfigError,
    'a 5-character token must never be accepted on a public bind',
  );
  // One character below the floor fails; exactly the floor passes.
  assert.throws(() => loadConfig({ ARES_API_TOKEN: 'a'.repeat(MIN_API_TOKEN_LENGTH - 1) }), ConfigError);
  assert.equal(loadConfig({ ARES_API_TOKEN: 'a'.repeat(MIN_API_TOKEN_LENGTH) }).api.token?.length, MIN_API_TOKEN_LENGTH);
});

test('ARES_SNAPSHOT_EVERY and ARES_SNAPSHOT_RETAIN live in AresConfig, not in process.env lookups', () => {
  const d = loadConfig({});
  assert.equal(d.snapshotEveryTicks, DEFAULT_SNAPSHOT_EVERY_TICKS);
  assert.equal(d.snapshotRetain, DEFAULT_SNAPSHOT_RETAIN);

  const c = loadConfig({ ARES_SNAPSHOT_EVERY: '7', ARES_SNAPSHOT_RETAIN: '3' });
  assert.equal(c.snapshotEveryTicks, 7);
  assert.equal(c.snapshotRetain, 3);
  assert.equal(Object.isFrozen(c), true);

  // 0 disables snapshots; a negative count is a configuration error, not a
  // silent fallback to the default (which is what the env-reading helper did).
  assert.equal(loadConfig({ ARES_SNAPSHOT_EVERY: '0' }).snapshotEveryTicks, 0);
  assert.throws(() => loadConfig({ ARES_SNAPSHOT_EVERY: '-1' }), ConfigError);
  assert.throws(() => loadConfig({ ARES_SNAPSHOT_EVERY: 'lots' }), ConfigError);
  assert.throws(() => loadConfig({ ARES_SNAPSHOT_RETAIN: '0' }), ConfigError);
});
