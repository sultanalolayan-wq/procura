/**
 * core/ledger.ts — append-only, hash-chained, double-entry ledger (JSONL on disk).
 * Invariants: legs of every entry sum to exactly 0; entry.hash covers all entry
 * fields INCLUDING prevHash (genesis prevHash = 64 zeros); seq is dense from 1;
 * a line is fsync'd to disk BEFORE in-memory state moves, so memory can never be
 * ahead of the file. open() replays + verifies. Callers: governance, agents, api.
 *
 * MEMORY: the DISK FILE is authoritative. Memory holds only a bounded TAIL of
 * recent entries plus O(1) running aggregates (balances, per-agent cash), so a
 * process that has been up for a month occupies the same heap as one that
 * booted a minute ago. replay() streams the file line by line — it never
 * materialises it as one string, which used to make Ledger.open() throw
 * permanently past V8's ~536MB string ceiling (~840k entries).
 *
 * VERIFY: verify() is INCREMENTAL — it re-hashes the retained tail only, which
 * is bounded, so its cost does not grow with the ledger. verify({full:true})
 * streams the whole file from disk and is what boot and shutdown use.
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { IntegrityError } from './errors.js';
import { canonicalJson, sha256hex } from './hash.js';
import { isCurrency, type Currency, type Minor } from './money.js';
import type { Clock } from './clock.js';
import type { Logger } from './logger.js';
import type { AgentId } from './types.js';

export type Account = 'cash' | 'inventory' | 'revenue' | 'cogs' | 'fees' | 'compute' | 'equity' | 'writeoff';

export const ACCOUNTS: readonly Account[] = [
  'cash',
  'inventory',
  'revenue',
  'cogs',
  'fees',
  'compute',
  'equity',
  'writeoff',
];

/**
 * Accounts whose balance is meaningless when negative. Cash below zero means
 * the swarm spent money it never had; inventory below zero means it sold an
 * asset it never held (which is exactly what a replayed-then-deduplicated buy
 * produces). Both are cross-entry conditions: every individual entry can still
 * balance to 0 while these go negative, so verify() cannot see them.
 */
export const NON_NEGATIVE_ACCOUNTS: readonly Account[] = Object.freeze(['cash', 'inventory']);

export interface Leg {
  account: Account;
  amount: Minor;
}

export interface LedgerEntry {
  seq: number;
  ts: number;
  tick: number;
  type: string;
  agentId: AgentId | 'system';
  currency: Currency;
  legs: Leg[];
  idempotencyKey: string;
  meta: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export type NewEntry = Omit<LedgerEntry, 'seq' | 'ts' | 'prevHash' | 'hash'>;

/**
 * What append() hands back. It IS a LedgerEntry (every existing call site keeps
 * working unchanged), plus one explicit flag: `deduplicated` is true when the
 * idempotencyKey already existed, nothing was written, and the entry returned
 * is the PRE-EXISTING one rather than the caller's.
 *
 * Silently returning the old entry is how inventory went negative: a replayed
 * buy really executed at the adapter, minted a real second holding, and then
 * the ledger swallowed the accounting for it — while the later sale relieved
 * cogs under a fresh key. A caller that cannot tell the two cases apart cannot
 * unwind the side effect it just caused.
 */
export type LedgerAppendResult = LedgerEntry & { deduplicated: boolean };

export interface InvariantViolation {
  account: Account;
  balanceMinor: Minor;
}

export interface InvariantReport {
  ok: boolean;
  violations: InvariantViolation[];
}

export interface VerifyResult {
  ok: boolean;
  brokenAtSeq?: number;
}

/** The last verdict verify() reached, so readers never have to recompute one. */
export interface VerificationRecord {
  ok: boolean;
  brokenAtSeq: number | null;
  /** Ledger size at the moment of the check. */
  atSeq: number;
  /** Clock time of the check. */
  at: number;
  /** True when the check streamed the whole file rather than the retained tail. */
  full: boolean;
  /** Lowest seq the check actually re-hashed (1 for a full verify). */
  fromSeq: number;
}

export const GENESIS_HASH = '0'.repeat(64);
export const LEDGER_FILE = 'ledger.jsonl';
/** Sidecar recording how far the chain has been proven against disk. */
export const LEDGER_WATERMARK_FILE = 'ledger.verified.json';

/** Entries kept in memory. Must stay >= the API's largest page (1000). */
export const DEFAULT_TAIL_CAP = 2_000;
/** Idempotency keys older than this (on the injected clock) are forgotten. */
export const DEFAULT_KEY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/** Hard ceiling on retained idempotency keys, whatever their age. */
export const DEFAULT_KEY_CAP = 20_000;
/** Bytes read per syscall while streaming the file. */
const REPLAY_CHUNK_BYTES = 1 << 20;

/**
 * Entry types whose idempotency key must NEVER be forgotten, because the key is
 * deterministic and the entry is once-per-lifetime. Ageing out the opening
 * balance key would let budget.bootstrap() book a SECOND opening balance on the
 * next restart and silently double the swarm's equity.
 */
export const PINNED_KEY_TYPES: ReadonlySet<string> = new Set(['OPENING_BALANCE']);

export interface LedgerOptions {
  /** Entries retained in memory. Default DEFAULT_TAIL_CAP. */
  tailCap?: number;
  /** Idempotency key retention window in clock-ms. Default one week. */
  keyRetentionMs?: number;
  /** Maximum retained idempotency keys. Default DEFAULT_KEY_CAP. */
  keyCap?: number;
}

function isAccount(a: unknown): a is Account {
  return typeof a === 'string' && (ACCOUNTS as readonly string[]).includes(a);
}

/** The exact preimage of an entry's hash. Order is irrelevant (canonicalJson sorts). */
export function entryHash(e: Omit<LedgerEntry, 'hash'>): string {
  return sha256hex(
    canonicalJson({
      seq: e.seq,
      ts: e.ts,
      tick: e.tick,
      type: e.type,
      agentId: e.agentId,
      currency: e.currency,
      legs: e.legs,
      idempotencyKey: e.idempotencyKey,
      meta: e.meta,
      prevHash: e.prevHash,
    }),
  );
}

export function sumLegs(legs: Leg[]): number {
  let s = 0;
  for (const l of legs) s += l.amount;
  return s;
}

export class Ledger {
  /**
   * The retained TAIL, oldest first. Bounded by tailCap. Named `rows` because
   * that is what it has always been called; what changed is that it is no
   * longer the whole ledger.
   */
  private readonly rows: LedgerEntry[] = [];
  private readonly byKey = new Map<string, LedgerEntry>();
  private readonly pinnedKeys = new Set<string>();
  private lastHash = GENESIS_HASH;
  private fd: number | null = null;
  private closed = false;

  private readonly tailCap: number;
  private readonly keyRetentionMs: number;
  private readonly keyCap: number;

  /** Total entries ever written, whether or not they are still in memory. */
  private count = 0;
  /** prevHash of rows[0]; the anchor an incremental verify starts from. */
  private anchorPrevHash = GENESIS_HASH;
  /** Highest seq proven against disk. Entries below it may have been evicted. */
  private verifiedUpToSeq = 0;
  private lastVerdict: VerificationRecord | null = null;

  // ---- O(1) aggregates, maintained in append()/replay(), never rescanned ----
  private readonly balancesCache = {} as Record<Account, Minor>;
  private readonly cashByAgent = new Map<string, Minor>();
  private cashTotal: Minor = 0;
  private maxTick = 0;
  /** Lowest tick still represented in the retained tail (for ranged queries). */
  private minRetainedTick = 0;

  private constructor(
    public readonly path: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
    opts: LedgerOptions = {},
  ) {
    const cap = opts.tailCap;
    this.tailCap = Number.isFinite(cap) && (cap as number) > 0 ? Math.floor(cap as number) : DEFAULT_TAIL_CAP;
    const ret = opts.keyRetentionMs;
    this.keyRetentionMs = Number.isFinite(ret) && (ret as number) > 0 ? Math.floor(ret as number) : DEFAULT_KEY_RETENTION_MS;
    const kc = opts.keyCap;
    this.keyCap = Number.isFinite(kc) && (kc as number) > 0 ? Math.floor(kc as number) : DEFAULT_KEY_CAP;
    for (const a of ACCOUNTS) this.balancesCache[a] = 0;
  }

  /** Replay the whole file (streaming, verifying as it goes), then open the append fd. */
  static open(dataDir: string, clock: Clock, logger: Logger, opts: LedgerOptions = {}): Ledger {
    const dir = resolvePath(dataDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, LEDGER_FILE);
    const led = new Ledger(path, clock, logger, opts);
    // replay() verifies every line as it reads it, so the chain is proven in a
    // SINGLE pass instead of one pass to load and a second to re-hash.
    led.replay();
    led.verifiedUpToSeq = led.count;
    led.lastVerdict = {
      ok: true,
      brokenAtSeq: null,
      atSeq: led.count,
      at: clock.now(),
      full: true,
      fromSeq: 1,
    };
    led.writeWatermark();
    led.fd = openSync(path, 'a');
    logger.info('ledger.opened', {
      path,
      entries: led.count,
      retained: led.rows.length,
      head: led.lastHash,
    });
    return led;
  }

  // -------------------------------------------------------------- replay --

  /**
   * Streams the file line by line. The whole point is that no single string
   * ever holds the whole ledger: readFileSync(path,'utf8') threw on EVERY boot
   * once the file passed V8's maximum string length, which made a long-lived
   * swarm permanently unopenable.
   */
  private replay(): void {
    if (!existsSync(this.path)) return;
    const fd = openSync(this.path, 'r');
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.allocUnsafe(REPLAY_CHUNK_BYTES);
    let carry = '';
    let expectedSeq = 1;
    let bytes = 0;
    try {
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        bytes += n;
        carry += decoder.write(buf.subarray(0, n));
        let nl = carry.indexOf('\n');
        while (nl >= 0) {
          const line = carry.slice(0, nl);
          carry = carry.slice(nl + 1);
          this.replayLine(line, expectedSeq);
          expectedSeq += 1;
          nl = carry.indexOf('\n');
        }
      }
      carry += decoder.end();
    } finally {
      closeSync(fd);
    }
    if (bytes === 0) return;
    // A complete file ends with '\n'. Anything left over is a torn write.
    if (carry !== '') {
      throw new IntegrityError(
        'LEDGER_TRUNCATED',
        `Ledger ${this.path} ends with a partial line (expected seq ${expectedSeq}); ` +
          `the process died mid-append. Refusing to open.`,
        { path: this.path, expectedSeq, partial: carry.slice(0, 200) },
      );
    }
  }

  private replayLine(line: string, expectedSeq: number): void {
    if (line.trim() === '') {
      throw new IntegrityError('LEDGER_BLANK_LINE', `Ledger ${this.path}: blank line at seq ${expectedSeq}`, {
        path: this.path,
        brokenAtSeq: expectedSeq,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new IntegrityError(
        'LEDGER_MALFORMED_LINE',
        `Ledger ${this.path}: line for seq ${expectedSeq} is not valid JSON`,
        { path: this.path, brokenAtSeq: expectedSeq, error: (err as Error).message },
      );
    }
    const e = this.coerce(parsed, expectedSeq);
    // Chain verification happens HERE, while the line is in hand.
    const broken = this.chainFault(e, expectedSeq, this.lastHash);
    if (broken !== null) {
      throw new IntegrityError(
        'LEDGER_CHAIN_BROKEN',
        `Ledger hash chain broken at seq ${String(broken)} in ${this.path}`,
        { path: this.path, brokenAtSeq: broken },
      );
    }
    this.admit(e);
  }

  /** Structural validation of a replayed row (hash checking happens separately). */
  private coerce(v: unknown, expectedSeq: number): LedgerEntry {
    const bad = (why: string): never => {
      throw new IntegrityError('LEDGER_MALFORMED_ENTRY', `Ledger ${this.path}: seq ${expectedSeq} ${why}`, {
        path: this.path,
        brokenAtSeq: expectedSeq,
      });
    };
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return bad('is not an object');
    const o = v as Record<string, unknown>;
    if (typeof o['seq'] !== 'number') return bad('has no numeric seq');
    if (typeof o['ts'] !== 'number') return bad('has no numeric ts');
    if (typeof o['tick'] !== 'number') return bad('has no numeric tick');
    if (typeof o['type'] !== 'string') return bad('has no string type');
    if (typeof o['agentId'] !== 'string') return bad('has no string agentId');
    if (!isCurrency(o['currency'])) return bad('has an unknown currency');
    if (!Array.isArray(o['legs'])) return bad('has no legs array');
    const legs: Leg[] = [];
    for (const l of o['legs'] as unknown[]) {
      if (l === null || typeof l !== 'object') return bad('has a malformed leg');
      const lr = l as Record<string, unknown>;
      if (!isAccount(lr['account'])) return bad(`has a leg with unknown account ${String(lr['account'])}`);
      if (!Number.isSafeInteger(lr['amount'])) return bad('has a leg with a non-integer amount');
      legs.push({ account: lr['account'], amount: lr['amount'] as number });
    }
    if (typeof o['idempotencyKey'] !== 'string') return bad('has no string idempotencyKey');
    const meta = o['meta'];
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return bad('has no meta object');
    if (typeof o['prevHash'] !== 'string' || o['prevHash'].length !== 64) return bad('has a malformed prevHash');
    if (typeof o['hash'] !== 'string' || o['hash'].length !== 64) return bad('has a malformed hash');
    return {
      seq: o['seq'] as number,
      ts: o['ts'] as number,
      tick: o['tick'] as number,
      type: o['type'] as string,
      agentId: o['agentId'] as string,
      currency: o['currency'],
      legs,
      idempotencyKey: o['idempotencyKey'] as string,
      meta: meta as Record<string, unknown>,
      prevHash: o['prevHash'] as string,
      hash: o['hash'] as string,
    };
  }

  /** Returns the broken seq, or null when the entry links correctly. */
  private chainFault(e: LedgerEntry, expectedSeq: number, prev: string): number | null {
    if (e.seq !== expectedSeq) return expectedSeq;
    if (e.prevHash !== prev) return e.seq;
    if (sumLegs(e.legs) !== 0) return e.seq;
    const { hash, ...rest } = e;
    if (entryHash(rest) !== hash) return e.seq;
    return null;
  }

  // ------------------------------------------------- in-memory bookkeeping --

  /** Fold one verified entry into memory: aggregates, tail, key index, head. */
  private admit(e: LedgerEntry): void {
    this.count += 1;
    for (const l of e.legs) {
      this.balancesCache[l.account] += l.amount;
      if (l.account === 'cash') {
        this.cashTotal += l.amount;
        this.cashByAgent.set(e.agentId, (this.cashByAgent.get(e.agentId) ?? 0) + l.amount);
      }
    }
    if (e.tick > this.maxTick) this.maxTick = e.tick;
    if (this.rows.length === 0) {
      this.anchorPrevHash = e.prevHash;
      this.minRetainedTick = e.tick;
    }
    this.rows.push(e);
    this.evictTail();
    if (e.idempotencyKey !== '' && !this.byKey.has(e.idempotencyKey)) {
      this.byKey.set(e.idempotencyKey, e);
      if (PINNED_KEY_TYPES.has(e.type)) this.pinnedKeys.add(e.idempotencyKey);
    }
    this.pruneKeys(e.ts);
    this.lastHash = e.hash;
  }

  /** Drop the oldest retained entries, moving the verified watermark with them. */
  private evictTail(): void {
    while (this.rows.length > this.tailCap) {
      const gone = this.rows.shift() as LedgerEntry;
      // It was verified when it was written or replayed, and it is no longer
      // in memory to be tampered with, so the watermark advances past it.
      if (gone.seq > this.verifiedUpToSeq) this.verifiedUpToSeq = gone.seq;
      const head = this.rows[0];
      this.anchorPrevHash = head === undefined ? gone.hash : head.prevHash;
      this.minRetainedTick = head === undefined ? gone.tick : head.tick;
    }
  }

  /**
   * Bound the idempotency index by AGE first, then by a hard count cap. Pinned
   * keys (see PINNED_KEY_TYPES) are never removed by either rule.
   */
  private pruneKeys(nowTs: number): void {
    const cutoff = nowTs - this.keyRetentionMs;
    // Map preserves insertion order, and entries are inserted in ts order, so
    // the oldest live at the front and this stops at the first live key.
    for (const [k, e] of this.byKey) {
      if (e.ts >= cutoff) break;
      if (this.pinnedKeys.has(k)) continue;
      this.byKey.delete(k);
    }
    if (this.byKey.size <= this.keyCap) return;
    for (const [k] of this.byKey) {
      if (this.byKey.size <= this.keyCap) break;
      if (this.pinnedKeys.has(k)) continue;
      this.byKey.delete(k);
    }
  }

  // -------------------------------------------------------------- append --

  /**
   * Append one balanced entry. A duplicate idempotencyKey returns the EXISTING
   * entry with `deduplicated: true`, writes nothing and does not advance seq.
   * Disk first, memory second.
   */
  append(e: NewEntry): LedgerAppendResult {
    if (this.closed || this.fd === null) {
      throw new IntegrityError('LEDGER_CLOSED', 'Ledger.append(): ledger is closed', { path: this.path });
    }
    if (typeof e.idempotencyKey !== 'string') {
      throw new IntegrityError('LEDGER_BAD_IDEMPOTENCY_KEY', 'Ledger.append(): idempotencyKey must be a string', {
        type: e.type,
      });
    }
    // An empty key means "no idempotency requested" and is never deduplicated.
    if (e.idempotencyKey !== '') {
      const existing = this.byKey.get(e.idempotencyKey);
      if (existing !== undefined) {
        this.logger.debug('ledger.duplicate_suppressed', { idempotencyKey: e.idempotencyKey, seq: existing.seq });
        return { ...existing, deduplicated: true };
      }
    }
    if (!isCurrency(e.currency)) {
      throw new IntegrityError('LEDGER_BAD_CURRENCY', `Ledger.append(): unknown currency ${String(e.currency)}`, {
        type: e.type,
      });
    }
    if (!Array.isArray(e.legs) || e.legs.length === 0) {
      throw new IntegrityError('LEDGER_NO_LEGS', `Ledger.append(): entry ${e.type} has no legs`, { type: e.type });
    }
    for (const l of e.legs) {
      if (!isAccount(l.account)) {
        throw new IntegrityError('LEDGER_BAD_ACCOUNT', `Ledger.append(): unknown account ${String(l.account)}`, {
          type: e.type,
        });
      }
      if (!Number.isSafeInteger(l.amount)) {
        throw new IntegrityError(
          'LEDGER_NON_INTEGER_LEG',
          `Ledger.append(): leg amount ${String(l.amount)} is not a safe integer`,
          { type: e.type, account: l.account },
        );
      }
    }
    const total = sumLegs(e.legs);
    if (total !== 0) {
      throw new IntegrityError(
        'LEDGER_UNBALANCED',
        `Ledger.append(): legs of ${e.type} sum to ${total}, must be 0 (double-entry)`,
        { type: e.type, sum: total, legs: e.legs },
      );
    }

    const seq = this.count + 1;
    const withoutHash: Omit<LedgerEntry, 'hash'> = {
      seq,
      ts: this.clock.now(),
      tick: e.tick,
      type: e.type,
      agentId: e.agentId,
      currency: e.currency,
      legs: e.legs.map((l) => ({ account: l.account, amount: l.amount })),
      idempotencyKey: e.idempotencyKey,
      meta: e.meta ?? {},
      prevHash: this.lastHash,
    };
    const entry: LedgerEntry = { ...withoutHash, hash: entryHash(withoutHash) };
    const line = JSON.stringify(entry) + '\n';

    // ---- DISK FIRST. If this throws, in-memory state is untouched. ----
    appendFileSync(this.fd, line, 'utf8');
    try {
      fsyncSync(this.fd);
    } catch {
      // fsync can legitimately fail on some filesystems; the append already
      // returned, so we continue rather than desync memory from disk.
    }

    this.admit(entry);
    return { ...entry, deduplicated: false };
  }

  has(idempotencyKey: string): boolean {
    return idempotencyKey !== '' && this.byKey.has(idempotencyKey);
  }

  get(idempotencyKey: string): LedgerEntry | undefined {
    return this.byKey.get(idempotencyKey);
  }

  // --------------------------------------------------------------- views --

  balances(): Record<Account, Minor> {
    const out = {} as Record<Account, Minor>;
    for (const a of ACCOUNTS) out[a] = this.balancesCache[a];
    return out;
  }

  balanceOf(a: Account): Minor {
    return this.balancesCache[a] ?? 0;
  }

  /**
   * Cross-account invariant the Treasury can call every tick: an asset account
   * must never be negative. verify() cannot catch this — every entry balances
   * to 0 individually even when the totals are nonsense.
   */
  invariants(): InvariantReport {
    const violations: InvariantViolation[] = [];
    for (const a of NON_NEGATIVE_ACCOUNTS) {
      const bal = this.balancesCache[a] ?? 0;
      if (bal < 0) violations.push({ account: a, balanceMinor: bal });
    }
    return { ok: violations.length === 0, violations };
  }

  /**
   * Net movement of the `cash` account over an inclusive tick range.
   *
   * The lifetime case — which is what the API and the Treasury ask for, once
   * PER AGENT — is answered from an incrementally maintained index in O(1).
   * A narrower range is answered from the retained tail; a range that starts
   * before the tail is warned about rather than silently under-reported.
   */
  netCashFlow(fromTick: number, toTick: number, agentId?: AgentId): Minor {
    if (fromTick <= 0 && toTick >= this.maxTick) {
      return agentId === undefined ? this.cashTotal : (this.cashByAgent.get(agentId) ?? 0);
    }
    if (this.count > this.rows.length && fromTick < this.minRetainedTick) {
      this.logger.warn('ledger.range_outside_retained_tail', {
        fromTick,
        toTick,
        earliestRetainedTick: this.minRetainedTick,
        retained: this.rows.length,
        entries: this.count,
      });
    }
    let s = 0;
    for (const e of this.rows) {
      if (e.tick < fromTick || e.tick > toTick) continue;
      if (agentId !== undefined && e.agentId !== agentId) continue;
      for (const l of e.legs) if (l.account === 'cash') s += l.amount;
    }
    return s;
  }

  /** Lifetime net cash for one agent, O(1). */
  agentCashTotal(agentId: AgentId | 'system'): Minor {
    return this.cashByAgent.get(agentId) ?? 0;
  }

  /**
   * Most recent matching entries, oldest first. Walks BACKWARDS from the newest
   * entry and stops at `limit`, so `?limit=1` costs one comparison instead of
   * materialising every row and slicing the end off it.
   */
  entries(filter?: { agentId?: AgentId; type?: string; sinceSeq?: number; limit?: number }): LedgerEntry[] {
    const f = filter ?? {};
    const want = f.limit !== undefined && f.limit >= 0 ? Math.floor(f.limit) : Infinity;
    if (want === 0) return [];
    const out: LedgerEntry[] = [];
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const e = this.rows[i] as LedgerEntry;
      if (f.sinceSeq !== undefined && e.seq <= f.sinceSeq) break; // seq is dense and ascending
      if (f.agentId !== undefined && e.agentId !== f.agentId) continue;
      if (f.type !== undefined && e.type !== f.type) continue;
      out.push(e);
      if (out.length >= want) break;
    }
    out.reverse();
    return out;
  }

  // --------------------------------------------------------------- verify --

  /**
   * Re-verify the chain.
   *
   * DEFAULT (incremental): re-hashes the RETAINED TAIL only, anchored on the
   * prevHash of its oldest entry, which is bounded work however long the swarm
   * has been up. Everything below the tail was verified when it was written or
   * replayed and is no longer reachable in memory to tamper with.
   *
   * full:true streams the whole file from disk. Boot and shutdown use it; an
   * HTTP request must never trigger it, because re-hashing 400k entries blocks
   * the single-threaded event loop for seconds and the tick watchdog then
   * charges that stall to the swarm.
   */
  verify(opts: { full?: boolean } = {}): VerifyResult {
    const result = opts.full === true ? this.verifyFromDisk() : this.verifyTail();
    this.lastVerdict = {
      ok: result.ok,
      brokenAtSeq: result.brokenAtSeq ?? null,
      atSeq: this.count,
      at: this.clock.now(),
      full: opts.full === true,
      fromSeq: opts.full === true ? 1 : this.firstRetainedSeq(),
    };
    if (result.ok && opts.full === true) {
      this.verifiedUpToSeq = this.count;
      this.writeWatermark();
    }
    return result;
  }

  /** The full O(n) check, streamed from the authoritative file. */
  verifyFull(): VerifyResult {
    return this.verify({ full: true });
  }

  private firstRetainedSeq(): number {
    const first = this.rows[0];
    return first === undefined ? this.count + 1 : first.seq;
  }

  private verifyTail(): VerifyResult {
    let prev = this.anchorPrevHash;
    let expected = this.firstRetainedSeq();
    for (const e of this.rows) {
      const broken = this.chainFault(e, expected, prev);
      if (broken !== null) return { ok: false, brokenAtSeq: broken };
      prev = e.hash;
      expected += 1;
    }
    if (this.rows.length > 0 && prev !== this.lastHash) {
      return { ok: false, brokenAtSeq: this.count };
    }
    return { ok: true };
  }

  private verifyFromDisk(): VerifyResult {
    if (!existsSync(this.path)) return this.count === 0 ? { ok: true } : { ok: false, brokenAtSeq: 1 };
    const fd = openSync(this.path, 'r');
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.allocUnsafe(REPLAY_CHUNK_BYTES);
    let carry = '';
    let expected = 1;
    let prev = GENESIS_HASH;
    try {
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        carry += decoder.write(buf.subarray(0, n));
        let nl = carry.indexOf('\n');
        while (nl >= 0) {
          const line = carry.slice(0, nl);
          carry = carry.slice(nl + 1);
          let e: LedgerEntry;
          try {
            e = this.coerce(JSON.parse(line), expected);
          } catch {
            return { ok: false, brokenAtSeq: expected };
          }
          const broken = this.chainFault(e, expected, prev);
          if (broken !== null) return { ok: false, brokenAtSeq: broken };
          prev = e.hash;
          expected += 1;
          nl = carry.indexOf('\n');
        }
      }
      carry += decoder.end();
    } finally {
      closeSync(fd);
    }
    if (carry !== '') return { ok: false, brokenAtSeq: expected };
    if (expected - 1 !== this.count) return { ok: false, brokenAtSeq: Math.min(expected, this.count) };
    return { ok: true };
  }

  /**
   * The last verdict reached, without computing a new one. Read-mostly callers
   * (the report route, dashboards) use this so that an unauthenticated GET can
   * never schedule an O(n) re-hash on the event loop.
   */
  lastVerification(): VerificationRecord | null {
    return this.lastVerdict === null ? null : { ...this.lastVerdict };
  }

  /**
   * Record how far the chain has been proven, beside the ledger. It is
   * INFORMATIONAL: boot always re-verifies from byte zero and never trusts
   * this file, because a watermark an attacker can write is not a proof.
   */
  private writeWatermark(): void {
    try {
      const file = join(dirname(this.path), LEDGER_WATERMARK_FILE);
      const body = {
        verifiedUpToSeq: this.verifiedUpToSeq,
        entries: this.count,
        head: this.lastHash,
        at: this.clock.now(),
        note: 'informational only; open() re-verifies the whole chain and never trusts this file',
      };
      writeFileSync(file, JSON.stringify(body) + '\n', 'utf8');
    } catch (err) {
      this.logger.warn('ledger.watermark_write_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  size(): number {
    return this.count;
  }

  /** How much of the ledger is currently resident in memory. */
  stats(): { entries: number; retained: number; tailCap: number; keys: number; verifiedUpToSeq: number } {
    return {
      entries: this.count,
      retained: this.rows.length,
      tailCap: this.tailCap,
      keys: this.byKey.size,
      verifiedUpToSeq: this.verifiedUpToSeq,
    };
  }

  /** Head of the chain; what the next entry's prevHash will be. */
  head(): string {
    return this.lastHash;
  }

  /** Releases the append file descriptor. The instance is unusable afterwards. */
  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    this.closed = true;
  }
}
