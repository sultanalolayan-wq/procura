/**
 * market/http.ts — HttpFeed: the same PriceFeed, over the network (SPEC §4).
 * Invariant: THIS MODULE CAN ONLY GET. There is no post/put/patch/delete anywhere
 * on it, the node transport hardcodes method:'GET' and refuses any other verb, the
 * host allowlist denies by default, the scheme must be https, redirects are bounded
 * and re-validated against the same allowlist, the response is size-capped and
 * time-capped, and every call goes through the EXISTING CircuitBreaker and
 * RateLimiter from governance/circuit.ts.
 *
 * Orders never come near this file. Fills are modelled locally in
 * channels/equities.ts against bars; there is no code path from an order to a
 * socket, and test/equities.test.ts asserts that structurally against the BUILT
 * JavaScript rather than against this comment.
 *
 * This environment's proxy returns 403 to CONNECT for every market-data host, so
 * the network path is UNEXERCISED here by construction. The transport is therefore
 * INJECTED: allowlist refusal, timeout, oversize, redirect refusal, parse failure
 * and circuit behaviour are all proven in tests with no network at all.
 * Callers: the operator's own deployment. CsvFeed is what runs here.
 */

import { request as httpsRequest } from 'node:https';
import { AdapterError, AresError } from '../core/errors.js';
import type { Clock } from '../core/clock.js';
import { nullLogger, type Logger } from '../core/logger.js';
import { CircuitBreaker, RateLimiter, type CircuitOptions } from '../governance/circuit.js';
import { assertDayUtc, assertSymbol, assertVenue, cmpDay, sliceDays, type Bar, type PriceFeed, type Venue } from './feed.js';
import { parseCsvText } from './csv.js';

/* --------------------------------------------------------------- transport */

export interface HttpGetOptions {
  timeoutMs: number;
  maxBytes: number;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. Only what the feed needs: location, content-type. */
  headers: Record<string, string>;
  body: string;
}

/**
 * The injectable seam. `get` is the ONLY member: a transport has no way to
 * express a write, so no caller of this module can perform one even by mistake.
 */
export interface HttpTransport {
  readonly name: string;
  get(url: URL, opts: HttpGetOptions): Promise<HttpResponse>;
}

/** Verbs this module refuses to speak, by name, so the refusal is greppable. */
export const FORBIDDEN_METHODS: readonly string[] = Object.freeze([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'CONNECT',
  'TRACE',
  'OPTIONS',
  'HEAD',
]);

/**
 * The single place a method name is checked. Exported so a caller that builds its
 * own transport inherits the refusal rather than reimplementing it.
 */
export function assertReadOnlyMethod(method: string, where: string): 'GET' {
  const m = String(method).toUpperCase();
  if (m !== 'GET') {
    throw new AdapterError(
      'MARKET_HTTP_METHOD_REFUSED',
      `${where}: the market module is read-only and refuses ${m}. Only GET exists here.`,
      { method: m, where },
    );
  }
  return 'GET';
}

/**
 * node:https transport. Follows no redirects itself — it hands the 3xx back so
 * HttpFeed can re-run the allowlist check on the target, which is the only way a
 * redirect can be made safe.
 */
export class NodeHttpsTransport implements HttpTransport {
  readonly name = 'node:https';

  constructor(private readonly userAgent = 'ares-paper/0.1 (read-only market data)') {}

  async get(url: URL, opts: HttpGetOptions): Promise<HttpResponse> {
    if (url.protocol !== 'https:') {
      throw new AdapterError('MARKET_HTTP_INSECURE', `NodeHttpsTransport: refusing non-https URL ${url.protocol}//`, {
        url: url.toString(),
      });
    }
    const method = assertReadOnlyMethod('GET', 'NodeHttpsTransport.get');
    return new Promise<HttpResponse>((resolve, reject) => {
      const req = httpsRequest(
        url,
        { method, headers: { accept: 'text/csv, text/plain, application/json', 'user-agent': this.userAgent } },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > opts.maxBytes) {
              res.destroy();
              req.destroy();
              reject(
                new AdapterError('MARKET_HTTP_OVERSIZE', `response exceeded ${opts.maxBytes} bytes`, {
                  url: url.toString(),
                  maxBytes: opts.maxBytes,
                }),
              );
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') headers[k.toLowerCase()] = v;
              else if (Array.isArray(v) && v.length > 0) headers[k.toLowerCase()] = v[0] as string;
            }
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
          });
          res.on('error', (e) => reject(e));
        },
      );
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy();
        reject(
          new AdapterError('MARKET_HTTP_TIMEOUT', `no response within ${opts.timeoutMs}ms`, {
            url: url.toString(),
            timeoutMs: opts.timeoutMs,
          }),
        );
      });
      req.on('error', (e) =>
        reject(new AdapterError('MARKET_HTTP_ERROR', `${url.host}: ${e.message}`, { url: url.toString() })),
      );
      req.end();
    });
  }
}

/* ------------------------------------------------------------------ sources */

/**
 * A provider adapter: how to build the URL and how to read the body. Keeping this
 * separate from the transport means a new provider is ~20 lines and inherits every
 * safety property (allowlist, timeout, size cap, circuit) for free.
 */
export interface HttpSource {
  readonly name: string;
  /** The host that must appear on the allowlist for this source to work at all. */
  readonly host: string;
  url(symbol: string, venue: Venue, fromDay: string, toDay: string): URL;
  parse(body: string, symbol: string, venue: Venue, source: string): Bar[];
}

/**
 * UNVERIFIED — THE OPERATOR MUST CONFIRM THIS PROVIDER'S TERMS OF USE BEFORE USING IT.
 *
 * This is a worked example of the HttpSource shape against a keyless CSV endpoint,
 * not an endorsement and not a statement that any provider permits this use. No
 * provider's terms have been read, quoted or verified by this code or its author;
 * automated retrieval is frequently restricted, restrictions change, and they
 * differ by jurisdiction and by the use the data is put to. Read the terms, and if
 * they are ambiguous, use a provider whose terms explicitly permit what you are
 * doing (several offer a documented free tier with an API key for exactly this).
 *
 * It is also unverified in a second sense: the host is blocked in the build
 * environment, so this adapter's URL shape and column layout have NEVER been
 * checked against a live response. Confirm both before trusting a single number.
 */
export const HTTP_SOURCE_TOS_NOTE =
  'UNVERIFIED ASSUMPTION, PENDING OPERATOR REVIEW: no market-data provider\'s terms of use have ' +
  'been read or verified by this code. The operator must confirm, in writing and for their own ' +
  'jurisdiction and use, that their chosen provider permits automated retrieval before enabling ' +
  'HttpFeed. The bundled adapter is an example of the interface, not a recommendation, and its ' +
  'URL shape and CSV layout are unverified because the host is unreachable from the build ' +
  'environment.';

export interface StooqSourceOptions {
  /** Defaults to stooq.com. Must also appear on the configured host allowlist. */
  host?: string;
  /** Map an ARES symbol to the provider's symbol (e.g. AAPL -> aapl.us). */
  symbolFor?: (symbol: string, venue: Venue) => string;
}

/** Example adapter — see HTTP_SOURCE_TOS_NOTE before enabling it. */
export function stooqCsvSource(opts: StooqSourceOptions = {}): HttpSource {
  const host = opts.host ?? 'stooq.com';
  const symbolFor = opts.symbolFor ?? ((s: string, v: Venue) => (v === 'US' ? `${s.toLowerCase()}.us` : s.toLowerCase()));
  return {
    name: `stooq(${host})`,
    host,
    url(symbol, venue, fromDay, toDay) {
      const u = new URL(`https://${host}/q/d/l/`);
      u.searchParams.set('s', symbolFor(assertSymbol(symbol, 'stooqCsvSource'), venue));
      u.searchParams.set('d1', fromDay.replace(/-/g, ''));
      u.searchParams.set('d2', toDay.replace(/-/g, ''));
      u.searchParams.set('i', 'd');
      return u;
    },
    parse(body, symbol, venue, source) {
      return parseCsvText(body, { symbol, venue, source });
    },
  };
}

/* ----------------------------------------------------------------- HttpFeed */

export interface HttpFeedOptions {
  source: HttpSource;
  transport: HttpTransport;
  clock: Clock;
  /** Deny-by-default host allowlist. An empty list means NOTHING is reachable. */
  allowHosts: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  perMinute?: number;
  circuit?: CircuitOptions;
  logger?: Logger;
  /** Cache parsed series for this many ms (0 disables). Feeds are read-only. */
  cacheTtlMs?: number;
}

export const HTTP_DEFAULTS = Object.freeze({
  timeoutMs: 8_000,
  maxBytes: 2_000_000,
  maxRedirects: 2,
  perMinute: 30,
  circuit: Object.freeze({ failureThreshold: 3, cooldownMs: 60_000, halfOpenMax: 1 }) as CircuitOptions,
  cacheTtlMs: 60_000,
});

export class HttpFeed implements PriceFeed {
  readonly name: string;
  private readonly allow: ReadonlySet<string>;
  private readonly breaker: CircuitBreaker;
  private readonly limiter: RateLimiter;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { at: number; bars: Bar[] }>();
  private closed = false;

  constructor(private readonly opts: HttpFeedOptions) {
    this.name = `http:${opts.source.name}`;
    this.log = opts.logger ?? nullLogger;
    this.timeoutMs = opts.timeoutMs ?? HTTP_DEFAULTS.timeoutMs;
    this.maxBytes = opts.maxBytes ?? HTTP_DEFAULTS.maxBytes;
    this.maxRedirects = opts.maxRedirects ?? HTTP_DEFAULTS.maxRedirects;
    this.cacheTtlMs = opts.cacheTtlMs ?? HTTP_DEFAULTS.cacheTtlMs;
    const hosts = (opts.allowHosts ?? []).map((h) => h.trim().toLowerCase()).filter((h) => h !== '');
    this.allow = new Set(hosts);
    this.breaker = new CircuitBreaker('market.http', opts.circuit ?? HTTP_DEFAULTS.circuit, opts.clock, this.log);
    this.limiter = new RateLimiter(opts.perMinute ?? HTTP_DEFAULTS.perMinute, opts.clock);
    if (this.allow.size === 0) {
      // Not fatal at construction: an allowlist-empty feed that refuses every call
      // is a safer failure than one that guesses a default host.
      this.log.warn('market.http.allowlist_empty', {
        source: opts.source.name,
        note: 'HttpFeed will refuse every request until ARES_MARKET_HOSTS names a host',
      });
    }
  }

  get circuitStats(): ReturnType<CircuitBreaker['stats']> {
    return this.breaker.stats();
  }

  get rateStats(): ReturnType<RateLimiter['stats']> {
    return this.limiter.stats();
  }

  allowedHosts(): string[] {
    return [...this.allow].sort();
  }

  /**
   * Deny by default. Exact host match only: no wildcards, no suffix matching
   * ("evil-stooq.com".endsWith("stooq.com") is exactly the bug that makes suffix
   * matching unusable), and non-https is refused before the host is even consulted.
   */
  assertAllowed(url: URL, where: string): void {
    if (url.protocol !== 'https:') {
      throw new AdapterError('MARKET_HTTP_INSECURE', `${where}: refusing ${url.protocol}// — https only`, {
        url: url.toString(),
        where,
      });
    }
    const host = url.hostname.toLowerCase();
    if (!this.allow.has(host)) {
      throw new AdapterError(
        'MARKET_HOST_DENIED',
        `${where}: host ${JSON.stringify(host)} is not on the allowlist [${this.allowedHosts().join(', ') || 'empty'}]`,
        { host, where, allowed: this.allowedHosts() },
      );
    }
  }

  /** The ONLY outbound call in this class. Rate-limited, then circuit-wrapped. */
  private async fetch(url: URL): Promise<HttpResponse> {
    if (!this.limiter.tryTake(1)) {
      throw new AdapterError(
        'MARKET_RATE_LIMITED',
        `market.http: local rate limit reached (${this.limiter.stats().perMinute}/min) — request not sent`,
        { url: url.toString(), stats: this.limiter.stats() },
      );
    }
    return this.breaker.exec(async () => {
      let current = url;
      for (let hop = 0; hop <= this.maxRedirects; hop++) {
        this.assertAllowed(current, `HttpFeed.get hop ${hop}`);
        const res = await this.opts.transport.get(current, { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers['location'];
          if (loc === undefined || loc === '') {
            throw new AdapterError('MARKET_HTTP_BAD_REDIRECT', `${current.host}: ${res.status} without a location`, {
              url: current.toString(),
              status: res.status,
            });
          }
          if (hop === this.maxRedirects) {
            throw new AdapterError(
              'MARKET_HTTP_TOO_MANY_REDIRECTS',
              `${current.host}: more than ${this.maxRedirects} redirect(s)`,
              { url: current.toString(), maxRedirects: this.maxRedirects },
            );
          }
          let next: URL;
          try {
            next = new URL(loc, current);
          } catch {
            throw new AdapterError('MARKET_HTTP_BAD_REDIRECT', `${current.host}: unparseable location ${loc}`, {
              url: current.toString(),
              location: loc,
            });
          }
          // Re-validated, not trusted: a redirect off the allowlist is exactly how
          // a read-only fetch turns into a request to somewhere it should not go.
          this.assertAllowed(next, `HttpFeed.redirect from ${current.host}`);
          this.log.debug('market.http.redirect', { from: current.toString(), to: next.toString(), hop });
          current = next;
          continue;
        }
        if (res.status !== 200) {
          throw new AdapterError('MARKET_HTTP_STATUS', `${current.host}: HTTP ${res.status}`, {
            url: current.toString(),
            status: res.status,
          });
        }
        if (res.body.length > this.maxBytes) {
          throw new AdapterError(
            'MARKET_HTTP_OVERSIZE',
            `${current.host}: body of ${res.body.length} bytes exceeds the ${this.maxBytes}-byte ceiling`,
            { url: current.toString(), bytes: res.body.length, maxBytes: this.maxBytes },
          );
        }
        return res;
      }
      /* c8 ignore next */
      throw new AdapterError('MARKET_HTTP_TOO_MANY_REDIRECTS', `${url.host}: redirect loop`, { url: url.toString() });
    });
  }

  private assertOpen(op: string): void {
    if (this.closed) throw new AdapterError('MARKET_FEED_CLOSED', `HttpFeed.${op}: feed is closed`, { op });
  }

  async bars(symbol: string, venue: Venue, fromDay: string, toDay: string): Promise<Bar[]> {
    this.assertOpen('bars');
    assertSymbol(symbol, 'HttpFeed.bars');
    assertVenue(venue, 'HttpFeed.bars');
    assertDayUtc(fromDay, 'HttpFeed.bars(fromDay)');
    assertDayUtc(toDay, 'HttpFeed.bars(toDay)');
    if (cmpDay(fromDay, toDay) > 0) {
      throw new AresError('MARKET_BAD_RANGE', `HttpFeed.bars: fromDay ${fromDay} is after toDay ${toDay}`, {
        fromDay,
        toDay,
      });
    }
    const key = `${venue}:${symbol}:${fromDay}:${toDay}`;
    const now = this.opts.clock.now();
    const hit = this.cache.get(key);
    if (hit !== undefined && this.cacheTtlMs > 0 && now - hit.at < this.cacheTtlMs) return sliceDays(hit.bars, fromDay, toDay);

    const url = this.opts.source.url(symbol, venue, fromDay, toDay);
    this.assertAllowed(url, `HttpFeed.bars(${this.opts.source.name})`);
    const res = await this.fetch(url);
    const where = `${this.opts.source.name}:${symbol}`;
    const parsed = this.opts.source.parse(res.body, symbol, venue, where);
    this.cache.set(key, { at: now, bars: parsed });
    return sliceDays(parsed, fromDay, toDay);
  }

  /**
   * "The newest bar the provider will give us." Deliberately implemented as a
   * bounded window request ending today rather than as a separate "quote" call:
   * there is no live-quote path in this module, only completed daily bars.
   */
  async latest(symbol: string, venue: Venue): Promise<Bar | null> {
    this.assertOpen('latest');
    const today = new Date(this.opts.clock.now()).toISOString().slice(0, 10);
    const from = new Date(this.opts.clock.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const got = await this.bars(symbol, venue, from, today);
    return got.length === 0 ? null : (got[got.length - 1] as Bar);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cache.clear();
  }
}
