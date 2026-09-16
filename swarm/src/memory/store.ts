/**
 * memory/store.ts — the agent's durable memory: facts, episodes, running stats
 * and postmortems, one JSON file per scope under `${dataDir}/memory/`.
 * Invariants: every collection is BOUNDED (a 24/7 process must not grow without
 * limit); persistence is crash-safe (tmp + fsync + rename, never a torn file);
 * a corrupt file is quarantined, never fatal; scopes can never escape the dir.
 * Callers: agents/base.ts (per-agent + shared 'task' memory), runtime, treasury.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AresError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { Minor } from '../core/money.js';

/** One thing that happened, with its realised cash effect. */
export interface EpisodicRecord {
  tick: number;
  kind: string;
  net: Minor;
  success: boolean;
  meta: Record<string, unknown>;
}

/** What `stat()` hands back. `m2` stays internal (Welford scratch). */
export interface StatView {
  n: number;
  mean: number;
  ewma: number;
  last: number;
}

interface StatState extends StatView {
  /** Welford's sum of squared deviations — persisted so variance survives reload. */
  m2: number;
}

/** A terminated agent's last words; read by the next generation. */
export interface PostmortemRecord {
  seq: number;
  text: string;
  meta: Record<string, unknown>;
}

export interface MemorySnapshot {
  version: number;
  scope: string;
  facts: Record<string, unknown>;
  episodes: EpisodicRecord[];
  stats: Record<string, StatState>;
  postmortems: PostmortemRecord[];
  postmortemSeq: number;
}

/** Ring-buffer capacity for episodic memory. */
export const EPISODE_CAP = 500;
/** Bounded postmortem list; newest kept. */
export const POSTMORTEM_CAP = 50;
/**
 * EWMA smoothing factor. alpha = 0.2 ⇒ an effective window of ~9 samples
 * (2/alpha - 1), i.e. recent ticks dominate but a single outlier cannot.
 */
export const EWMA_ALPHA = 0.2;
/** On-disk schema version; bumped only on a breaking layout change. */
export const MEMORY_VERSION = 1;
export const MEMORY_DIR = 'memory';

const MAX_SCOPE_LEN = 128;

/**
 * Maps a scope onto a single filesystem-safe path segment, or throws.
 * REJECTS (never "cleans up") anything that could leave the memory directory:
 * empty, path separators, NUL, '..', a leading dot, or an over-long name.
 * Everything else is narrowed to [A-Za-z0-9._-].
 */
export function safeScopeName(scope: string): string {
  const bad = (why: string): never => {
    throw new AresError('INVALID_SCOPE', `MemoryStore: unsafe scope ${JSON.stringify(scope)} (${why})`, { scope, why });
  };
  if (typeof scope !== 'string') bad('not a string');
  if (scope.length === 0) bad('empty');
  if (scope.length > MAX_SCOPE_LEN) bad('too long');
  if (scope.includes('\0')) bad('NUL byte');
  if (scope.includes('/') || scope.includes('\\')) bad('path separator');
  if (scope.includes('..')) bad('parent traversal');
  if (scope.startsWith('.')) bad('leading dot');
  if (/^[a-zA-Z]:/.test(scope)) bad('drive-qualified path');
  const safe = scope.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe.length === 0 || safe === '.' || safe === '..') bad('degenerate after sanitisation');
  return safe;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEpisode(v: unknown): v is EpisodicRecord {
  if (!isRecord(v)) return false;
  return (
    typeof v['tick'] === 'number' &&
    typeof v['kind'] === 'string' &&
    typeof v['net'] === 'number' &&
    typeof v['success'] === 'boolean' &&
    isRecord(v['meta'])
  );
}

function isStat(v: unknown): v is StatState {
  if (!isRecord(v)) return false;
  for (const k of ['n', 'mean', 'ewma', 'last', 'm2']) {
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k] as number)) return false;
  }
  return true;
}

function isPostmortem(v: unknown): v is PostmortemRecord {
  return isRecord(v) && typeof v['seq'] === 'number' && typeof v['text'] === 'string' && isRecord(v['meta']);
}

function emptySnapshot(scope: string): MemorySnapshot {
  return {
    version: MEMORY_VERSION,
    scope,
    facts: {},
    episodes: [],
    stats: {},
    postmortems: [],
    postmortemSeq: 0,
  };
}

/** Deep, JSON-only copy. Anything non-serialisable is dropped, as on disk. */
function plainCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class MemoryStore {
  readonly scope: string;
  readonly file: string;
  private readonly tmpFile: string;
  private readonly dir: string;
  private readonly logger: Logger;
  private state: MemorySnapshot;
  private dirtyFlag = false;
  private flushes = 0;

  private constructor(dir: string, scope: string, safe: string, logger: Logger, state: MemorySnapshot) {
    this.dir = dir;
    this.scope = scope;
    this.file = join(dir, `${safe}.json`);
    this.tmpFile = `${this.file}.tmp`;
    this.logger = logger;
    this.state = state;
  }

  /**
   * Opens (or creates) the scope's file. A corrupt/unparseable file is renamed
   * aside as `<file>.corrupt.<stamp>` and memory starts empty — a bad file on
   * disk must never stop the swarm from booting.
   */
  static open(dataDir: string, scope: string, logger: Logger): MemoryStore {
    const safe = safeScopeName(scope);
    const dir = join(dataDir, MEMORY_DIR);
    mkdirSync(dir, { recursive: true });
    const log = logger.child({ mod: 'memory', scope });
    const file = join(dir, `${safe}.json`);

    let state = emptySnapshot(scope);
    if (existsSync(file)) {
      try {
        state = MemoryStore.parse(readFileSync(file, 'utf8'), scope);
      } catch (err) {
        const moved = quarantine(file);
        log.warn('memory file corrupt; quarantined and starting empty', {
          file,
          movedTo: moved,
          error: (err as Error).message,
        });
        state = emptySnapshot(scope);
      }
    }
    // A leftover .tmp means a crash BEFORE the rename: the target file is the
    // authoritative one, so the stray partial write is simply discarded.
    const tmp = `${file}.tmp`;
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
        log.warn('discarded stale memory tmp file from an interrupted write', { file: tmp });
      } catch {
        /* best effort: the next flush overwrites it anyway */
      }
    }
    return new MemoryStore(dir, scope, safe, log, state);
  }

  private static parse(raw: string, scope: string): MemorySnapshot {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new AresError('MEMORY_CORRUPT', 'memory root is not an object');
    const episodesRaw = parsed['episodes'];
    const postRaw = parsed['postmortems'];
    const statsRaw = parsed['stats'];
    const factsRaw = parsed['facts'];
    if (!Array.isArray(episodesRaw) || !Array.isArray(postRaw) || !isRecord(statsRaw) || !isRecord(factsRaw)) {
      throw new AresError('MEMORY_CORRUPT', 'memory file is missing required sections');
    }
    const out = emptySnapshot(scope);
    out.facts = plainCopy(factsRaw);
    out.episodes = episodesRaw.filter(isEpisode).slice(-EPISODE_CAP);
    for (const [k, v] of Object.entries(statsRaw)) if (isStat(v)) out.stats[k] = { ...v };
    out.postmortems = postRaw.filter(isPostmortem).slice(-POSTMORTEM_CAP);
    const seq = parsed['postmortemSeq'];
    const lastSeq = out.postmortems.length > 0 ? (out.postmortems[out.postmortems.length - 1] as PostmortemRecord).seq : 0;
    out.postmortemSeq = typeof seq === 'number' && Number.isFinite(seq) ? Math.max(seq, lastSeq) : lastSeq;
    return out;
  }

  // ---------------------------------------------------------------- episodes

  /** Append an episode. Ring buffer: the oldest is dropped past EPISODE_CAP. */
  remember(r: EpisodicRecord): void {
    if (!isEpisode(r)) {
      throw new AresError('INVALID_EPISODE', 'MemoryStore.remember: malformed EpisodicRecord', { record: r });
    }
    this.state.episodes.push({ tick: r.tick, kind: r.kind, net: r.net, success: r.success, meta: plainCopy(r.meta) });
    while (this.state.episodes.length > EPISODE_CAP) this.state.episodes.shift();
    this.dirtyFlag = true;
  }

  /** Most-recent-first, optionally filtered by kind and capped by limit. */
  recall(kind?: string, limit?: number): EpisodicRecord[] {
    const out: EpisodicRecord[] = [];
    const cap = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(limit));
    for (let i = this.state.episodes.length - 1; i >= 0 && out.length < cap; i--) {
      const e = this.state.episodes[i] as EpisodicRecord;
      if (kind === undefined || e.kind === kind) out.push(plainCopy(e));
    }
    return out;
  }

  /** How many episodes are currently held (<= EPISODE_CAP). */
  size(): number {
    return this.state.episodes.length;
  }

  // ------------------------------------------------------------------- facts

  setFact(k: string, v: unknown): void {
    if (typeof k !== 'string' || k.length === 0) {
      throw new AresError('INVALID_FACT_KEY', 'MemoryStore.setFact: key must be a non-empty string', { key: k });
    }
    // Stored as plain JSON so what is read back always matches what reloads.
    this.state.facts[k] = v === undefined ? null : plainCopy(v);
    this.dirtyFlag = true;
  }

  getFact<T>(k: string, d: T): T {
    const v = this.state.facts[k];
    if (v === undefined || v === null) return d;
    // Justified cast: facts are schemaless by contract; the caller names the type.
    return v as T;
  }

  hasFact(k: string): boolean {
    return this.state.facts[k] !== undefined;
  }

  // ------------------------------------------------------------------- stats

  /** Welford mean (numerically stable) + EWMA over `EWMA_ALPHA`. */
  observe(key: string, value: number): void {
    if (typeof key !== 'string' || key.length === 0) {
      throw new AresError('INVALID_STAT_KEY', 'MemoryStore.observe: key must be a non-empty string', { key });
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AresError('INVALID_OBSERVATION', `MemoryStore.observe: value must be finite, got ${String(value)}`, {
        key,
        value,
      });
    }
    const cur = this.state.stats[key];
    if (cur === undefined) {
      this.state.stats[key] = { n: 1, mean: value, m2: 0, ewma: value, last: value };
    } else {
      const n = cur.n + 1;
      const delta = value - cur.mean;
      const mean = cur.mean + delta / n;
      cur.m2 += delta * (value - mean);
      cur.mean = mean;
      cur.n = n;
      cur.ewma = EWMA_ALPHA * value + (1 - EWMA_ALPHA) * cur.ewma;
      cur.last = value;
    }
    this.dirtyFlag = true;
  }

  /** null for a key never observed — callers must branch, not divide by zero. */
  stat(key: string): StatView | null {
    const s = this.state.stats[key];
    if (s === undefined) return null;
    return { n: s.n, mean: s.mean, ewma: s.ewma, last: s.last };
  }

  /** Sample variance (n-1). null when there are fewer than two samples. */
  variance(key: string): number | null {
    const s = this.state.stats[key];
    if (s === undefined || s.n < 2) return null;
    return s.m2 / (s.n - 1);
  }

  // ------------------------------------------------------------- postmortems

  postmortem(text: string, meta: Record<string, unknown>): void {
    if (typeof text !== 'string' || text.length === 0) {
      throw new AresError('INVALID_POSTMORTEM', 'MemoryStore.postmortem: text must be a non-empty string', { text });
    }
    this.state.postmortemSeq += 1;
    this.state.postmortems.push({
      seq: this.state.postmortemSeq,
      text,
      meta: isRecord(meta) ? plainCopy(meta) : {},
    });
    while (this.state.postmortems.length > POSTMORTEM_CAP) this.state.postmortems.shift();
    this.dirtyFlag = true;
  }

  /** Most-recent-first. */
  postmortems(limit?: number): PostmortemRecord[] {
    const cap = limit === undefined ? this.state.postmortems.length : Math.max(0, Math.floor(limit));
    return this.state.postmortems.slice(-cap).reverse().map((p) => plainCopy(p));
  }

  // -------------------------------------------------------------- persistence

  /** True when there are unflushed mutations. */
  get dirty(): boolean {
    return this.dirtyFlag;
  }

  /** Number of real disk writes performed — debounce is observable in tests. */
  get flushCount(): number {
    return this.flushes;
  }

  /**
   * Crash-safe write: full contents to `<file>.tmp`, fsync, then rename over the
   * target (atomic on POSIX). A crash leaves either the old file or the new one.
   * No-op when nothing changed, so repeated setFact calls cost zero fsyncs.
   */
  flush(): void {
    if (!this.dirtyFlag) return;
    const data = JSON.stringify(this.state);
    const fd = openSync(this.tmpFile, 'w');
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(this.tmpFile, this.file);
    // Durable rename: fsync the directory too. Not supported everywhere, so
    // failures here are non-fatal — the data file itself is already fsync'd.
    try {
      const dfd = openSync(this.dir, 'r');
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      /* best effort */
    }
    this.flushes += 1;
    this.dirtyFlag = false;
  }

  /** Plain, JSON-serialisable snapshot of everything held. */
  export(): MemorySnapshot {
    return plainCopy(this.state);
  }
}

/**
 * Renames a bad file aside. The suffix comes from the file's own mtime (NOT
 * Date.now() — wall time belongs to core/clock.ts) with a collision counter.
 */
function quarantine(file: string): string {
  let stamp = 0;
  try {
    stamp = Math.trunc(statSync(file).mtimeMs);
  } catch {
    stamp = 0;
  }
  let target = `${file}.corrupt.${stamp}`;
  let i = 1;
  while (existsSync(target)) target = `${file}.corrupt.${stamp}.${i++}`;
  try {
    renameSync(file, target);
    return target;
  } catch {
    return file;
  }
}
