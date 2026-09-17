/**
 * governance/survival.ts — the operator's zero-tolerance termination rule, with
 * two deliberate guards: a grace period (graceWindows) and a statistical floor
 * (minSamples). They exist because a strategy with genuinely positive expected
 * value but noisy returns will, with high probability, show a losing first
 * window; terminating on that early variance does not select for profitable
 * strategies, it selects for lucky ones, and it quietly bakes survivorship bias
 * into the policy. Until an agent is out of grace AND has produced enough
 * samples to say anything at all, its verdict is IMMATURE and it CANNOT be
 * terminated. Setting ARES_GRACE_WINDOWS=0 and ARES_MIN_SAMPLES=0 removes both
 * guards and restores the literal zero-tolerance behaviour.
 *
 * WHAT THE VERDICT IS TAKEN ON (amendment A1). The judged number is
 * `judgedNetMinor`: the sum of the REALISED StrategyOutcome.netMinor values the
 * agent recorded inside the window. It is NOT ledger.netCashFlow(). Cash flow
 * per agentId scores cash TIMING by role, not performance: a buyer's cash leg is
 * negative on every purchase and a seller's is positive on every sale, and the
 * seller never bears the cash cost of goods, so a profitable buyer is condemned
 * and a loss-making seller is rewarded. That is not a subtle mis-weighting, it
 * inverts the rule. netCashFlow survives here as `cashFlowMinor`, REPORTED and
 * never judged, because the dashboard and the audit trail still want it.
 *
 * `cashFlowMinor` covers ledger ticks [w*T, w*T+T-1] of the CURRENT RUN'S tick
 * numbering. Ticks restart at 0 on every boot while the ledger persists, so on a
 * restarted process that range can also match entries written by an earlier run.
 * That is exactly why it is not the judged number; treat it as a display figure.
 *
 * IDLE IS NOT A PASS (amendment A1b). A window in which the agent recorded NO
 * outcomes is UNJUDGED: it neither passes nor fails, it does not clear an
 * existing probation streak and it cannot terminate anybody. Before this, an
 * idle window netted 0, cleared a benchmark of 0 and PASSED — which made the
 * cheapest way to survive "stop trading", the exact inverse of the intent. Only
 * windows with real recorded activity are judged.
 *
 * probationWindows maps to a termination threshold on the CONSECUTIVE-failing-
 * mature-window streak as follows:
 *     probationWindows = 0  ->  TERMINATE on the 1st failing mature window
 *                               (the operator's literal rule; PROBATION is
 *                               never issued because there is no warning step)
 *     probationWindows = 1  ->  PROBATION on the 1st, TERMINATE on the 2nd
 *     probationWindows = n  ->  PROBATION on failures 1..n, TERMINATE on n+1
 * i.e. the streak that is fatal is `max(1, probationWindows + 1)` for n >= 1
 * and exactly 1 for n = 0. IMMATURE immunity is unaffected by this mapping: a
 * cold-start agent is never terminated whatever probationWindows says.
 *
 * DURABILITY (amendment A4). The rows are also written through a fact store
 * (the swarm's shared task memory, attached by the Treasury) and rehydrated on
 * boot, so graceWindows and minSamples cannot re-arm on every restart and a
 * probation streak cannot be laundered by bouncing the process. What persists is
 * the DURABLE part of a row — elapsed windows, lifetime samples/successes and
 * the fail streak. Per-window realised sums and decided verdicts are keyed on
 * this run's tick numbering and are deliberately NOT carried across runs.
 *
 * Invariants: IMMATURE and UNJUDGED are never terminal; evaluate() decides any
 * GIVEN window at most once — the decisions are held in a bounded map, not a
 * single scalar, so re-evaluating an earlier window cannot count it twice; a
 * passing window resets the probation streak; an UNJUDGED window leaves it
 * alone. Callers: treasury agent, api, registry (on respawn).
 */

import type { AresConfig } from '../core/config.js';
import type { Ledger } from '../core/ledger.js';
import { nullLogger, type Logger } from '../core/logger.js';
import type { Minor } from '../core/money.js';
import type { AgentId, StrategyOutcome } from '../core/types.js';

export type Verdict = 'PASS' | 'PROBATION' | 'TERMINATE' | 'IMMATURE' | 'UNJUDGED';

export interface SurvivalAssessment {
  verdict: Verdict;
  /** THE judged number: realised outcomes recorded inside the window. */
  judgedNetMinor: Minor;
  /** Reported, never judged: ledger cash movement in the window (this run). */
  cashFlowMinor: Minor;
  /** Realised outcomes recorded inside the judged window. 0 => UNJUDGED. */
  windowSamples: number;
  /** Lifetime sample count, across every window (and every persisted run). */
  samples: number;
  windows: number;
  reason: string;
}

export interface SurvivalState {
  agentId: AgentId;
  firstWindow: number | null;
  lastWindow: number | null;
  windows: number;
  samples: number;
  successes: number;
  failStreak: number;
  verdict: Verdict | null;
}

/** Outcomes kept per agent for inspection; the sample COUNT is not capped. */
export const OUTCOME_RING = 200;

/** Decided windows remembered per agent. Bounded: this is a cache, not a log. */
export const DECIDED_WINDOW_CAP = 64;

/** Per-window realised sums kept per agent. Bounded for the same reason. */
export const WINDOW_NET_CAP = 64;

/** Fact key the rows are persisted under in the shared task memory. */
export const SURVIVAL_FACT_KEY = 'survival.rows';

/** The minimum a fact store must do for the evaluator to persist through it. */
export interface SurvivalFactStore {
  getFact<T>(k: string, d: T): T;
  setFact(k: string, v: unknown): void;
  flush(): void;
}

/** The durable part of a row: everything that must outlive the process. */
export interface PersistedSurvivalRow {
  runId: string;
  /** Windows elapsed for this agent across every run, as of the last write. */
  windowsSeen: number;
  samples: number;
  successes: number;
  failStreak: number;
}

interface Decision {
  verdict: Verdict;
  reason: string;
}

interface Row {
  firstWindow: number | null;
  lastWindow: number | null;
  /** Windows counted in PREVIOUS runs; this run's windows are added to it. */
  priorWindows: number;
  samples: number;
  successes: number;
  failStreak: number;
  decided: Map<number, Decision>;
  lastDecidedWindow: number | null;
  recent: StrategyOutcome[];
  /** window -> realised net and count, for THIS run's tick numbering. */
  windowNet: Map<number, { net: Minor; count: number }>;
}

export class SurvivalEvaluator {
  private readonly rows = new Map<AgentId, Row>();
  private store: SurvivalFactStore | null = null;
  private runId = 'run:unattached';

  constructor(
    private readonly cfg: AresConfig,
    private readonly ledger: Ledger,
    private readonly logger: Logger = nullLogger,
  ) {}

  // ------------------------------------------------------------ durability --

  /**
   * Wire the evaluator to a fact store and rehydrate whatever a previous run
   * left behind. Called once, by the Treasury, with the SHARED task memory:
   * survival history belongs to the swarm, not to an agent's private scope that
   * dies with it. `runId` identifies this boot; rows written by this same run
   * are already in memory and are not re-read.
   */
  attachMemory(store: SurvivalFactStore, runId: string): void {
    if (store === null || typeof store.getFact !== 'function') {
      throw new TypeError('SurvivalEvaluator.attachMemory: a fact store is required');
    }
    this.store = store;
    this.runId = typeof runId === 'string' && runId.length > 0 ? runId : 'run:unnamed';
    let saved: Record<string, PersistedSurvivalRow> = {};
    try {
      saved = store.getFact<Record<string, PersistedSurvivalRow>>(SURVIVAL_FACT_KEY, {}) ?? {};
    } catch (err) {
      this.logger.error('survival.rehydrate_failed', { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let restored = 0;
    for (const [agentId, p] of Object.entries(saved)) {
      if (p === null || typeof p !== 'object') continue;
      if (p.runId === this.runId) continue; // our own write: already in memory
      const r = this.row(agentId);
      r.priorWindows = safeCount(p.windowsSeen);
      r.samples = safeCount(p.samples);
      r.successes = safeCount(p.successes);
      r.failStreak = safeCount(p.failStreak);
      restored++;
    }
    this.logger.warn('survival.rehydrated', { runId: this.runId, agents: restored });
  }

  private persist(): void {
    const store = this.store;
    if (store === null) return;
    try {
      const out: Record<string, PersistedSurvivalRow> = {};
      for (const [agentId, r] of this.rows) {
        out[agentId] = {
          runId: this.runId,
          windowsSeen: r.priorWindows + this.windowsThisRun(r),
          samples: r.samples,
          successes: r.successes,
          failStreak: r.failStreak,
        };
      }
      store.setFact(SURVIVAL_FACT_KEY, out);
      store.flush();
    } catch (err) {
      this.logger.error('survival.persist_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private windowsThisRun(r: Row): number {
    if (r.firstWindow === null || r.lastWindow === null) return 0;
    return Math.max(0, r.lastWindow - r.firstWindow + 1);
  }

  /**
   * Windows elapsed AS OF window `w` — not as of the newest window the row has
   * seen. The grace guard asks "how much life had this agent had by the window
   * being judged?", and an outcome recorded later must not retroactively age the
   * window it is being judged in.
   */
  private windowsAsOf(r: Row, w: number): number {
    if (r.firstWindow === null) return r.priorWindows;
    return r.priorWindows + Math.max(0, w - r.firstWindow + 1);
  }

  // ------------------------------------------------------------------ rows --

  private row(agentId: AgentId): Row {
    let r = this.rows.get(agentId);
    if (r === undefined) {
      r = {
        firstWindow: null,
        lastWindow: null,
        priorWindows: 0,
        samples: 0,
        successes: 0,
        failStreak: 0,
        decided: new Map<number, Decision>(),
        lastDecidedWindow: null,
        recent: [],
        windowNet: new Map<number, { net: Minor; count: number }>(),
      };
      this.rows.set(agentId, r);
    }
    return r;
  }

  private windowOf(tick: number): number {
    const t = Number.isSafeInteger(tick) && tick > 0 ? tick : 0;
    return Math.floor(t / this.cfg.survival.windowTicks);
  }

  private touchWindow(r: Row, w: number): void {
    if (r.firstWindow === null) r.firstWindow = w;
    r.lastWindow = r.lastWindow === null ? w : Math.max(r.lastWindow, w);
  }

  /** Record one strategy result. Sample counts are lifetime, not per window. */
  record(o: StrategyOutcome): void {
    if (o === null || typeof o !== 'object' || typeof o.agentId !== 'string' || o.agentId.length === 0) {
      throw new TypeError('SurvivalEvaluator.record: outcome needs an agentId');
    }
    const r = this.row(o.agentId);
    const w = this.windowOf(o.tick);
    this.touchWindow(r, w);
    r.samples++;
    if (o.success) r.successes++;
    // THE judged aggregate. record() used to keep netMinor only in the ring and
    // throw it away at evaluation time; this is what the verdict is taken on.
    const net = Number.isFinite(o.netMinor) ? Math.trunc(o.netMinor) : 0;
    const agg = r.windowNet.get(w) ?? { net: 0, count: 0 };
    agg.net += net;
    agg.count += 1;
    r.windowNet.set(w, agg);
    evictOldest(r.windowNet, WINDOW_NET_CAP);
    r.recent.push(o);
    while (r.recent.length > OUTCOME_RING) r.recent.shift();
  }

  /**
   * Judge the window containing `tick`, i.e. [w*T, w*T+T-1]. A given window is
   * decided EXACTLY ONCE: later calls for a window already decided — whether it
   * is the current one or an earlier one being revisited — report live figures
   * but return the stored verdict and leave the probation streak untouched.
   */
  evaluate(agentId: AgentId, tick: number): SurvivalAssessment {
    const s = this.cfg.survival;
    const r = this.row(agentId);
    const w = this.windowOf(tick);
    this.touchWindow(r, w);
    const windows = this.windowsAsOf(r, w);
    const from = w * s.windowTicks;
    const to = from + s.windowTicks - 1;
    const cashFlowMinor = this.ledger.netCashFlow(from, to, agentId);
    const agg = r.windowNet.get(w) ?? { net: 0, count: 0 };
    const judgedNetMinor = agg.net;
    const windowSamples = agg.count;
    const samples = r.samples;

    const prior = r.decided.get(w);
    if (prior !== undefined) {
      return {
        verdict: prior.verdict,
        judgedNetMinor,
        cashFlowMinor,
        windowSamples,
        samples,
        windows,
        reason: prior.reason,
      };
    }

    let verdict: Verdict;
    let reason: string;

    if (windows <= s.graceWindows || samples < s.minSamples) {
      // Cold start: not enough time or not enough evidence. Immune.
      verdict = 'IMMATURE';
      reason =
        `immature: ${windows} window(s) of grace ${s.graceWindows}, ` +
        `${samples} sample(s) of minimum ${s.minSamples} — too early to judge, termination withheld`;
    } else if (windowSamples === 0) {
      // Nothing happened. An idle window is NOT a pass: it says nothing about
      // the strategy, so it neither clears the streak nor adds to it.
      verdict = 'UNJUDGED';
      reason =
        `unjudged: no realised outcome was recorded in window ${w} (ticks ${from}-${to}), ` +
        `so there is nothing to judge — an idle window is not a pass and does not ` +
        `clear a probation streak (currently ${r.failStreak})`;
    } else if (judgedNetMinor >= s.minNetMinor) {
      r.failStreak = 0;
      verdict = 'PASS';
      reason =
        `realised net ${judgedNetMinor} over ${windowSamples} outcome(s) met the benchmark ` +
        `${s.minNetMinor} in window ${w} (ticks ${from}-${to})`;
    } else {
      r.failStreak++;
      // probationWindows = 0 is the literal zero-tolerance rule: the FIRST
      // failing mature window is fatal, with no warning step. For n >= 1 the
      // first failure is a warning and n FURTHER consecutive failures are fatal
      // (default 1 => fail twice in a row). See the mapping in the file header.
      const fatalStreak = s.probationWindows <= 0 ? 1 : s.probationWindows + 1;
      if (r.failStreak >= fatalStreak) {
        verdict = 'TERMINATE';
        reason = `realised net ${judgedNetMinor} over ${windowSamples} outcome(s) below benchmark ${s.minNetMinor} for ${r.failStreak} consecutive mature window(s), the fatal streak being ${fatalStreak} (probationWindows=${s.probationWindows})`;
      } else {
        verdict = 'PROBATION';
        reason = `realised net ${judgedNetMinor} over ${windowSamples} outcome(s) below benchmark ${s.minNetMinor} in window ${w} (ticks ${from}-${to}); first failure, on probation`;
      }
    }

    r.decided.set(w, { verdict, reason });
    evictOldest(r.decided, DECIDED_WINDOW_CAP);
    r.lastDecidedWindow = r.lastDecidedWindow === null ? w : Math.max(r.lastDecidedWindow, w);
    this.logger.info('survival.evaluated', {
      agentId,
      tick,
      window: w,
      verdict,
      judgedNetMinor,
      cashFlowMinor,
      windowSamples,
      samples,
      windows,
    });
    this.persist();
    return { verdict, judgedNetMinor, cashFlowMinor, windowSamples, samples, windows, reason };
  }

  /** Wipe one agent's history — used when the id is respawned with a new brain. */
  reset(agentId: AgentId): void {
    this.rows.delete(agentId);
    this.persist();
    this.logger.info('survival.reset', { agentId });
  }

  /** Observability: no decisions are made here. */
  state(agentId: AgentId): SurvivalState | null {
    const r = this.rows.get(agentId);
    if (r === undefined) return null;
    const last = r.lastDecidedWindow;
    return {
      agentId,
      firstWindow: r.firstWindow,
      lastWindow: last,
      windows: r.priorWindows + this.windowsThisRun(r),
      samples: r.samples,
      successes: r.successes,
      failStreak: r.failStreak,
      verdict: last === null ? null : (r.decided.get(last)?.verdict ?? null),
    };
  }

  /** The realised net and outcome count recorded in one window. */
  windowNet(agentId: AgentId, window: number): { net: Minor; count: number } {
    const agg = this.rows.get(agentId)?.windowNet.get(window);
    return agg === undefined ? { net: 0, count: 0 } : { ...agg };
  }

  /** Most recent recorded outcomes for an agent (bounded ring). */
  outcomes(agentId: AgentId, limit?: number): StrategyOutcome[] {
    const r = this.rows.get(agentId);
    if (r === undefined) return [];
    const all = [...r.recent];
    if (limit === undefined || limit < 0 || limit >= all.length) return all;
    return all.slice(all.length - limit);
  }

  agents(): AgentId[] {
    return [...this.rows.keys()];
  }
}

/** Keep a keyed cache bounded by dropping the lowest (oldest) keys first. */
function evictOldest<V>(m: Map<number, V>, cap: number): void {
  while (m.size > cap) {
    let oldest: number | null = null;
    for (const k of m.keys()) if (oldest === null || k < oldest) oldest = k;
    if (oldest === null) return;
    m.delete(oldest);
  }
}

function safeCount(n: unknown): number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
