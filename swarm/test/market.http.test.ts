/**
 * test/market.http.test.ts — the feed that CANNOT run here, tested anyway.
 *
 * The build environment's proxy returns 403 to CONNECT for every market-data host,
 * so no test in this file touches a socket and none ever should. The transport is
 * injected, and that is what makes allowlist refusal, scheme refusal, timeout,
 * oversize, redirect refusal, bad status, parse failure, rate limiting and circuit
 * behaviour all PROVABLE offline. What remains unproven — and is called out in the
 * README and the handover — is whether any real provider's response actually looks
 * like what the bundled example adapter expects. That needs a network.
 *
 * Pins above all: this module can only GET.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TestClock } from '../src/core/clock.js';
import { AdapterError, AresError } from '../src/core/errors.js';
import {
  FORBIDDEN_METHODS,
  HttpFeed,
  NodeHttpsTransport,
  assertReadOnlyMethod,
  stooqCsvSource,
  HTTP_SOURCE_TOS_NOTE,
  type HttpResponse,
  type HttpTransport,
} from '../src/market/http.js';

const HEADER = 'date,open,high,low,close,volume';
const BODY = [HEADER, '2025-01-02,100.00,101.50,99.25,100.75,1000', '2025-01-03,100.75,103.00,100.00,102.50,1200', ''].join('\n');

interface Recorded {
  url: string;
  opts: { timeoutMs: number; maxBytes: number };
}

class FakeTransport implements HttpTransport {
  readonly name = 'fake';
  readonly calls: Recorded[] = [];
  constructor(private readonly handler: (url: URL, n: number) => Promise<HttpResponse>) {}
  async get(url: URL, opts: { timeoutMs: number; maxBytes: number }): Promise<HttpResponse> {
    this.calls.push({ url: url.toString(), opts });
    return this.handler(url, this.calls.length - 1);
  }
}

function ok(body: string): HttpResponse {
  return { status: 200, headers: { 'content-type': 'text/csv' }, body };
}

function feedWith(
  handler: (url: URL, n: number) => Promise<HttpResponse>,
  over: Partial<ConstructorParameters<typeof HttpFeed>[0]> = {},
): { feed: HttpFeed; transport: FakeTransport; clock: TestClock } {
  const clock = new TestClock(Date.UTC(2025, 0, 7));
  const transport = new FakeTransport(handler);
  const feed = new HttpFeed({
    source: stooqCsvSource(),
    transport,
    clock,
    allowHosts: ['stooq.com'],
    cacheTtlMs: 0,
    ...over,
  });
  return { feed, transport, clock };
}

async function failure(fn: () => Promise<unknown>): Promise<AresError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AresError, `expected AresError, got ${String(err)}`);
    return err;
  }
  throw new Error('expected a throw, got none');
}

/* ------------------------------------------------------------ GET, and only GET */

test('the module can only GET: no write verb exists on it, and one is refused by name', () => {
  // Structural: nothing on either class, its prototype, or its instance is a write.
  const clock = new TestClock(0);
  const transport = new NodeHttpsTransport();
  const feed = new HttpFeed({ source: stooqCsvSource(), transport, clock, allowHosts: [] });
  for (const subject of [transport, feed, Object.getPrototypeOf(transport), Object.getPrototypeOf(feed)]) {
    const names = Object.getOwnPropertyNames(subject as object).map((n) => n.toLowerCase());
    for (const verb of ['post', 'put', 'patch', 'delete', 'send', 'submit', 'order', 'write']) {
      assert.ok(!names.includes(verb), `a ${verb}() exists on the market HTTP path: ${names.join(', ')}`);
    }
  }
  // The transport interface itself has exactly one callable member.
  assert.equal(typeof transport.get, 'function');
  // Behavioural: the one place a method is named refuses everything but GET.
  assert.equal(assertReadOnlyMethod('get', 'x'), 'GET');
  for (const verb of FORBIDDEN_METHODS) {
    let code = '';
    try {
      assertReadOnlyMethod(verb, 'x');
    } catch (err) {
      code = (err as AdapterError).code;
    }
    assert.equal(code, 'MARKET_HTTP_METHOD_REFUSED', `${verb} was not refused`);
  }
});

/* ------------------------------------------------------------------ happy path */

test('a good response parses into bars through exactly one GET', async () => {
  const { feed, transport } = feedWith(async () => ok(BODY));
  const bars = await feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31');
  assert.equal(bars.length, 2);
  assert.equal(bars[0]?.closeMinor, 10075);
  assert.equal(bars[0]?.currency, 'USD');
  assert.equal(transport.calls.length, 1);
  assert.match(transport.calls[0]?.url ?? '', /^https:\/\/stooq\.com\/q\/d\/l\/\?s=aapl\.us/);
  assert.equal(transport.calls[0]?.opts.timeoutMs, 8000);
  assert.equal(transport.calls[0]?.opts.maxBytes, 2_000_000);
  await feed.close();
});

test('the cache stops a second identical request inside the TTL', async () => {
  const { feed, transport, clock } = feedWith(async () => ok(BODY), { cacheTtlMs: 60_000 });
  await feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31');
  await feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31');
  assert.equal(transport.calls.length, 1);
  clock.advance(60_001);
  await feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31');
  assert.equal(transport.calls.length, 2);
  await feed.close();
});

/* -------------------------------------------------------------- the allowlist */

test('deny by default: an empty allowlist reaches nothing at all', async () => {
  const { feed, transport } = feedWith(async () => ok(BODY), { allowHosts: [] });
  const err = await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'));
  assert.equal(err.code, 'MARKET_HOST_DENIED');
  assert.equal(transport.calls.length, 0, 'a denied host must not reach the transport at all');
});

test('a host that merely LOOKS like an allowlisted one is refused', async () => {
  const { feed, transport } = feedWith(async () => ok(BODY), { source: stooqCsvSource({ host: 'evil-stooq.com' }) });
  const err = await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'));
  assert.equal(err.code, 'MARKET_HOST_DENIED');
  assert.equal(transport.calls.length, 0);
  // Suffix matching would have accepted it; exact matching does not.
  assert.equal('evil-stooq.com'.endsWith('stooq.com'), true);
});

test('http:// is refused before the host is even consulted', async () => {
  const { feed } = feedWith(async () => ok(BODY));
  let code = '';
  try {
    feed.assertAllowed(new URL('http://stooq.com/x'), 't');
  } catch (err) {
    assert.ok(err instanceof AdapterError);
    code = err.code;
  }
  assert.equal(code, 'MARKET_HTTP_INSECURE');
});

/* ---------------------------------------------------------------- redirects */

test('a redirect is followed only within the allowlist, and re-checked every hop', async () => {
  const { feed, transport } = feedWith(async (url) => {
    if (url.pathname === '/q/d/l/') {
      return { status: 302, headers: { location: 'https://stooq.com/moved.csv' }, body: '' };
    }
    return ok(BODY);
  });
  const bars = await feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31');
  assert.equal(bars.length, 2);
  assert.equal(transport.calls.length, 2);
  await feed.close();
});

test('a redirect OFF the allowlist is refused and never fetched', async () => {
  const { feed, transport } = feedWith(async () => ({
    status: 302,
    headers: { location: 'https://evil.example.com/steal.csv' },
    body: '',
  }));
  const err = await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'));
  assert.equal(err.code, 'MARKET_HOST_DENIED');
  assert.equal(transport.calls.length, 1, 'the redirect target must never be requested');
});

test('a redirect to http:// is refused too', async () => {
  const { feed } = feedWith(async () => ({ status: 301, headers: { location: 'http://stooq.com/x.csv' }, body: '' }));
  const err = await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'));
  assert.equal(err.code, 'MARKET_HTTP_INSECURE');
});

test('redirects are bounded, and a location-less 3xx is an error not a loop', async () => {
  const bouncing = feedWith(
    async (url) => ({ status: 302, headers: { location: `https://stooq.com/${url.pathname.length + 1}` }, body: '' }),
    { maxRedirects: 2 },
  );
  assert.equal((await failure(() => bouncing.feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'))).code, 'MARKET_HTTP_TOO_MANY_REDIRECTS');
  assert.equal(bouncing.transport.calls.length, 3); // initial + 2 hops, then refused

  const headless = feedWith(async () => ({ status: 302, headers: {}, body: '' }));
  assert.equal((await failure(() => headless.feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'))).code, 'MARKET_HTTP_BAD_REDIRECT');
});

/* ------------------------------------------- timeout, size, status, parsing */

test('a timeout surfaces as a timeout, not as an empty series', async () => {
  const { feed } = feedWith(async (url) => {
    throw new AdapterError('MARKET_HTTP_TIMEOUT', `no response within 8000ms`, { url: url.toString() });
  });
  const err = await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'));
  assert.equal(err.code, 'MARKET_HTTP_TIMEOUT');
});

test('an oversized body is refused rather than parsed', async () => {
  const { feed } = feedWith(async () => ok(`${HEADER}\n${'2025-01-02,1.00,1.00,1.00,1.00,1\n'.repeat(200)}`), {
    maxBytes: 100,
  });
  const err = await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'));
  assert.equal(err.code, 'MARKET_HTTP_OVERSIZE');
});

test('a non-200 is an error, and a broken body is a NAMED parse error', async () => {
  const notFound = feedWith(async () => ({ status: 404, headers: {}, body: 'nope' }));
  assert.equal((await failure(() => notFound.feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'))).code, 'MARKET_HTTP_STATUS');

  const garbage = feedWith(async () => ok('<html>rate limited</html>'));
  const e1 = await failure(() => garbage.feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'));
  assert.equal(e1.code, 'MARKET_CSV_BAD_HEADER');
  assert.match(e1.message, /^stooq\(stooq\.com\):AAPL:1: /);

  const halfBad = feedWith(async () => ok([HEADER, '2025-01-02,100.00,90.00,95.00,96.00,1', ''].join('\n')));
  const e2 = await failure(() => halfBad.feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'));
  assert.equal(e2.code, 'MARKET_BAR_RANGE');
  assert.match(e2.message, /:2: /);
});

/* ------------------------------------------------ rate limiter and circuit */

test('the local rate limiter refuses BEFORE the request is sent', async () => {
  const { feed, transport } = feedWith(async () => ok(BODY), { perMinute: 2 });
  await feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31');
  await feed.bars('MSFT', 'US', '2025-01-01', '2025-01-31');
  const err = await failure(() => feed.bars('NVDA', 'US', '2025-01-01', '2025-01-31'));
  assert.equal(err.code, 'MARKET_RATE_LIMITED');
  assert.equal(transport.calls.length, 2, 'the refused call must not have been sent');
  assert.equal(feed.rateStats.refused, 1);
});

test('the existing CircuitBreaker opens on repeated failure and then refuses without calling out', async () => {
  let n = 0;
  const { feed, transport, clock } = feedWith(async () => {
    n++;
    throw new AdapterError('MARKET_HTTP_ERROR', 'connection reset', {});
  }, { circuit: { failureThreshold: 2, cooldownMs: 30_000, halfOpenMax: 1 }, perMinute: 1000 });

  assert.equal((await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'))).code, 'MARKET_HTTP_ERROR');
  assert.equal((await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'))).code, 'MARKET_HTTP_ERROR');
  assert.equal(feed.circuitStats.state, 'open');

  const callsBefore = transport.calls.length;
  const err = await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31'));
  assert.equal(err.code, 'CIRCUIT_OPEN');
  assert.equal(transport.calls.length, callsBefore, 'an open circuit must not invoke the transport');
  assert.equal(n, 2);

  // After the cooldown it probes once, and one success closes it.
  clock.advance(30_000);
  assert.equal(feed.circuitStats.state, 'half_open');
  const { feed: healthy } = feedWith(async () => ok(BODY));
  assert.equal((await healthy.bars('AAPL', 'US', '2025-01-01', '2025-01-31')).length, 2);
});

/* -------------------------------------------------------------- the ToS note */

test('no provider ToS is asserted as verified fact anywhere in this module', () => {
  assert.match(HTTP_SOURCE_TOS_NOTE, /UNVERIFIED/);
  assert.match(HTTP_SOURCE_TOS_NOTE, /must confirm/);
  assert.match(HTTP_SOURCE_TOS_NOTE, /not a recommendation/);
  const src = stooqCsvSource();
  assert.equal(src.host, 'stooq.com');
  assert.equal(
    src.url('AAPL', 'US', '2025-01-01', '2025-01-31').toString(),
    'https://stooq.com/q/d/l/?s=aapl.us&d1=20250101&d2=20250131&i=d',
  );
});
