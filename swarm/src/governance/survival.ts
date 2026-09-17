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
 * Invariants: IMMATURE is never terminal; evaluate() decides a given window at
 * most once (keyed on floor(tick/windowTicks)) so repeated calls inside a
 * window cannot double-count toward termination; a passing window resets the
 * probation streak. Callers: treasury agent, api, registry (on respawn).
 */

import type { AresConfig } from '../core/config.js';
import type { Ledger } from '../core/ledger.js';
import { nullLogger, type Logger } from '../core/logger.js';
import type { Minor } from '../core/money.js';
import type { AgentId, StrategyOutcome } from '../core/types.js';

export type Verdict = 'PASS' | 'PROBATION' | 'TERMINATE' | 'IMMATURE';

export interface SurvivalAssessment {
  verdict: Verdict;
  netMinor: Minor;
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

interface Row {
  firstWindow: number | null;
  samples: number;
  successes: number;
  failStreak: number;
  decidedWindow: number | null;
  decidedVerdict: Verdict | null;
  decidedReason: string;
  recent: StrategyOutcome[];
}

export class SurvivalEvaluator {
  private readonly rows = new Map<AgentId, Row>();

  constructor(
    private readonly cfg: AresConfig,
    private readonly ledger: Ledger,
    private readonly logger: Logger = nullLogger,
  ) {}

  private row(agentId: AgentId): Row {
    let r = this.rows.get(agentId);
    if (r === undefined) {
      r = {
        firstWindow: null,
        samples: 0,
        successes: 0,
        failStreak: 0,
        decidedWindow: null,
        decidedVerdict: null,
        decidedReason: '',
        recent: [],
      };
      this.rows.set(agentId, r);
    }
    return r;
  }

  private windowOf(tick: number): number {
    const t = Number.isSafeInteger(tick) && tick > 0 ? tick : 0;
    return Math.floor(t / this.cfg.survival.windowTicks);
  }

  /** Record one strategy result. Sample counts are lifetime, not per window. */
  record(o: StrategyOutcome): void {
    if (o === null || typeof o !== 'object' || typeof o.agentId !== 'string' || o.agentId.length === 0) {
      throw new TypeError('SurvivalEvaluator.record: outcome needs an agentId');
    }
    const r = this.row(o.agentId);
    const w = this.windowOf(o.tick);
    if (r.firstWindow === null) r.firstWindow = w;
    r.samples++;
    if (o.success) r.successes++;
    r.recent.push(o);
    while (r.recent.length > OUTCOME_RING) r.recent.shift();
  }

  /**
   * Judge the agent's CURRENT window [w*T, w*T+T-1]. The first call in a window
   * decides that window; later calls in the same window report live net/samples
   * but return the same verdict and leave the probation streak untouched.
   */
  evaluate(agentId: AgentId, tick: number): SurvivalAssessment {
    const s = this.cfg.survival;
    const r = this.row(agentId);
    const w = this.windowOf(tick);
    if (r.firstWindow === null) r.firstWindow = w;
    const windows = w - r.firstWindow + 1;
    const from = w * s.windowTicks;
    const to = from + s.windowTicks - 1;
    const netMinor = this.ledger.netCashFlow(from, to, agentId);
    const samples = r.samples;

    if (r.decidedWindow === w && r.decidedVerdict !== null) {
      return { verdict: r.decidedVerdict, netMinor, samples, windows, reason: r.decidedReason };
    }

    let verdict: Verdict;
    let reason: string;

    if (windows <= s.graceWindows || samples < s.minSamples) {
      // Cold start: not enough time or not enough evidence. Immune.
      verdict = 'IMMATURE';
      reason =
        `immature: ${windows} window(s) of grace ${s.graceWindows}, ` +
        `${samples} sample(s) of minimum ${s.minSamples} — too early to judge, termination withheld`;
    } else if (netMinor >= s.minNetMinor) {
      r.failStreak = 0;
      verdict = 'PASS';
      reason = `net ${netMinor} met the benchmark ${s.minNetMinor} over window ${w} (ticks ${from}-${to})`;
    } else {
      r.failStreak++;
      // probationWindows = 0 is the literal zero-tolerance rule: the FIRST
      // failing mature window is fatal, with no warning step. For n >= 1 the
      // first failure is a warning and n FURTHER consecutive failures are fatal
      // (default 1 => fail twice in a row). See the mapping in the file header.
      const fatalStreak = s.probationWindows <= 0 ? 1 : s.probationWindows + 1;
      if (r.failStreak >= fatalStreak) {
        verdict = 'TERMINATE';
        reason = `net ${netMinor} below benchmark ${s.minNetMinor} for ${r.failStreak} consecutive mature window(s), the fatal streak being ${fatalStreak} (probationWindows=${s.probationWindows})`;
      } else {
        verdict = 'PROBATION';
        reason = `net ${netMinor} below benchmark ${s.minNetMinor} in window ${w} (ticks ${from}-${to}); first failure, on probation`;
      }
    }

    r.decidedWindow = w;
    r.decidedVerdict = verdict;
    r.decidedReason = reason;
    this.logger.info('survival.evaluated', { agentId, tick, window: w, verdict, netMinor, samples, windows });
    return { verdict, netMinor, samples, windows, reason };
  }

  /** Wipe one agent's history — used when the id is respawned with a new brain. */
  reset(agentId: AgentId): void {
    this.rows.delete(agentId);
    this.logger.info('survival.reset', { agentId });
  }

  /** Observability: no decisions are made here. */
  state(agentId: AgentId): SurvivalState | null {
    const r = this.rows.get(agentId);
    if (r === undefined) return null;
    return {
      agentId,
      firstWindow: r.firstWindow,
      lastWindow: r.decidedWindow,
      windows: r.firstWindow === null || r.decidedWindow === null ? 0 : r.decidedWindow - r.firstWindow + 1,
      samples: r.samples,
      successes: r.successes,
      failStreak: r.failStreak,
      verdict: r.decidedVerdict,
    };
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
