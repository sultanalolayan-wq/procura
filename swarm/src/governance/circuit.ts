/**
 * governance/circuit.ts — failure containment for external calls.
 * Invariants: an OPEN circuit refuses WITHOUT invoking the wrapped function;
 * the cooldown is measured on the injected Clock only; HALF_OPEN admits at most
 * halfOpenMax concurrent trials, one success closes and resets, one failure
 * reopens and restarts the FULL cooldown. RateLimiter is a continuously
 * refilling token bucket, not a fixed window. Callers: agents, adapters.
 */

import { AdapterError, AresError } from '../core/errors.js';
import type { Clock } from '../core/clock.js';
import { nullLogger, type Logger } from '../core/logger.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitOptions {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMax: number;
}

export interface CircuitStats {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  failures: number;
  successes: number;
  rejected: number;
  opens: number;
  halfOpenInFlight: number;
  openedAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}

export class CircuitBreaker {
  private st: CircuitState = 'closed';
  private consecutive = 0;
  private failures = 0;
  private successes = 0;
  private rejected = 0;
  private opens = 0;
  private inFlight = 0;
  private openedAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastError: string | null = null;

  constructor(
    public readonly name: string,
    private readonly opts: CircuitOptions,
    private readonly clock: Clock,
    private readonly logger: Logger = nullLogger,
  ) {
    if (!Number.isInteger(opts.failureThreshold) || opts.failureThreshold < 1) {
      throw new AresError('CIRCUIT_BAD_OPTIONS', `CircuitBreaker(${name}): failureThreshold must be >= 1`, { opts });
    }
    if (!Number.isFinite(opts.cooldownMs) || opts.cooldownMs < 0) {
      throw new AresError('CIRCUIT_BAD_OPTIONS', `CircuitBreaker(${name}): cooldownMs must be >= 0`, { opts });
    }
    if (!Number.isInteger(opts.halfOpenMax) || opts.halfOpenMax < 1) {
      throw new AresError('CIRCUIT_BAD_OPTIONS', `CircuitBreaker(${name}): halfOpenMax must be >= 1`, { opts });
    }
  }

  /** Reading the state also performs the time-driven open -> half_open move. */
  get state(): CircuitState {
    return this.refresh();
  }

  private refresh(): CircuitState {
    if (this.st === 'open' && this.openedAt !== null && this.clock.now() - this.openedAt >= this.opts.cooldownMs) {
      this.st = 'half_open';
      this.inFlight = 0;
      this.logger.info('circuit.half_open', { name: this.name, cooldownMs: this.opts.cooldownMs });
    }
    return this.st;
  }

  /**
   * Run `fn` under the breaker. Throws AdapterError (without touching `fn`)
   * while open or while the half-open trial slots are full; otherwise the
   * original error of a failing `fn` is rethrown untouched.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.refresh();
    if (state === 'open') {
      this.rejected++;
      const waited = this.openedAt === null ? 0 : this.clock.now() - this.openedAt;
      throw new AdapterError('CIRCUIT_OPEN', `circuit ${this.name} is open (${waited}ms of ${this.opts.cooldownMs}ms cooldown elapsed)`, {
        name: this.name,
        state,
        cooldownMs: this.opts.cooldownMs,
        waitedMs: waited,
        lastError: this.lastError,
      });
    }
    if (state === 'half_open' && this.inFlight >= this.opts.halfOpenMax) {
      this.rejected++;
      throw new AdapterError('CIRCUIT_HALF_OPEN_BUSY', `circuit ${this.name} is half-open and its ${this.opts.halfOpenMax} trial slot(s) are in use`, {
        name: this.name,
        state,
        halfOpenMax: this.opts.halfOpenMax,
        inFlight: this.inFlight,
      });
    }
    const trial = state === 'half_open';
    if (trial) this.inFlight++;
    try {
      const out = await fn();
      this.onSuccess(trial);
      return out;
    } catch (err) {
      this.onFailure(trial, err);
      throw err;
    }
  }

  private onSuccess(trial: boolean): void {
    this.successes++;
    if (trial) {
      this.inFlight = Math.max(0, this.inFlight - 1);
      // Only a trial that is still the half-open probe may close the circuit:
      // if a sibling probe already failed and reopened us, this late success
      // must NOT undo that decision.
      if (this.st === 'half_open') {
        this.st = 'closed';
        this.openedAt = null;
        this.consecutive = 0;
        this.logger.info('circuit.closed', { name: this.name });
      }
      return;
    }
    this.consecutive = 0;
  }

  private onFailure(trial: boolean, err: unknown): void {
    this.failures++;
    this.lastFailureAt = this.clock.now();
    this.lastError = err instanceof Error ? err.message : String(err);
    if (trial) {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.trip('half_open_probe_failed');
      return;
    }
    this.consecutive++;
    if (this.consecutive >= this.opts.failureThreshold) this.trip('failure_threshold');
  }

  private trip(why: string): void {
    this.st = 'open';
    this.openedAt = this.clock.now();
    this.inFlight = 0;
    this.opens++;
    this.logger.warn('circuit.open', {
      name: this.name,
      why,
      consecutiveFailures: this.consecutive,
      cooldownMs: this.opts.cooldownMs,
      lastError: this.lastError,
    });
  }

  /** Manual close (operator action / test helper). Counters are kept. */
  reset(): void {
    this.st = 'closed';
    this.consecutive = 0;
    this.inFlight = 0;
    this.openedAt = null;
  }

  stats(): CircuitStats {
    return {
      name: this.name,
      state: this.refresh(),
      consecutiveFailures: this.consecutive,
      failures: this.failures,
      successes: this.successes,
      rejected: this.rejected,
      opens: this.opens,
      halfOpenInFlight: this.inFlight,
      openedAt: this.openedAt,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
    };
  }
}

/**
 * Continuously-refilling token bucket. Capacity = perMinute, refill rate =
 * perMinute/60000 per millisecond, so a burst is allowed but the long-run rate
 * can never exceed perMinute. No fixed windows: there is no edge to game.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private takenCount = 0;
  private refusedCount = 0;

  constructor(
    private readonly perMinute: number,
    private readonly clock: Clock,
  ) {
    if (!Number.isFinite(perMinute) || perMinute <= 0) {
      throw new AresError('RATE_BAD_OPTIONS', `RateLimiter: perMinute must be > 0, got ${String(perMinute)}`, {
        perMinute,
      });
    }
    this.tokens = perMinute;
    this.last = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const dt = now - this.last;
    if (dt <= 0) {
      // Clock did not move (or moved backwards): never mint tokens.
      this.last = now;
      return;
    }
    this.last = now;
    this.tokens = Math.min(this.perMinute, this.tokens + (dt * this.perMinute) / 60_000);
  }

  tryTake(n = 1): boolean {
    if (!Number.isFinite(n) || n <= 0) {
      throw new AresError('RATE_BAD_TAKE', `RateLimiter.tryTake: n must be > 0, got ${String(n)}`, { n });
    }
    this.refill();
    if (this.tokens + 1e-9 < n) {
      this.refusedCount++;
      return false;
    }
    this.tokens -= n;
    this.takenCount++;
    return true;
  }

  /** Tokens currently in the bucket (after refilling to `now`). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  stats(): { perMinute: number; tokens: number; taken: number; refused: number } {
    return { perMinute: this.perMinute, tokens: this.available(), taken: this.takenCount, refused: this.refusedCount };
  }
}
