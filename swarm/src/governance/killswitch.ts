/**
 * governance/killswitch.ts — the one-way latch that stops the swarm.
 * Invariants: trip() is monotonic (first reason wins, callbacks fire exactly
 * once each, a throwing callback can neither unlatch it nor starve its peers);
 * the latch NEVER clears in-process; watchFile() polls `${dataDir}/HALT`
 * through the injected Clock only. Callers: budget, policy, agents, supervisor.
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Clock } from '../core/clock.js';
import { nullLogger, type Logger } from '../core/logger.js';
import { HaltedError } from '../core/errors.js';

/** Name of the file whose mere presence halts the swarm. */
export const HALT_FILE = 'HALT';
/** Default poll cadence for watchFile(); override per call in tests. */
export const DEFAULT_WATCH_INTERVAL_MS = 1_000;

export type TripCallback = (reason: string) => void;

export interface KillSwitchSnapshot {
  tripped: boolean;
  reason: string | null;
  trippedAt: number | null;
  meta: Record<string, unknown> | null;
  listeners: number;
  watchers: number;
}

/** Absolute path of the halt file for a data directory. */
export function haltFilePath(dataDir: string): string {
  return basename(dataDir) === HALT_FILE ? dataDir : join(dataDir, HALT_FILE);
}

export class KillSwitch {
  private latched = false;
  private latchReason: string | null = null;
  private latchMeta: Record<string, unknown> | null = null;
  private latchedAt: number | null = null;
  private readonly callbacks: TripCallback[] = [];
  private watchers = 0;

  constructor(
    private readonly logger: Logger = nullLogger,
    private readonly clock?: Clock,
  ) {}

  get tripped(): boolean {
    return this.latched;
  }

  get reason(): string | null {
    return this.latchReason;
  }

  get trippedAt(): number | null {
    return this.latchedAt;
  }

  get meta(): Record<string, unknown> | null {
    return this.latchMeta;
  }

  /**
   * Latch the swarm shut. The FIRST reason is the one that is kept; later trips
   * are recorded as noise and fire nothing. Never throws.
   */
  trip(reason: string, meta?: Record<string, unknown>): void {
    const why = typeof reason === 'string' && reason.length > 0 ? reason : 'unspecified';
    if (this.latched) {
      this.logger.warn('killswitch.trip_ignored', { alreadyTrippedFor: this.latchReason, ignoredReason: why });
      return;
    }
    this.latched = true;
    this.latchReason = why;
    this.latchMeta = meta ?? null;
    this.latchedAt = this.clock ? this.clock.now() : null;
    this.logger.error('killswitch.tripped', { reason: why, meta: meta ?? {} });
    // Snapshot: a callback that registers another callback must not mutate the
    // list we are walking (the new one fires immediately in onTrip instead).
    for (const cb of [...this.callbacks]) this.fire(cb, why);
  }

  /** Throws HaltedError once latched. The universal "may I act?" gate. */
  assertLive(): void {
    if (this.latched) {
      throw new HaltedError('HALTED', `ARES is halted: ${this.latchReason ?? 'unspecified'}`, {
        reason: this.latchReason,
        trippedAt: this.latchedAt,
      });
    }
  }

  /**
   * Register a trip listener. If the switch is ALREADY tripped the callback
   * fires immediately (synchronously) — late subscribers must never miss the
   * halt. Returns an unsubscribe function (callers may ignore it).
   */
  onTrip(cb: TripCallback): () => void {
    if (typeof cb !== 'function') throw new TypeError('KillSwitch.onTrip: callback must be a function');
    if (this.latched) {
      this.fire(cb, this.latchReason ?? 'unspecified');
      return () => {};
    }
    this.callbacks.push(cb);
    return () => {
      const i = this.callbacks.indexOf(cb);
      if (i >= 0) this.callbacks.splice(i, 1);
    };
  }

  /** A listener that throws is logged and skipped; the latch stays latched. */
  private fire(cb: TripCallback, reason: string): void {
    try {
      cb(reason);
    } catch (err) {
      this.logger.error('killswitch.callback_failed', {
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Poll for the halt file. `path` may be the data directory (the watcher then
   * looks for `${path}/HALT`) or the halt file itself. The first check is
   * synchronous; subsequent checks are driven by clock.sleep(intervalMs), so a
   * TestClock makes this fully deterministic. Returns a stop() function — the
   * loop also stops by itself once the switch is tripped, so the process can
   * always exit.
   */
  watchFile(path: string, clock: Clock, opts: { intervalMs?: number } = {}): () => void {
    const file = haltFilePath(path);
    const intervalMs =
      opts.intervalMs !== undefined && Number.isFinite(opts.intervalMs) && opts.intervalMs > 0
        ? opts.intervalMs
        : DEFAULT_WATCH_INTERVAL_MS;
    let stopped = false;
    this.watchers++;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      this.watchers--;
    };

    void (async () => {
      try {
        while (!stopped && !this.latched) {
          let present = false;
          try {
            present = existsSync(file);
          } catch (err) {
            // An unreadable data dir is an operational problem, not a halt.
            this.logger.warn('killswitch.watch_stat_failed', {
              file,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          if (present) {
            this.trip(`halt file present: ${file}`, { file });
            break;
          }
          await clock.sleep(intervalMs);
        }
      } finally {
        stop();
      }
    })();

    return stop;
  }

  snapshot(): KillSwitchSnapshot {
    return {
      tripped: this.latched,
      reason: this.latchReason,
      trippedAt: this.latchedAt,
      meta: this.latchMeta,
      listeners: this.callbacks.length,
      watchers: this.watchers,
    };
  }
}
