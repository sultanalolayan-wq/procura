/**
 * test/api.test.ts — the operator control surface, attacked the way a reviewer
 * would attack it: wrong methods, unknown routes, absent and wrong tokens,
 * oversized bodies, a ledger limit asked to serialise everything, and a hunt
 * through every response body for a leaked token, path or stack frame.
 * Deterministic: TestClock, temp dirs, and an EPHEMERAL PORT (0) throughout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TestClock } from '../src/core/clock.js';
import { loadConfig, type AresConfig, type Env } from '../src/core/config.js';
import { AresError } from '../src/core/errors.js';
import { nullLogger } from '../src/core/logger.js';
import {
  ApiServer,
  assertBindable,
  isLoopbackHost,
  tokenMatches,
  LEDGER_LIMIT_MAX,
  AUTH_LOCKOUT_AFTER,
  AUTH_LOCKOUT_MS,
} from '../src/api/server.js';
import { bootstrap, type Ares } from '../src/runtime/orchestrator.js';

const TOKEN = 'operator-token-9f3b2c7d5e1a4806d2';
const AUTH = { authorization: `Bearer ${TOKEN}` };

interface Harness {
  ares: Ares;
  base: string;
  clock: TestClock;
  dir: string;
  close: () => Promise<void>;
}

/** Boot a real swarm with the API on an ephemeral port. */
async function harness(env: Env = {}, ticks = 3): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'ares-api-'));
  // Port 0 is a first-class configuration value now (ephemeral, assigned by the
  // OS), so the test asks for it through the environment like any operator
  // would instead of patching the frozen config afterwards.
  const cfg = loadConfig({
    ARES_DATA_DIR: dir,
    ARES_TICK_MS: '1000',
    ARES_WINDOW_TICKS: '5',
    ARES_API_PORT: '0',
    ...env,
  });
  const clock = new TestClock(1_000);
  const ares = await bootstrap(cfg, { clock, logger: nullLogger });
  for (let t = 0; t < ticks; t++) {
    await ares.supervisor.runTick(t);
    clock.advance(1_000);
  }
  return {
    ares,
    clock,
    dir,
    base: `http://127.0.0.1:${String(ares.api.port)}`,
    close: async () => {
      await ares.shutdown('test over');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// `any` justified: these are assertions against arbitrary JSON the server
// produced; typing every response shape here would only restate server.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any; res: Response }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, res };
}

/* --------------------------------------------------------------- unit bits */

test('loopback detection and the bind refusal', () => {
  for (const h of ['127.0.0.1', '::1', 'localhost', '127.0.0.5', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(h), true, `${h} is loopback`);
  }
  for (const h of ['0.0.0.0', '10.0.0.4', '::', 'example.com', '192.168.1.9']) {
    assert.equal(isLoopbackHost(h), false, `${h} is NOT loopback`);
  }
  const base = loadConfig({ ARES_DATA_DIR: '/tmp/ares-nonexistent-for-config-only' });
  assert.doesNotThrow(() => assertBindable(base));
  const open: AresConfig = { ...base, api: { host: '0.0.0.0', port: 8787, token: null } };
  assert.throws(
    () => assertBindable(open),
    (err: unknown) => err instanceof AresError && err.code === 'API_UNAUTHENTICATED_PUBLIC_BIND',
  );
  const openWithToken: AresConfig = { ...base, api: { host: '0.0.0.0', port: 8787, token: TOKEN } };
  assert.doesNotThrow(() => assertBindable(openWithToken));
});

test('token comparison is constant-time and rejects every near miss', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN + 'x', TOKEN), false, 'a longer guess must not throw, just fail');
  assert.equal(tokenMatches(TOKEN.slice(0, -1), TOKEN), false, 'a shorter guess must not throw, just fail');
  assert.equal(tokenMatches('', TOKEN), false);
  assert.equal(tokenMatches(null, TOKEN), false);
  assert.equal(tokenMatches(TOKEN, null), false, 'no configured token means nothing matches');
  assert.equal(tokenMatches(null, null), false);
});

/* ------------------------------------------------------------- read routes */

test('/healthz and /readyz answer, with the security headers on every response', async () => {
  const h = await harness();
  try {
    const r = await getJson(`${h.base}/healthz`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.mode, 'PAPER');
    assert.equal(r.body.halted, false);
    assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.res.headers.get('cache-control'), 'no-store');
    assert.ok((r.res.headers.get('content-security-policy') ?? '').includes("default-src 'none'"));
    assert.equal(r.res.headers.get('access-control-allow-origin'), null, 'no CORS by default');

    // Not started, so not ready. That is the honest answer.
    const ready = await getJson(`${h.base}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal(ready.body.running, false);
  } finally {
    await h.close();
  }
});

test('/api/state carries everything the dashboard needs', async () => {
  const h = await harness();
  try {
    const r = await getJson(`${h.base}/api/state`);
    assert.equal(r.status, 200);
    const s = r.body;
    assert.equal(s.mode, 'PAPER');
    assert.equal(s.killSwitch.tripped, false);
    assert.equal(typeof s.supervisor.tick, 'number');
    assert.equal(s.cash.currency, 'SAR');
    assert.equal(s.cash.startingMinor, 100_000);
    assert.equal(typeof s.cash.drawdownMinor, 'number');
    assert.equal(s.cash.maxDrawdownMinor, 20_000);
    assert.equal(Array.isArray(s.agents), true);
    assert.equal(s.agents.length, 3);
    for (const a of s.agents) {
      assert.ok(typeof a.id === 'string' && typeof a.role === 'string');
      assert.ok(typeof a.netMinor === 'number');
      assert.ok(typeof a.verdict === 'string');
      assert.ok(typeof a.status === 'string');
    }
    assert.equal(typeof s.bus.published, 'number');
    assert.equal(typeof s.policy.stats.denied, 'number');
    assert.equal(Array.isArray(s.channels), true);
    assert.equal(Array.isArray(s.recentLedger), true);
    assert.ok(typeof s.ledger.head === 'string');
  } finally {
    await h.close();
  }
});

test('/api/agents, /api/report and /api/policy answer with JSON', async () => {
  const h = await harness();
  try {
    const agents = await getJson(`${h.base}/api/agents`);
    assert.equal(agents.status, 200);
    assert.equal(agents.body.agents.length, 3);

    const report = await getJson(`${h.base}/api/report`);
    assert.equal(report.status, 200);
    assert.equal(report.body.ledger.verified, true);
    assert.match(report.body.disclaimer, /PAPER|simulated/i);

    const policy = await getJson(`${h.base}/api/policy`);
    assert.equal(policy.status, 200);
    assert.equal(typeof policy.body.stats.allowed, 'number');
    assert.equal(typeof policy.body.denialsByRule, 'object');
    assert.equal(Array.isArray(policy.body.decisions), true);
  } finally {
    await h.close();
  }
});

test('/api/ledger clamps its limit so one request cannot serialise the whole ledger', async () => {
  const h = await harness();
  try {
    const dflt = await getJson(`${h.base}/api/ledger`);
    assert.equal(dflt.status, 200);
    assert.equal(dflt.body.limit, 100, 'the default');

    const huge = await getJson(`${h.base}/api/ledger?limit=99999999`);
    assert.equal(huge.body.limit, LEDGER_LIMIT_MAX, 'clamped to the hard maximum');
    assert.equal(huge.body.max, LEDGER_LIMIT_MAX);

    const zero = await getJson(`${h.base}/api/ledger?limit=0`);
    assert.equal(zero.body.limit, 1);
    const negative = await getJson(`${h.base}/api/ledger?limit=-5`);
    assert.equal(negative.body.limit, 1);
    const nonsense = await getJson(`${h.base}/api/ledger?limit=drop%20table`);
    assert.equal(nonsense.body.limit, 100, 'garbage falls back to the default, it does not error');

    const small = await getJson(`${h.base}/api/ledger?limit=2`);
    assert.ok(small.body.entries.length <= 2);
    assert.equal(typeof small.body.size, 'number');
  } finally {
    await h.close();
  }
});

/* ---------------------------------------------------------- shapes of "no" */

test('a wrong method is 405 with Allow, and an unknown route is JSON 404', async () => {
  const h = await harness();
  try {
    const wrong = await getJson(`${h.base}/api/state`, { method: 'POST' });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.res.headers.get('allow'), 'GET, HEAD');
    assert.equal(wrong.body.error, 'method_not_allowed');
    assert.deepEqual(wrong.body.allow, ['GET', 'HEAD']);

    const getHalt = await getJson(`${h.base}/api/halt`);
    assert.equal(getHalt.status, 405);
    assert.equal(getHalt.res.headers.get('allow'), 'POST');

    const missing = await getJson(`${h.base}/api/does-not-exist`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'not_found');
    assert.match(missing.res.headers.get('content-type') ?? '', /application\/json/);

    // The same answer with a (bogus) credential: auth state must never reveal
    // whether a route exists.
    const missingAuthed = await getJson(`${h.base}/api/does-not-exist`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(missingAuthed.status, 404);
    assert.deepEqual(missingAuthed.body, missing.body);
  } finally {
    await h.close();
  }
});

/* --------------------------------------------------------------------- halt */

test('with no token configured, the halt route is refused outright even on loopback', async () => {
  const h = await harness();
  try {
    const r = await getJson(`${h.base}/api/halt`, { method: 'POST' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unauthorized');
    assert.match(r.body.message, /No operator token is configured/);
    assert.equal(h.ares.killSwitch.tripped, false, 'nothing was halted');
  } finally {
    await h.close();
  }
});

test('halt rejects an absent or wrong token and accepts the right one — irreversibly', async () => {
  const h = await harness({ ARES_API_TOKEN: TOKEN });
  try {
    const none = await getJson(`${h.base}/api/halt`, { method: 'POST' });
    assert.equal(none.status, 401);
    assert.equal(h.ares.killSwitch.tripped, false);

    const wrong = await getJson(`${h.base}/api/halt`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-the-token' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(h.ares.killSwitch.tripped, false);

    const nearMiss = await getJson(`${h.base}/api/halt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
    });
    assert.equal(nearMiss.status, 401);

    const malformed = await getJson(`${h.base}/api/halt`, {
      method: 'POST',
      headers: { authorization: TOKEN },
    });
    assert.equal(malformed.status, 401, 'the Bearer scheme is required');
    assert.equal(h.ares.killSwitch.tripped, false);

    const ok = await getJson(`${h.base}/api/halt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ reason: 'operator' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.halted, true);
    assert.equal(ok.body.irreversible, true);
    assert.match(ok.body.message, /IRREVERSIBLE/);
    assert.equal(h.ares.killSwitch.tripped, true);

    // The latch is one-way: a second halt is honest about being a no-op.
    const again = await getJson(`${h.base}/api/halt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyHalted, true);

    // ...and readiness flips.
    const ready = await getJson(`${h.base}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal(ready.body.halted, true);
  } finally {
    await h.close();
  }
});

test('an oversized halt body is refused without being buffered', async () => {
  const h = await harness({ ARES_API_TOKEN: TOKEN });
  try {
    const r = await getJson(`${h.base}/api/halt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'x'.repeat(64 * 1024),
    });
    assert.equal(r.status, 413);
    assert.equal(h.ares.killSwitch.tripped, false, 'a too-large body never reaches the halt');
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ leakage */

test('no response body leaks the token, a file path or a stack frame', async () => {
  const h = await harness({ ARES_API_TOKEN: TOKEN });
  try {
    const paths = [
      '/healthz',
      '/readyz',
      '/metrics',
      '/api/state',
      '/api/agents',
      '/api/ledger?limit=1000',
      '/api/report',
      '/api/policy',
      '/api/nope',
      '/',
      '/dashboard.js',
    ];
    for (const p of paths) {
      const res = await fetch(`${h.base}${p}`, { headers: AUTH });
      const text = await res.text();
      assert.equal(text.includes(TOKEN), false, `${p} leaked the operator token`);
      assert.equal(/\bat [\w.<>]+ \(/.test(text), false, `${p} leaked a stack frame`);
      assert.equal(text.includes(h.dir), false, `${p} leaked the data directory path`);
      assert.equal(/\/(home|root|Users)\//.test(text), false, `${p} leaked a filesystem path`);
    }
    // The unauthorised answers leak nothing either — and there are more of
    // them now, because a configured token gates every /api/* route.
    for (const p of paths) {
      const res = await fetch(`${h.base}${p}`);
      const text = await res.text();
      assert.equal(text.includes(TOKEN), false, `${p} leaked the operator token unauthenticated`);
      assert.equal(text.includes(h.dir), false, `${p} leaked the data directory path unauthenticated`);
      assert.equal(/\/(home|root|Users)\//.test(text), false, `${p} leaked a filesystem path unauthenticated`);
    }
    const unauth = await fetch(`${h.base}/api/halt`, { method: 'POST' });
    const t = await unauth.text();
    assert.equal(t.includes(TOKEN), false);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ metrics */

test('/metrics parses as valid Prometheus text exposition format', async () => {
  const h = await harness({ ARES_API_TOKEN: TOKEN });
  try {
    const res = await fetch(`${h.base}/metrics`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const text = await res.text();

    const helps = new Set<string>();
    const types = new Map<string, string>();
    const seen = new Set<string>();
    const names = new Set<string>();
    const lines = text.split('\n');
    assert.equal(lines[lines.length - 1], '', 'the exposition ends with a newline');

    for (const line of lines) {
      if (line === '') continue;
      if (line.startsWith('# HELP ')) {
        const name = line.slice(7).split(' ')[0] as string;
        assert.match(name, /^[a-zA-Z_:][a-zA-Z0-9_:]*$/);
        assert.equal(helps.has(name), false, `duplicate HELP for ${name}`);
        helps.add(name);
        continue;
      }
      if (line.startsWith('# TYPE ')) {
        const parts = line.slice(7).split(' ');
        const name = parts[0] as string;
        const type = parts[1] as string;
        assert.match(type, /^(counter|gauge|histogram|summary|untyped)$/);
        assert.equal(types.has(name), false, `duplicate TYPE for ${name}`);
        types.set(name, type);
        continue;
      }
      assert.equal(line.startsWith('#'), false, `unexpected comment line: ${line}`);

      // <name>{<labels>} <value>
      const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (-?(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|NaN|[-+]?Inf))$/.exec(line);
      assert.ok(m, `not a valid sample line: ${JSON.stringify(line)}`);
      const name = m[1] as string;
      const labels = m[2] ?? '';
      names.add(name);
      if (labels !== '') {
        const inner = labels.slice(1, -1);
        for (const pair of inner.split(/,(?=[a-zA-Z_])/)) {
          assert.match(pair, /^[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*"$/, `bad label pair: ${pair}`);
        }
      }
      const key = name + labels;
      assert.equal(seen.has(key), false, `duplicate series: ${key}`);
      seen.add(key);
    }

    for (const n of names) {
      assert.equal(helps.has(n), true, `${n} has no HELP`);
      assert.equal(types.has(n), true, `${n} has no TYPE`);
    }

    // The metrics the operator actually needs.
    for (const required of [
      'ares_up',
      'ares_tick',
      'ares_ticks_executed_total',
      'ares_cash_minor',
      'ares_drawdown_minor',
      'ares_max_drawdown_minor',
      'ares_agent_net_minor',
      'ares_agent_status',
      'ares_bus_published_total',
      'ares_bus_dropped_total',
      'ares_policy_denied_total',
      'ares_policy_denials_by_rule',
      'ares_circuit_state',
      'ares_killswitch_tripped',
      'ares_ledger_entries',
    ]) {
      assert.equal(names.has(required), true, `missing metric ${required}`);
    }
    assert.match(text, /ares_killswitch_tripped 0/);
  } finally {
    await h.close();
  }
});

/* ---------------------------------------------------------------- dashboard */

test('the dashboard is self-contained, needs no inline-script exemption, and loads its JS locally', async () => {
  const h = await harness();
  try {
    const res = await fetch(`${h.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.equal(csp.includes('unsafe-inline'), false, 'no inline-script exemption anywhere');
    assert.equal(csp.includes('unsafe-eval'), false);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /style-src 'nonce-/);

    const html = await res.text();
    assert.match(html, /PAPER/);
    assert.match(html, /prefers-color-scheme/);
    assert.match(html, /<script src="\/dashboard\.js"><\/script>/);
    // No inline script blocks at all.
    assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'an inline <script> would need a CSP hole');
    // No external references of any kind.
    assert.equal(/https?:\/\//.test(html), false, 'no CDN, no external fonts, no outbound requests');
    assert.match(html, /IRREVERSIBLE/, 'the halt control states what it does');

    const js = await fetch(`${h.base}/dashboard.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    const body = await js.text();
    assert.match(body, /\/api\/state/);
    assert.match(body, /API UNREACHABLE/, 'it degrades to a clear error, not a blank screen');
    assert.equal(/https?:\/\//.test(body), false);
  } finally {
    await h.close();
  }
});

/* --------------------------------------------------------------- lifecycle */

test('the server refuses to bind an open host without a token, and stop() is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ares-api-bind-'));
  try {
    const loaded = loadConfig({ ARES_DATA_DIR: dir });
    const bad: AresConfig = { ...loaded, api: { host: '0.0.0.0', port: 0, token: null } };
    assert.throws(
      () =>
        new ApiServer({
          cfg: bad,
          clock: new TestClock(0),
          logger: nullLogger,
        } as never),
      (err: unknown) => err instanceof AresError && err.code === 'API_UNAUTHENTICATED_PUBLIC_BIND',
    );

    const h = await harness();
    await h.ares.api.stop();
    await h.ares.api.stop(); // a second stop is a no-op
    assert.equal(h.ares.api.listening, false);
    await h.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ===================================================================== */
/* FIX B2 — a configured token gates EVERY read route, not just halt      */
/* ===================================================================== */

const GATED = ['/api/state', '/api/agents', '/api/ledger', '/api/report', '/api/policy', '/metrics'];

test('FIX B2: with a token configured, every /api/* route and /metrics require the bearer', async () => {
  const h = await harness({ ARES_API_TOKEN: TOKEN });
  try {
    for (const p of GATED) {
      const none = await getJson(`${h.base}${p}`);
      assert.equal(none.status, 401, `${p} answered 200 with NO credential — the documented escape hatch was false`);
      assert.equal(none.res.headers.get('www-authenticate'), 'Bearer realm="ares"');
      assert.equal(none.body.error, 'unauthorized');

      const wrong = await getJson(`${h.base}${p}`, { headers: { authorization: 'Bearer not-the-token-at-all-really' } });
      assert.equal(wrong.status, 401, `${p} accepted a wrong token`);

      const noScheme = await getJson(`${h.base}${p}`, { headers: { authorization: TOKEN } });
      assert.equal(noScheme.status, 401, `${p} accepted a bare token without the Bearer scheme`);

      const ok = await getJson(`${h.base}${p}`, { headers: AUTH });
      assert.equal(ok.status, 200, `${p} refused the correct token`);
    }

    // HEAD is the free amplifier: identical work, zero bytes back. It is gated
    // exactly like GET.
    for (const p of GATED) {
      const head = await fetch(`${h.base}${p}`, { method: 'HEAD' });
      assert.equal(head.status, 401, `HEAD ${p} was not gated`);
    }
  } finally {
    await h.close();
  }
});

test('FIX B2: /healthz stays open for the container healthcheck; the dashboard shell does too', async () => {
  const h = await harness({ ARES_API_TOKEN: TOKEN });
  try {
    const health = await getJson(`${h.base}/healthz`);
    assert.equal(health.status, 200, 'the Docker healthcheck has no token and must keep working');
    assert.equal(health.body.status, 'ok');
    const ready = await fetch(`${h.base}/readyz`);
    assert.ok(ready.status === 200 || ready.status === 503, 'readiness is a probe, not a data route');
    assert.equal((await fetch(`${h.base}/`)).status, 200);
    assert.equal((await fetch(`${h.base}/dashboard.js`)).status, 200);
  } finally {
    await h.close();
  }
});

test('FIX B2: with NO token configured the read routes stay open (the bind refusal is the guard)', async () => {
  const h = await harness();
  try {
    for (const p of GATED) {
      const r = await getJson(`${h.base}${p}`);
      assert.equal(r.status, 200, `${p} must still answer on a loopback-only, tokenless instance`);
    }
  } finally {
    await h.close();
  }
});

test('FIX B2: auth state still never reveals whether a route exists', async () => {
  const h = await harness({ ARES_API_TOKEN: TOKEN });
  try {
    const anon = await getJson(`${h.base}/api/does-not-exist`);
    const authed = await getJson(`${h.base}/api/does-not-exist`, { headers: AUTH });
    assert.equal(anon.status, 404);
    assert.equal(authed.status, 404);
    assert.deepEqual(anon.body, authed.body);
    // And a wrong METHOD on a real route is still 405, ahead of the auth gate,
    // so the shapes of "no" are unchanged.
    const wrongMethod = await getJson(`${h.base}/api/state`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.res.headers.get('allow'), 'GET, HEAD');
  } finally {
    await h.close();
  }
});

/* ===================================================================== */
/* FIX B1b — /api/report serves a cached verdict, never a fresh O(n) scan */
/* ===================================================================== */

test('FIX B1b: /api/report never calls ledger.verify(); it serves the cached verdict', async () => {
  const h = await harness();
  try {
    // Justified cast: counting calls to the exact method that used to re-hash
    // every entry on the request thread.
    const led = h.ares.ledger as unknown as { verify: (o?: unknown) => unknown };
    const real = led.verify.bind(h.ares.ledger);
    let calls = 0;
    led.verify = (o?: unknown) => {
      calls += 1;
      return real(o);
    };

    for (let i = 0; i < 5; i++) {
      const r = await getJson(`${h.base}/api/report`);
      assert.equal(r.status, 200);
      assert.equal(r.body.ledger.verified, true);
      assert.equal(r.body.ledger.cached, true);
      assert.equal(typeof r.body.ledger.verifiedAt, 'number');
      assert.equal(typeof r.body.ledger.verifiedAtSeq, 'number');
    }
    // HEAD did IDENTICAL work and returned zero bytes: a free amplifier.
    for (let i = 0; i < 5; i++) await fetch(`${h.base}/api/report`, { method: 'HEAD' });

    assert.equal(calls, 0, 'ten requests re-hashed the chain zero times (it was once per request, ~4.9s at 400k)');
    assert.equal(h.ares.killSwitch.tripped, false);
  } finally {
    await h.close();
  }
});

test('FIX B1b: a burst of unauthenticated GET+HEAD /api/report cannot halt the swarm', async () => {
  const h = await harness();
  try {
    // Five concurrent reads per tick, three ticks — the exact shape of the
    // reported remote halt.
    for (let tick = 0; tick < 3; tick++) {
      await Promise.all([
        fetch(`${h.base}/api/report`),
        fetch(`${h.base}/api/report`, { method: 'HEAD' }),
        fetch(`${h.base}/api/state`),
        fetch(`${h.base}/metrics`),
        fetch(`${h.base}/api/ledger?limit=1`),
      ]);
      await h.ares.supervisor.runTick(tick);
      h.clock.advance(1_000);
    }
    assert.equal(h.ares.killSwitch.tripped, false, 'no credential was presented and nothing halted');
    assert.equal(h.ares.supervisor.snapshot().overruns, 0);
  } finally {
    await h.close();
  }
});

test('FIX B1: /api/ledger?limit=1 does bounded WORK, not just a bounded response', async () => {
  const h = await harness();
  try {
    const r = await getJson(`${h.base}/api/ledger?limit=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body.returned <= 1, true);
    assert.equal(r.body.entries.length <= 1, true);
    // The most recent entry, which is what "limit" has always meant.
    assert.equal(r.body.entries[0].seq, r.body.size);
    // entries() walks backwards from the newest and stops; it no longer
    // materialises every row and slices the end off it.
    const stats = h.ares.ledger.stats();
    assert.ok(stats.retained <= stats.tailCap);
  } finally {
    await h.close();
  }
});

/* ===================================================================== */
/* FIX B6 — /readyz tells the truth about a stalled or crashed loop       */
/* ===================================================================== */

test('FIX B6: /readyz reports the loop’s liveness, not just a boolean nobody clears', async () => {
  const h = await harness();
  try {
    const r = await getJson(`${h.base}/readyz`);
    assert.equal(r.status, 503);
    assert.equal(r.body.running, false);
    assert.equal(typeof r.body.stalled, 'boolean');
    assert.equal(typeof r.body.loopCrashed, 'boolean');
    assert.equal(typeof r.body.tickOverdueMs, 'number');
    assert.equal(r.body.tickIntervalMs, 1_000);
  } finally {
    await h.close();
  }
});

/* ===================================================================== */
/* FIX B8 — the halt route locks out after repeated auth failures         */
/* ===================================================================== */

test('FIX B8: repeated halt auth failures lock the route out instead of only incrementing a counter', async () => {
  const h = await harness({ ARES_API_TOKEN: TOKEN });
  try {
    for (let i = 0; i < AUTH_LOCKOUT_AFTER - 1; i++) {
      const r = await getJson(`${h.base}/api/halt`, {
        method: 'POST',
        headers: { authorization: `Bearer guess-number-${String(i)}` },
      });
      assert.equal(r.status, 401, 'early guesses are ordinary refusals');
    }
    const locking = await getJson(`${h.base}/api/halt`, {
      method: 'POST',
      headers: { authorization: 'Bearer guess-that-locks' },
    });
    assert.equal(locking.status, 429);
    assert.equal(locking.body.error, 'too_many_attempts');
    assert.equal(locking.body.retryAfterMs, AUTH_LOCKOUT_MS);
    assert.ok(Number(locking.res.headers.get('retry-after')) > 0);

    // Locked out means locked out: even the CORRECT token is refused, so an
    // attacker cannot keep guessing and a stolen token cannot be used mid-run.
    const correct = await getJson(`${h.base}/api/halt`, { method: 'POST', headers: AUTH });
    assert.equal(correct.status, 429);
    assert.equal(h.ares.killSwitch.tripped, false);
    assert.ok(h.ares.api.stats().lockouts >= 1);
    assert.equal(h.ares.api.stats().lockedOut, true);

    // The window is measured on the injected clock, so it is deterministic.
    h.clock.advance(AUTH_LOCKOUT_MS + 1);
    assert.equal(h.ares.api.stats().lockedOut, false);
    const after = await getJson(`${h.base}/api/halt`, { method: 'POST', headers: AUTH });
    assert.equal(after.status, 200, 'the operator can halt again once the window has passed');
    assert.equal(h.ares.killSwitch.tripped, true);
    // The refusal leaked nothing.
    assert.equal(JSON.stringify(locking.body).includes(TOKEN), false);
  } finally {
    await h.close();
  }
});

test('FIX B8: a successful halt authentication clears the failure streak', async () => {
  const h = await harness({ ARES_API_TOKEN: TOKEN });
  try {
    for (let i = 0; i < AUTH_LOCKOUT_AFTER - 1; i++) {
      await getJson(`${h.base}/api/halt`, { method: 'POST', headers: { authorization: 'Bearer nope' } });
    }
    assert.equal(h.ares.api.stats().consecutiveAuthFailures, AUTH_LOCKOUT_AFTER - 1);
    const ok = await getJson(`${h.base}/api/halt`, { method: 'POST', headers: AUTH });
    assert.equal(ok.status, 200);
    assert.equal(h.ares.api.stats().consecutiveAuthFailures, 0);
    assert.equal(h.ares.api.stats().lockedOut, false);
  } finally {
    await h.close();
  }
});

/* ===================================================================== */
/* FIX B8 — Prometheus label escaping covers the carriage return          */
/* ===================================================================== */

test('FIX B8: /metrics escapes carriage returns in label values', async () => {
  const h = await harness();
  try {
    const before = h.ares.api.metricsText();
    assert.equal(before.includes('\r'), false);

    // Justified cast: force a hostile id onto a live agent to prove the
    // escaper, rather than asserting on a regex by eye.
    const agent = h.ares.registry.all()[0];
    assert.ok(agent);
    const original = agent.id;
    (agent as unknown as { id: string }).id = 'evil\r\nares_up 999';
    try {
      const text = h.ares.api.metricsText();
      assert.equal(text.includes('evil\r'), false, 'a raw CR would inject a second sample line');
      assert.match(text, /agent="evil\\r\\nares_up 999"/);
      assert.equal(text.split('\n').filter((l) => l === 'ares_up 999').length, 0);
    } finally {
      (agent as unknown as { id: string }).id = original;
    }
  } finally {
    await h.close();
  }
});
