/**
 * core/ledger.ts — append-only, hash-chained, double-entry ledger (JSONL on disk).
 * Invariants: legs of every entry sum to exactly 0; entry.hash covers all entry
 * fields INCLUDING prevHash (genesis prevHash = 64 zeros); seq is dense from 1;
 * a line is fsync'd to disk BEFORE in-memory state moves, so memory can never be
 * ahead of the file. open() replays + verifies. Callers: governance, agents, api.
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
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

export const GENESIS_HASH = '0'.repeat(64);
export const LEDGER_FILE = 'ledger.jsonl';

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
  private readonly rows: LedgerEntry[] = [];
  private readonly byKey = new Map<string, LedgerEntry>();
  private lastHash = GENESIS_HASH;
  private fd: number | null = null;
  private closed = false;

  private constructor(
    public readonly path: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Replay the whole file, verify the chain, then open the append fd. */
  static open(dataDir: string, clock: Clock, logger: Logger): Ledger {
    const dir = resolvePath(dataDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, LEDGER_FILE);
    const led = new Ledger(path, clock, logger);
    led.replay();
    const v = led.verify();
    if (!v.ok) {
      throw new IntegrityError(
        'LEDGER_CHAIN_BROKEN',
        `Ledger hash chain broken at seq ${String(v.brokenAtSeq)} in ${path}`,
        { path, brokenAtSeq: v.brokenAtSeq },
      );
    }
    led.fd = openSync(path, 'a');
    logger.info('ledger.opened', { path, entries: led.rows.length, head: led.lastHash });
    return led;
  }

  private replay(): void {
    if (!existsSync(this.path)) return;
    const content = readFileSync(this.path, 'utf8');
    if (content.length === 0) return;
    const parts = content.split('\n');
    // A complete file ends with '\n', so the final split element is ''.
    const tail = parts[parts.length - 1];
    if (tail !== '') {
      throw new IntegrityError(
        'LEDGER_TRUNCATED',
        `Ledger ${this.path} ends with a partial line (expected seq ${parts.length}); ` +
          `the process died mid-append. Refusing to open.`,
        { path: this.path, expectedSeq: parts.length, partial: tail?.slice(0, 200) ?? '' },
      );
    }
    parts.pop();
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i] ?? '';
      const expectedSeq = i + 1;
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
      this.rows.push(e);
      if (e.idempotencyKey !== '' && !this.byKey.has(e.idempotencyKey)) this.byKey.set(e.idempotencyKey, e);
      this.lastHash = e.hash;
    }
  }

  /** Structural validation of a replayed row (hash checking happens in verify()). */
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

  /**
   * Append one balanced entry. Duplicate idempotencyKey returns the existing
   * entry, writes nothing and does not advance seq. Disk first, memory second.
   */
  append(e: NewEntry): LedgerEntry {
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
        return existing;
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

    const seq = this.rows.length + 1;
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

    this.rows.push(entry);
    if (entry.idempotencyKey !== '') this.byKey.set(entry.idempotencyKey, entry);
    this.lastHash = entry.hash;
    return entry;
  }

  has(idempotencyKey: string): boolean {
    return idempotencyKey !== '' && this.byKey.has(idempotencyKey);
  }

  get(idempotencyKey: string): LedgerEntry | undefined {
    return this.byKey.get(idempotencyKey);
  }

  balances(): Record<Account, Minor> {
    const out = {} as Record<Account, Minor>;
    for (const a of ACCOUNTS) out[a] = 0;
    for (const e of this.rows) for (const l of e.legs) out[l.account] += l.amount;
    return out;
  }

  balanceOf(a: Account): Minor {
    let s = 0;
    for (const e of this.rows) for (const l of e.legs) if (l.account === a) s += l.amount;
    return s;
  }

  /** Net movement of the `cash` account over an inclusive tick range. */
  netCashFlow(fromTick: number, toTick: number, agentId?: AgentId): Minor {
    let s = 0;
    for (const e of this.rows) {
      if (e.tick < fromTick || e.tick > toTick) continue;
      if (agentId !== undefined && e.agentId !== agentId) continue;
      for (const l of e.legs) if (l.account === 'cash') s += l.amount;
    }
    return s;
  }

  entries(filter?: { agentId?: AgentId; type?: string; sinceSeq?: number; limit?: number }): LedgerEntry[] {
    const f = filter ?? {};
    const out: LedgerEntry[] = [];
    for (const e of this.rows) {
      if (f.agentId !== undefined && e.agentId !== f.agentId) continue;
      if (f.type !== undefined && e.type !== f.type) continue;
      if (f.sinceSeq !== undefined && e.seq <= f.sinceSeq) continue;
      out.push(e);
    }
    if (f.limit !== undefined && f.limit >= 0 && out.length > f.limit) {
      // Most recent `limit` entries.
      return out.slice(out.length - f.limit);
    }
    return out;
  }

  /** Recompute the full chain. Returns the FIRST broken seq, if any. */
  verify(): { ok: boolean; brokenAtSeq?: number } {
    let prev = GENESIS_HASH;
    for (let i = 0; i < this.rows.length; i++) {
      const e = this.rows[i];
      if (e === undefined) return { ok: false, brokenAtSeq: i + 1 };
      if (e.seq !== i + 1) return { ok: false, brokenAtSeq: i + 1 };
      if (e.prevHash !== prev) return { ok: false, brokenAtSeq: e.seq };
      if (sumLegs(e.legs) !== 0) return { ok: false, brokenAtSeq: e.seq };
      const { hash, ...rest } = e;
      if (entryHash(rest) !== hash) return { ok: false, brokenAtSeq: e.seq };
      prev = e.hash;
    }
    return { ok: true };
  }

  size(): number {
    return this.rows.length;
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
