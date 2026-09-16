/**
 * bus/bus.ts — in-process typed message bus with backpressure and a loop guard.
 * Invariants: a handler throwing NEVER escapes the bus (caught + counted); every
 * drop is attributed to a reason in stats(); hops = causation.hops + 1 and
 * anything over cfg.limits.maxHops is dropped; repeat detection is measured in
 * TICKS, not messages. Callers: every agent, runtime/supervisor, api.
 */

import type { AresConfig } from '../core/config.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { AgentId } from '../core/types.js';
import { canonicalJson, sha256hex } from '../core/hash.js';
import { newId } from '../core/ids.js';
import type { Envelope, MsgType } from './protocol.js';

export type Handler = (e: Envelope) => void | Promise<void>;

export interface PublishInput<T = unknown> {
  type: MsgType;
  from: AgentId | 'system';
  to?: AgentId | '*';
  tick: number;
  payload: T;
  traceId?: string;
  causationId?: string | null;
  /** Parent envelope; sets hops, traceId and causationId automatically. */
  causation?: Envelope | null;
}

export type DropReason = 'max_hops' | 'queue_full' | 'loop_guard' | 'closed';

export interface BusStats {
  published: number;
  dropped: number;
  dropReasons: Record<string, number>;
  depth: number;
  delivered: number;
  handlerErrors: number;
}

export interface LoopSuspect {
  key: string;
  from: AgentId | 'system';
  type: MsgType;
  count: number;
  firstTick: number;
  lastTick: number;
  drops: number;
}

interface Subscription {
  agentId: AgentId;
  types: Set<MsgType>;
  handler: Handler;
  active: boolean;
}

interface Occurrence {
  tick: number;
  key: string;
}

/** Hard ceiling on dispatches inside one drain(), so a publish-loop cannot hang the tick. */
const MAX_DISPATCHES_PER_DRAIN = 100_000;

export class Bus {
  private readonly subs = new Set<Subscription>();
  private readonly queue: Envelope[] = [];
  private readonly occurrences: Occurrence[] = [];
  private readonly suspects = new Map<string, LoopSuspect>();
  private published = 0;
  private dropped = 0;
  private delivered = 0;
  private handlerErrors = 0;
  private readonly dropReasons: Record<string, number> = {};
  private draining = false;
  private closed = false;

  constructor(
    private readonly cfg: AresConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  subscribe(agentId: AgentId, types: MsgType[], handler: Handler): () => void {
    const sub: Subscription = { agentId, types: new Set(types), handler, active: true };
    this.subs.add(sub);
    return () => {
      sub.active = false;
      this.subs.delete(sub);
    };
  }

  /**
   * Build and enqueue an envelope. Always returns the envelope it built, even
   * when the message was dropped — inspect stats()/loopSuspects() for drops.
   */
  publish<T>(input: PublishInput<T>): Envelope<T> {
    const causation = input.causation ?? null;
    const hops = causation ? causation.hops + 1 : 0;
    const env: Envelope<T> = {
      id: newId('msg'),
      type: input.type,
      from: input.from,
      to: input.to ?? '*',
      tick: input.tick,
      ts: this.clock.now(),
      traceId: input.traceId ?? causation?.traceId ?? newId('trace'),
      causationId: input.causationId ?? causation?.id ?? null,
      hops,
      payload: input.payload,
    };

    if (this.closed) {
      this.drop(env, 'closed');
      return env;
    }
    if (hops > this.cfg.limits.maxHops) {
      this.drop(env, 'max_hops');
      return env;
    }
    if (this.queue.length >= this.cfg.limits.maxQueueDepth) {
      this.drop(env, 'queue_full');
      return env;
    }
    if (this.loopGuard(env)) {
      this.drop(env, 'loop_guard');
      this.emitPolicyDenied(env);
      return env;
    }

    this.queue.push(env as Envelope);
    this.published++;
    return env;
  }

  /**
   * Returns true when this message must be dropped: the same
   * (from, type, payload) has already been seen `repeatThreshold` times within
   * the trailing window of `repeatWindow` TICKS. Records the occurrence otherwise.
   */
  private loopGuard(env: Envelope): boolean {
    const key = this.repeatKey(env);
    if (key === null) return false;
    const window = this.cfg.limits.repeatWindow;
    const cutoff = env.tick - window + 1;
    // Prune occurrences that fell out of the trailing tick window.
    let keep = 0;
    for (let i = 0; i < this.occurrences.length; i++) {
      const o = this.occurrences[i];
      if (o !== undefined && o.tick >= cutoff && o.tick <= env.tick) {
        this.occurrences[keep++] = o;
      }
    }
    this.occurrences.length = keep;

    let count = 0;
    for (const o of this.occurrences) if (o.key === key) count++;

    if (count >= this.cfg.limits.repeatThreshold) {
      const s = this.suspects.get(key);
      if (s) {
        s.count = count + 1;
        s.lastTick = env.tick;
        s.drops++;
      } else {
        this.suspects.set(key, {
          key,
          from: env.from,
          type: env.type,
          count: count + 1,
          firstTick: env.tick,
          lastTick: env.tick,
          drops: 1,
        });
      }
      return true;
    }
    this.occurrences.push({ tick: env.tick, key });
    return false;
  }

  private repeatKey(env: Envelope): string | null {
    try {
      return sha256hex(`${env.from}:${env.type}:${canonicalJson(env.payload)}`);
    } catch (err) {
      // Unserialisable payload (cycle/bigint): cannot loop-guard it, but the
      // bus must not blow up. Log once per occurrence and let it through.
      this.logger.warn('bus.loop_guard_unhashable', {
        type: env.type,
        from: env.from,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Emitted when the loop guard fires. Enqueued directly (bypassing publish) so
   * that the notice itself can never be loop-guarded into a recursive storm.
   */
  private emitPolicyDenied(offender: Envelope): void {
    if (this.queue.length >= this.cfg.limits.maxQueueDepth) return;
    const notice: Envelope = {
      id: newId('msg'),
      type: 'POLICY_DENIED',
      from: 'system',
      to: offender.from === 'system' ? '*' : offender.from,
      tick: offender.tick,
      ts: this.clock.now(),
      traceId: offender.traceId,
      causationId: offender.id,
      hops: 0,
      payload: {
        reason: 'loop_guard',
        offendingType: offender.type,
        offendingFrom: offender.from,
        repeatWindow: this.cfg.limits.repeatWindow,
        repeatThreshold: this.cfg.limits.repeatThreshold,
      },
    };
    this.queue.push(notice);
    this.published++;
  }

  private drop(env: Envelope, reason: DropReason): void {
    this.dropped++;
    this.dropReasons[reason] = (this.dropReasons[reason] ?? 0) + 1;
    this.logger.warn('bus.dropped', {
      reason,
      type: env.type,
      from: env.from,
      to: env.to,
      tick: env.tick,
      hops: env.hops,
      id: env.id,
    });
  }

  /** Drains the queue, including anything handlers publish while draining. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let dispatches = 0;
      while (this.queue.length > 0) {
        if (dispatches >= MAX_DISPATCHES_PER_DRAIN) {
          this.logger.error('bus.drain_ceiling', { ceiling: MAX_DISPATCHES_PER_DRAIN, remaining: this.queue.length });
          break;
        }
        const env = this.queue.shift();
        if (env === undefined) break;
        dispatches++;
        for (const sub of Array.from(this.subs)) {
          if (!sub.active) continue;
          if (env.to !== '*' && env.to !== sub.agentId) continue;
          if (!sub.types.has(env.type)) continue;
          try {
            const r = sub.handler(env);
            if (r instanceof Promise) await r;
            this.delivered++;
          } catch (err) {
            this.handlerErrors++;
            this.dropReasons['handler_error'] = (this.dropReasons['handler_error'] ?? 0) + 1;
            this.logger.error('bus.handler_error', {
              subscriber: sub.agentId,
              type: env.type,
              id: env.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  stats(): BusStats {
    return {
      published: this.published,
      dropped: this.dropped,
      dropReasons: { ...this.dropReasons },
      depth: this.queue.length,
      delivered: this.delivered,
      handlerErrors: this.handlerErrors,
    };
  }

  loopSuspects(): LoopSuspect[] {
    return Array.from(this.suspects.values()).map((s) => ({ ...s }));
  }

  depth(): number {
    return this.queue.length;
  }

  /** Stop accepting new messages (shutdown). Already-queued messages still drain. */
  close(): void {
    this.closed = true;
  }
}
