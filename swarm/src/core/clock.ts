/**
 * core/clock.ts — the ONLY place allowed to read wall time.
 * Invariant: no other module calls Date.now() or setTimeout directly, so every
 * tick, ledger timestamp and backoff is injectable and therefore testable.
 * Callers: ledger, bus, governance, agents, runtime, tests (via TestClock).
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      // Do not keep the event loop alive purely for a sleep.
      if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref(): void }).unref();
    });
  }
}

export const systemClock: Clock = new SystemClock();

interface Waiter {
  due: number;
  resolve: () => void;
}

/**
 * Deterministic manual clock. `sleep()` only settles when `advance()` (or
 * `setTime()`) moves virtual time past the waiter's deadline.
 */
export class TestClock implements Clock {
  private t: number;
  private waiters: Waiter[] = [];

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
    const due = this.t + ms;
    return new Promise<void>((resolve) => {
      this.waiters.push({ due, resolve });
    });
  }

  /** Move time forward and release every waiter whose deadline has passed. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`TestClock.advance: bad ms ${String(ms)}`);
    this.setTime(this.t + ms);
  }

  /** Absolute jump. Never moves backwards. */
  setTime(ms: number): void {
    if (ms < this.t) throw new RangeError('TestClock.setTime: time cannot move backwards');
    this.t = ms;
    const due: Waiter[] = [];
    const still: Waiter[] = [];
    for (const w of this.waiters) (w.due <= this.t ? due : still).push(w);
    this.waiters = still;
    for (const w of due) w.resolve();
  }

  /** Number of sleepers still parked. */
  get pending(): number {
    return this.waiters.length;
  }

  /** Release everything regardless of deadline (teardown helper). */
  releaseAll(): void {
    const all = this.waiters;
    this.waiters = [];
    for (const w of all) w.resolve();
  }
}
