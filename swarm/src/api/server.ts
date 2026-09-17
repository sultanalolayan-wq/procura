/**
 * api/server.ts — the operator control surface, on node:http with no framework.
 * Invariants: it REFUSES TO START on a non-loopback host without a token (never
 * an unauthenticated control surface on a public interface); the halt token is
 * compared with crypto.timingSafeEqual over equal-length digests, never ===;
 * no response body ever contains a stack trace, a config value, a token or a
 * file path; /api/ledger?limit= is clamped so one request cannot serialise weeks
 * of ledger into memory; halt is irreversible and says so.
 * Callers: runtime/orchestrator, src/index.ts, tests.
 */

import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { AresError } from '../core/errors.js';
import type { AresConfig } from '../core/config.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Ledger, LedgerEntry } from '../core/ledger.js';
import type { Bus } from '../bus/bus.js';
import type { BudgetGovernor } from '../governance/budget.js';
import type { KillSwitch } from '../governance/killswitch.js';
import type { PolicyEngine } from '../governance/policy.js';
import type { SurvivalEvaluator } from '../governance/survival.js';
import type { ChannelAdapter } from '../channels/adapter.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { TreasuryAgent } from '../agents/treasury.js';
import type { Supervisor } from '../runtime/supervisor.js';
import { DASHBOARD_JS, renderDashboardHtml } from './dashboard.js';

/** Default and hard ceiling for /api/ledger?limit=. */
export const LEDGER_LIMIT_DEFAULT = 100;
export const LEDGER_LIMIT_MAX = 1000;

/** Largest request body accepted on a mutating route. */
export const MAX_BODY_BYTES = 4096;

/** Entries embedded in /api/state for the dashboard's ledger panel. */
export const STATE_LEDGER_ROWS = 25;

export interface ApiDeps {
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
  supervisor: Supervisor;
  channels: Map<string, ChannelAdapter>;
  /** Supplies survival verdicts for the state view. Optional: no treasury, no verdicts. */
  treasury?: TreasuryAgent | null;
}

interface RouteSpec {
  methods: string[];
}

/** Every route the server knows, and the methods it answers on. */
const ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze({
  '/': { methods: ['GET', 'HEAD'] },
  '/dashboard.js': { methods: ['GET', 'HEAD'] },
  '/healthz': { methods: ['GET', 'HEAD'] },
  '/readyz': { methods: ['GET', 'HEAD'] },
  '/metrics': { methods: ['GET', 'HEAD'] },
  '/api/state': { methods: ['GET', 'HEAD'] },
  '/api/agents': { methods: ['GET', 'HEAD'] },
  '/api/ledger': { methods: ['GET', 'HEAD'] },
  '/api/report': { methods: ['GET', 'HEAD'] },
  '/api/policy': { methods: ['GET', 'HEAD'] },
  '/api/halt': { methods: ['POST'] },
});

/** Hosts that only the machine itself can reach. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

export function isLoopbackHost(host: string): boolean {
  const h = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK.has(h)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The bind refusal. A control surface that can halt the swarm must never be
 * reachable off-box without proof of who is calling.
 */
export function assertBindable(cfg: AresConfig): void {
  if (!isLoopbackHost(cfg.api.host) && (cfg.api.token === null || cfg.api.token.length === 0)) {
    throw new AresError(
      'API_UNAUTHENTICATED_PUBLIC_BIND',
      'API refused to start: ARES_API_HOST is not a loopback address and no ARES_API_TOKEN is set. ' +
        'Binding the operator control surface (which can halt the swarm) to a non-loopback interface ' +
        'without authentication is never acceptable. Either set ARES_API_HOST=127.0.0.1 or set ' +
        'ARES_API_TOKEN to a long random secret.',
      {},
    );
  }
}

/** Constant-time token check over equal-length digests. */
export function tokenMatches(presented: string | null, configured: string | null): boolean {
  if (configured === null || configured.length === 0) return false;
  if (presented === null || presented.length === 0) return false;
  // Hashing first makes the comparison constant-length as well as constant-time,
  // so a wrong-length guess leaks nothing through timingSafeEqual's own throw.
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(configured, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  const raw = Array.isArray(h) ? h[0] : h;
  if (typeof raw !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m && m[1] ? m[1] : null;
}

function clampLimit(raw: string | null): number {
  if (raw === null) return LEDGER_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return LEDGER_LIMIT_DEFAULT;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > LEDGER_LIMIT_MAX) return LEDGER_LIMIT_MAX;
  return i;
}

/** Prometheus label values: escape backslash, quote and newline. Nothing else. */
function lbl(v: unknown): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function metricNum(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '0';
}

export interface StateAgentRow {
  id: string;
  role: string;
  strategyId: string;
  status: string;
  netMinor: number;
  verdict: string;
  verdictReason: string;
  crashes: number;
  holdings: number;
  holdingValueMinor: number;
  openReservations: number;
  terminated: boolean;
  survival: { windows: number; samples: number; successes: number; failStreak: number } | null;
}

export class ApiServer {
  private readonly deps: ApiDeps;
  private readonly cfg: AresConfig;
  private readonly log: Logger;
  private server: Server | null = null;
  private boundPort = 0;
  private boundHost = '';
  private readonly startedAt: number;
  private requests = 0;
  private haltRequests = 0;
  private authFailures = 0;

  constructor(deps: ApiDeps) {
    this.deps = deps;
    this.cfg = deps.cfg;
    this.log = deps.logger.child({ mod: 'api' });
    this.startedAt = deps.clock.now();
    // Loud at construction, not at first request.
    assertBindable(deps.cfg);
  }

  get port(): number {
    return this.boundPort;
  }

  get host(): string {
    return this.boundHost;
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening;
  }

  // ----------------------------------------------------------- lifecycle --

  async start(): Promise<{ host: string; port: number }> {
    assertBindable(this.cfg);
    if (this.server !== null) {
      this.log.warn('api.start_repeat', { port: this.boundPort });
      return { host: this.boundHost, port: this.boundPort };
    }
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    // A 24/7 process must not accumulate half-open sockets.
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 64;
    server.on('clientError', (_err, socket) => {
      if ('writable' in socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.cfg.api.port, this.cfg.api.host);
    });

    this.server = server;
    const addr = server.address();
    this.boundPort = typeof addr === 'object' && addr !== null ? addr.port : this.cfg.api.port;
    this.boundHost = this.cfg.api.host;
    this.log.info('api.listening', {
      host: this.boundHost,
      port: this.boundPort,
      loopback: isLoopbackHost(this.boundHost),
      authenticated: this.cfg.api.token !== null,
      mutatingRoutesEnabled: this.cfg.api.token !== null,
    });
    return { host: this.boundHost, port: this.boundPort };
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (s === null) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
    this.log.info('api.stopped', { port: this.boundPort, requests: this.requests });
  }

  // ------------------------------------------------------------- routing --

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requests += 1;
    let path = '/';
    let query: URLSearchParams = new URLSearchParams();
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      path = url.pathname;
      query = url.searchParams;
    } catch {
      this.json(req, res, 400, { error: 'bad_request' });
      return;
    }
    // Normalise a trailing slash so /api/state/ is not a mystery 404.
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      const spec = ROUTES[path];
      if (spec === undefined) {
        this.json(req, res, 404, { error: 'not_found' });
        return;
      }
      if (!spec.methods.includes(method)) {
        res.setHeader('Allow', spec.methods.join(', '));
        this.json(req, res, 405, { error: 'method_not_allowed', allow: spec.methods });
        return;
      }
      switch (path) {
        case '/':
          this.dashboard(req, res);
          return;
        case '/dashboard.js':
          this.script(req, res);
          return;
        case '/healthz':
          this.json(req, res, 200, {
            status: 'ok',
            mode: this.cfg.mode,
            halted: this.deps.killSwitch.tripped,
            uptimeMs: this.deps.clock.now() - this.startedAt,
            tick: this.deps.supervisor.currentTick,
          });
          return;
        case '/readyz': {
          const sup = this.deps.supervisor.snapshot();
          const ready = sup.running && !this.deps.killSwitch.tripped;
          this.json(req, res, ready ? 200 : 503, {
            status: ready ? 'ready' : 'not_ready',
            running: sup.running,
            halted: this.deps.killSwitch.tripped,
            shuttingDown: sup.shuttingDown,
          });
          return;
        }
        case '/metrics':
          this.text(req, res, 200, 'text/plain; version=0.0.4; charset=utf-8', this.metricsText());
          return;
        case '/api/state':
          this.json(req, res, 200, this.state());
          return;
        case '/api/agents':
          this.json(req, res, 200, { agents: this.agents() });
          return;
        case '/api/ledger': {
          const limit = clampLimit(query.get('limit'));
          const entries = this.deps.ledger.entries({ limit });
          this.json(req, res, 200, {
            limit,
            max: LEDGER_LIMIT_MAX,
            size: this.deps.ledger.size(),
            head: this.deps.ledger.head(),
            returned: entries.length,
            entries,
          });
          return;
        }
        case '/api/report':
          this.json(req, res, 200, this.report());
          return;
        case '/api/policy':
          this.json(req, res, 200, {
            stats: this.deps.policy.stats(),
            denialsByRule: this.denialsByRule(),
            decisions: this.deps.policy.decisions(100),
          });
          return;
        case '/api/halt':
          await this.halt(req, res);
          return;
        default:
          this.json(req, res, 404, { error: 'not_found' });
          return;
      }
    } catch (err) {
      // The only place an exception can reach. The detail goes to the redacting
      // logger; the client gets a bare code and no internals whatsoever.
      this.log.error('api.request_failed', {
        path,
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) this.json(req, res, 500, { error: 'internal_error' });
      else res.end();
    }
  }

  // ---------------------------------------------------------------- halt --

  private async halt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.haltRequests += 1;
    // Drain (and cap) the body before answering, so a client is never left
    // writing into a socket nobody is reading.
    const body = await this.readBody(req);
    if (body === null) {
      // Answer FIRST, then close. Destroying the socket instead would leave the
      // client with a connection reset and no idea why it was refused.
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
      this.json(req, res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
      return;
    }

    if (this.cfg.api.token === null || this.cfg.api.token.length === 0) {
      // No token configured: mutating routes are refused OUTRIGHT, loopback or
      // not. An unauthenticated halt endpoint is a denial-of-service primitive
      // for anything that can reach the socket, including local malware.
      this.authFailures += 1;
      this.log.warn('api.halt_refused_no_token', {});
      res.setHeader('WWW-Authenticate', 'Bearer realm="ares"');
      this.json(req, res, 401, {
        error: 'unauthorized',
        message:
          'No operator token is configured, so mutating routes are disabled. ' +
          'Set ARES_API_TOKEN, or halt out of band by creating the HALT file in the data directory.',
      });
      return;
    }
    if (!tokenMatches(bearerOf(req), this.cfg.api.token)) {
      this.authFailures += 1;
      this.log.warn('api.halt_unauthorized', { remote: req.socket.remoteAddress ?? null });
      res.setHeader('WWW-Authenticate', 'Bearer realm="ares"');
      this.json(req, res, 401, { error: 'unauthorized', message: 'A valid bearer token is required.' });
      return;
    }

    const already = this.deps.killSwitch.tripped;
    if (!already) this.deps.killSwitch.trip('halted by operator via API', { via: 'POST /api/halt' });
    this.log.error('api.halted', { already, reason: this.deps.killSwitch.reason });
    this.json(req, res, 200, {
      halted: true,
      alreadyHalted: already,
      reason: this.deps.killSwitch.reason,
      irreversible: true,
      message:
        'The swarm is halted. This is IRREVERSIBLE for the life of this process: the kill switch ' +
        'is a one-way latch and nothing can un-trip it. Restart the process to resume trading.',
    });
  }

  /** Read at most MAX_BODY_BYTES; null means the client sent more. */
  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      let done = false;
      const finish = (v: string | null): void => {
        if (done) return;
        done = true;
        resolve(v);
      };
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          // Stop reading but leave the socket alive long enough to say why.
          req.pause();
          finish(null);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => finish(null));
    });
  }

  // --------------------------------------------------------------- views --

  agents(): StateAgentRow[] {
    const tick = Math.max(0, this.deps.supervisor.currentTick);
    const verdicts = new Map<string, { verdict: string; reason: string }>();
    const t = this.deps.treasury;
    if (t) {
      try {
        for (const v of t.verdicts()) verdicts.set(v.id, { verdict: String(v.verdict), reason: v.reason });
      } catch {
        /* the view must render even if the treasury is mid-termination */
      }
    }
    return this.deps.registry.all().map((a) => {
      const s = a.snapshot();
      const v = verdicts.get(a.id);
      // Read-only: survival.evaluate() LOCKS a window's verdict, so the API
      // must never call it — only the treasury may, on the window boundary.
      const st = this.deps.survival.state(a.id);
      return {
        id: a.id,
        role: a.role,
        strategyId: a.strategyId,
        status: a.status,
        netMinor: this.deps.ledger.netCashFlow(0, tick, a.id),
        verdict: v?.verdict ?? 'UNJUDGED',
        verdictReason: v?.reason ?? '',
        crashes: s.crashes,
        holdings: s.holdings,
        holdingValueMinor: s.holdingValueMinor,
        openReservations: s.openReservations,
        terminated: s.terminated,
        survival:
          st === null
            ? null
            : { windows: st.windows, samples: st.samples, successes: st.successes, failStreak: st.failStreak },
      };
    });
  }

  denialsByRule(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const d of this.deps.policy.decisions()) {
      if (d.allowed) continue;
      out[d.rule] = (out[d.rule] ?? 0) + 1;
    }
    return out;
  }

  state(): Record<string, unknown> {
    const b = this.deps.budget.snapshot();
    const ks = this.deps.killSwitch.snapshot();
    const sup = this.deps.supervisor.snapshot();
    const entries = this.deps.ledger.entries({ limit: STATE_LEDGER_ROWS });
    return {
      mode: this.cfg.mode,
      ts: this.deps.clock.now(),
      startedAt: this.startedAt,
      uptimeMs: this.deps.clock.now() - this.startedAt,
      killSwitch: { tripped: ks.tripped, reason: ks.reason, trippedAt: ks.trippedAt },
      supervisor: sup,
      cash: {
        currency: this.cfg.baseCurrency,
        onHandMinor: b.cash.onHandMinor,
        startingMinor: b.cash.startingMinor,
        globalCapMinor: b.cash.globalCapMinor,
        spentMinor: b.cash.spentMinor,
        outstandingMinor: b.cash.outstandingMinor,
        drawdownMinor: b.cash.drawdownMinor,
        maxDrawdownMinor: this.cfg.budget.maxDrawdownMinor,
      },
      tokens: b.tokens,
      ledger: {
        size: this.deps.ledger.size(),
        head: this.deps.ledger.head(),
        balances: this.deps.ledger.balances(),
      },
      agents: this.agents(),
      bus: this.deps.bus.stats(),
      policy: { stats: this.deps.policy.stats(), denialsByRule: this.denialsByRule() },
      channels: [...this.deps.channels.values()].map((c) => ({
        name: c.name,
        canBuy: c.capabilities.canBuy,
        canSell: c.capabilities.canSell,
        jurisdiction: c.capabilities.jurisdiction,
      })),
      recentLedger: entries.map((e: LedgerEntry) => ({
        seq: e.seq,
        tick: e.tick,
        type: e.type,
        agentId: e.agentId,
        legs: e.legs,
      })),
    };
  }

  report(): Record<string, unknown> {
    const v = this.deps.ledger.verify();
    const b = this.deps.budget.snapshot();
    const agents = this.agents();
    return {
      mode: this.cfg.mode,
      generatedAt: this.deps.clock.now(),
      uptimeMs: this.deps.clock.now() - this.startedAt,
      disclaimer:
        'PAPER mode. Every figure below comes from a simulated market; no real funds moved and no ' +
        'real order was ever placed. These numbers are not evidence of profitability.',
      supervisor: this.deps.supervisor.snapshot(),
      halted: this.deps.killSwitch.tripped,
      haltReason: this.deps.killSwitch.reason,
      ledger: { verified: v.ok, brokenAtSeq: v.brokenAtSeq ?? null, entries: this.deps.ledger.size() },
      balances: this.deps.ledger.balances(),
      cash: b.cash,
      tokens: b.tokens,
      agents: agents.map((a) => ({
        id: a.id,
        role: a.role,
        strategyId: a.strategyId,
        status: a.status,
        netMinor: a.netMinor,
        verdict: a.verdict,
        crashes: a.crashes,
      })),
      registry: this.deps.registry.snapshot(),
      policy: { stats: this.deps.policy.stats(), denialsByRule: this.denialsByRule() },
      bus: this.deps.bus.stats(),
      loopSuspects: this.deps.bus.loopSuspects(),
    };
  }

  // ------------------------------------------------------------- metrics --

  /** Prometheus text exposition format, version 0.0.4. */
  metricsText(): string {
    const out: string[] = [];
    const push = (name: string, help: string, type: 'counter' | 'gauge', lines: string[]): void => {
      out.push(`# HELP ${name} ${help}`);
      out.push(`# TYPE ${name} ${type}`);
      for (const l of lines) out.push(l);
    };
    const sup = this.deps.supervisor.snapshot();
    const b = this.deps.budget.snapshot();
    const bus = this.deps.bus.stats();
    const agents = this.agents();

    push('ares_up', 'Always 1 while the API is answering.', 'gauge', ['ares_up 1']);
    push('ares_mode_info', 'Operating mode. PAPER is the only permitted value.', 'gauge', [
      `ares_mode_info{mode="${lbl(this.cfg.mode)}"} 1`,
    ]);
    push('ares_tick', 'Current tick number.', 'gauge', [`ares_tick ${metricNum(sup.tick)}`]);
    push('ares_ticks_executed_total', 'Ticks the supervisor has executed.', 'counter', [
      `ares_ticks_executed_total ${metricNum(sup.ticksExecuted)}`,
    ]);
    push('ares_ticks_skipped_total', 'Ticks skipped because a tick overran its interval.', 'counter', [
      `ares_ticks_skipped_total ${metricNum(sup.ticksSkipped)}`,
    ]);
    push('ares_tick_duration_ms', 'Duration of the most recent tick, in milliseconds.', 'gauge', [
      `ares_tick_duration_ms ${metricNum(sup.lastTickMs)}`,
    ]);
    push('ares_tick_overruns_total', 'Ticks that exceeded the watchdog budget.', 'counter', [
      `ares_tick_overruns_total ${metricNum(sup.overruns)}`,
    ]);
    push('ares_agent_crashes_total', 'Agent crashes observed by the supervisor.', 'counter', [
      `ares_agent_crashes_total ${metricNum(sup.agentCrashes)}`,
    ]);
    push('ares_killswitch_tripped', 'One when the kill switch is latched.', 'gauge', [
      `ares_killswitch_tripped ${this.deps.killSwitch.tripped ? 1 : 0}`,
    ]);
    push('ares_cash_minor', 'Cash on hand in minor currency units.', 'gauge', [
      `ares_cash_minor{currency="${lbl(this.cfg.baseCurrency)}"} ${metricNum(b.cash.onHandMinor)}`,
    ]);
    push('ares_starting_cash_minor', 'Opening cash in minor currency units.', 'gauge', [
      `ares_starting_cash_minor ${metricNum(b.cash.startingMinor)}`,
    ]);
    push('ares_drawdown_minor', 'Drawdown from the opening balance, in minor units.', 'gauge', [
      `ares_drawdown_minor ${metricNum(b.cash.drawdownMinor)}`,
    ]);
    push('ares_max_drawdown_minor', 'Drawdown limit that halts the swarm.', 'gauge', [
      `ares_max_drawdown_minor ${metricNum(this.cfg.budget.maxDrawdownMinor)}`,
    ]);
    push('ares_ledger_entries', 'Entries in the append-only ledger.', 'gauge', [
      `ares_ledger_entries ${metricNum(this.deps.ledger.size())}`,
    ]);

    const balLines: string[] = [];
    const balances = this.deps.ledger.balances();
    for (const k of Object.keys(balances).sort()) {
      balLines.push(`ares_account_balance_minor{account="${lbl(k)}"} ${metricNum((balances as unknown as Record<string, number>)[k])}`);
    }
    push('ares_account_balance_minor', 'Double-entry account balances in minor units.', 'gauge', balLines);

    const netLines: string[] = [];
    const statusLines: string[] = [];
    const crashLines: string[] = [];
    for (const a of agents) {
      const l = `agent="${lbl(a.id)}",role="${lbl(a.role)}",strategy="${lbl(a.strategyId)}"`;
      netLines.push(`ares_agent_net_minor{${l}} ${metricNum(a.netMinor)}`);
      statusLines.push(`ares_agent_status{${l},status="${lbl(a.status)}",verdict="${lbl(a.verdict)}"} 1`);
      crashLines.push(`ares_agent_crashes{${l}} ${metricNum(a.crashes)}`);
    }
    push('ares_agent_net_minor', 'Realised net cash flow per agent, in minor units.', 'gauge', netLines);
    push('ares_agent_status', 'One per agent, labelled with its status and last survival verdict.', 'gauge', statusLines);
    push('ares_agent_crashes', 'Crashes recorded per agent.', 'gauge', crashLines);

    push('ares_bus_published_total', 'Messages published on the bus.', 'counter', [
      `ares_bus_published_total ${metricNum(bus.published)}`,
    ]);
    push('ares_bus_delivered_total', 'Message deliveries to handlers.', 'counter', [
      `ares_bus_delivered_total ${metricNum(bus.delivered)}`,
    ]);
    push('ares_bus_handler_errors_total', 'Handler exceptions caught by the bus.', 'counter', [
      `ares_bus_handler_errors_total ${metricNum(bus.handlerErrors)}`,
    ]);
    push('ares_bus_queue_depth', 'Messages waiting in the bus queue.', 'gauge', [
      `ares_bus_queue_depth ${metricNum(bus.depth)}`,
    ]);
    const dropLines: string[] = [`ares_bus_dropped_total{reason="any"} ${metricNum(bus.dropped)}`];
    for (const r of Object.keys(bus.dropReasons).sort()) {
      dropLines.push(`ares_bus_dropped_total{reason="${lbl(r)}"} ${metricNum(bus.dropReasons[r])}`);
    }
    push('ares_bus_dropped_total', 'Messages dropped by the bus, by reason.', 'counter', dropLines);

    const pol = this.deps.policy.stats();
    push('ares_policy_allowed_total', 'Policy decisions that allowed an action.', 'counter', [
      `ares_policy_allowed_total ${metricNum(pol.allowed)}`,
    ]);
    push('ares_policy_denied_total', 'Policy decisions that denied an action.', 'counter', [
      `ares_policy_denied_total ${metricNum(pol.denied)}`,
    ]);
    const byRule = this.denialsByRule();
    const ruleLines = Object.keys(byRule)
      .sort()
      .map((r) => `ares_policy_denials_by_rule{rule="${lbl(r)}"} ${metricNum(byRule[r])}`);
    push(
      'ares_policy_denials_by_rule',
      'Denials per rule within the retained decision ring (bounded, so not a lifetime total).',
      'gauge',
      ruleLines.length > 0 ? ruleLines : ['ares_policy_denials_by_rule{rule="none"} 0'],
    );

    const circuitLines = this.circuitLines();
    push(
      'ares_circuit_state',
      'One per circuit breaker, labelled with its current state.',
      'gauge',
      circuitLines.length > 0 ? circuitLines : ['ares_circuit_state{circuit="none",state="closed"} 0'],
    );

    push('ares_channels', 'Channels that passed the policy gate and are in use.', 'gauge', [
      `ares_channels ${metricNum(this.deps.channels.size)}`,
    ]);

    return out.join('\n') + '\n';
  }

  /**
   * Circuit-breaker states, read from whichever agents keep breakers.
   *
   * ScoutAgent owns its CircuitBreakers privately and exposes no accessor, so
   * there is no typed path to them; this reads the field structurally and
   * ignores anything that does not look like a breaker. It is strictly
   * read-only and cannot affect a breaker's behaviour. (Reported upstream: the
   * scout should expose a `breakerStats()` view.)
   */
  private circuitLines(): string[] {
    const lines: string[] = [];
    for (const agent of this.deps.registry.all()) {
      const probe = agent as unknown as { breakers?: unknown };
      const breakers = probe.breakers;
      if (!(breakers instanceof Map)) continue;
      for (const value of breakers.values()) {
        const b = value as { name?: unknown; state?: unknown };
        if (typeof b.name !== 'string' || typeof b.state !== 'string') continue;
        lines.push(`ares_circuit_state{circuit="${lbl(b.name)}",agent="${lbl(agent.id)}",state="${lbl(b.state)}"} 1`);
      }
    }
    return lines;
  }

  // ------------------------------------------------------------ responses --

  private baseHeaders(res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    // No Access-Control-Allow-* headers anywhere, by design: this is a local
    // control surface and no other origin has any business scripting it.
  }

  private json(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
    this.baseHeaders(res);
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const payload = JSON.stringify(body);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(payload));
    res.writeHead(status);
    if ((req.method ?? 'GET').toUpperCase() === 'HEAD') res.end();
    else res.end(payload);
  }

  private text(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: string): void {
    this.baseHeaders(res);
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.writeHead(status);
    if ((req.method ?? 'GET').toUpperCase() === 'HEAD') res.end();
    else res.end(body);
  }

  private dashboard(req: IncomingMessage, res: ServerResponse): void {
    // A fresh nonce per response. The only thing it authorises is the single
    // <style> block; the script is same-origin and needs no exemption at all.
    const nonce = randomBytes(16).toString('base64');
    const html = renderDashboardHtml(nonce);
    this.baseHeaders(res);
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; " +
        "script-src 'self'; " +
        `style-src 'nonce-${nonce}'; ` +
        "connect-src 'self'; " +
        "img-src 'none'; font-src 'none'; object-src 'none'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(html));
    res.writeHead(200);
    if ((req.method ?? 'GET').toUpperCase() === 'HEAD') res.end();
    else res.end(html);
  }

  private script(req: IncomingMessage, res: ServerResponse): void {
    this.text(req, res, 200, 'application/javascript; charset=utf-8', DASHBOARD_JS);
  }

  stats(): { requests: number; haltRequests: number; authFailures: number; listening: boolean; port: number } {
    return {
      requests: this.requests,
      haltRequests: this.haltRequests,
      authFailures: this.authFailures,
      listening: this.listening,
      port: this.boundPort,
    };
  }
}
