/**
 * market/csv.ts — CsvFeed: real prices from files on disk (SPEC §3).
 * Invariant: parsing is STRICT and STREAMED. Strict, because a silently accepted
 * bad row produces a confident wrong answer, which is worse than a crash — every
 * rejection names the file and the line. Streamed, because the ledger already
 * proved that readFileSync of a large file is a trap: a decade of daily bars for a
 * basket is tens of megabytes and this process also holds the ledger.
 * Deterministic, side-effect free, no network: this is the implementation that
 * works in an environment where every market-data host is blocked.
 * Callers: channels/equities.ts, market/report.ts, market/http.ts (parser reuse).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AresError } from '../core/errors.js';
import { nullLogger, type Logger } from '../core/logger.js';
import {
  assertAscending,
  assertDayUtc,
  assertSymbol,
  assertVenue,
  cmpDay,
  isDayUtc,
  parseDecimalToMinor,
  sliceDays,
  validateBar,
  VENUE_CURRENCY,
  VENUE_EXPONENT,
  type Bar,
  type PriceFeed,
  type Venue,
} from './feed.js';

/** The one header this feed accepts, in this order. */
export const CSV_HEADER: readonly string[] = Object.freeze(['date', 'open', 'high', 'low', 'close', 'volume']);

/** Default ceiling on a single instrument file. 32 MiB is ~40 years of daily bars. */
export const DEFAULT_MAX_CSV_BYTES = 33_554_432;

/** Default ceiling on rows in one file, independent of byte size. */
export const DEFAULT_MAX_ROWS = 200_000;

export interface CsvParseOptions {
  symbol: string;
  venue: Venue;
  /** Human-readable source name used in every error: a path, or "stooq:AAPL.US". */
  source: string;
  maxRows?: number;
  /**
   * Reject rows that fall on a non-session day for the venue. OFF by default:
   * with an empty (default) holiday list this would reject legitimate data, and
   * the calendar is the operator's to supply. Turn it on once the holiday list is
   * real and you want the file audited against it.
   */
  isSession?: (venue: Venue, dayUtc: string) => boolean;
}

/**
 * Feed one line at a time; call `finish()` at EOF. Holds only the last bar seen
 * for the ordering check, so memory is O(rows kept by the caller), not O(file).
 */
export class CsvRowParser {
  private line = 0;
  private headerSeen = false;
  private last: Bar | undefined;
  private count = 0;
  private readonly maxRows: number;

  constructor(private readonly opts: CsvParseOptions) {
    assertSymbol(opts.symbol, `${opts.source}: symbol`);
    assertVenue(opts.venue, `${opts.source}: venue`);
    this.maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  }

  get rowsParsed(): number {
    return this.count;
  }

  private at(): string {
    return `${this.opts.source}:${this.line}`;
  }

  private bad(code: string, msg: string, meta: Record<string, unknown> = {}): never {
    throw new AresError(code, `${this.at()}: ${msg}`, {
      ...meta,
      source: this.opts.source,
      line: this.line,
      symbol: this.opts.symbol,
      venue: this.opts.venue,
    });
  }

  /** Returns a Bar for a data row, or null for the header / a blank line. */
  push(raw: string): Bar | null {
    this.line++;
    const text = raw.replace(/\r$/, '');
    if (text.trim() === '') return null; // tolerate blank lines; the count still advances
    const cells = text.split(',').map((c) => c.trim());
    if (!this.headerSeen) {
      this.headerSeen = true;
      const got = cells.map((c) => c.toLowerCase());
      const ok = got.length === CSV_HEADER.length && CSV_HEADER.every((h, i) => got[i] === h);
      if (!ok) {
        this.bad(
          'MARKET_CSV_BAD_HEADER',
          `expected header ${JSON.stringify(CSV_HEADER.join(','))}, got ${JSON.stringify(text)}`,
          { expected: [...CSV_HEADER], got },
        );
      }
      return null;
    }
    if (cells.length !== CSV_HEADER.length) {
      this.bad('MARKET_CSV_BAD_ROW', `expected ${CSV_HEADER.length} fields, got ${cells.length} in ${JSON.stringify(text)}`, {
        fields: cells.length,
      });
    }
    if (++this.count > this.maxRows) {
      this.bad('MARKET_CSV_TOO_MANY_ROWS', `more than ${this.maxRows} data rows`, { maxRows: this.maxRows });
    }
    const [day, o, h, l, c, v] = cells as [string, string, string, string, string, string];
    if (!isDayUtc(day)) {
      this.bad('MARKET_CSV_BAD_DATE', `${JSON.stringify(day)} is not a real YYYY-MM-DD date`, { field: 'date' });
    }
    const exp = VENUE_EXPONENT[this.opts.venue];
    const px = (text2: string, field: string): number => parseDecimalToMinor(text2, exp, `${this.at()} [${field}]`);
    if (!/^\d+$/.test(v)) {
      this.bad('MARKET_CSV_BAD_VOLUME', `volume ${JSON.stringify(v)} must be a non-negative whole number`, {
        field: 'volume',
      });
    }
    const volume = Number(v);
    if (!Number.isSafeInteger(volume)) this.bad('MARKET_CSV_BAD_VOLUME', `volume ${JSON.stringify(v)} is too large`, {});
    const bar: Bar = {
      symbol: this.opts.symbol,
      venue: this.opts.venue,
      dayUtc: day,
      openMinor: px(o, 'open'),
      highMinor: px(h, 'high'),
      lowMinor: px(l, 'low'),
      closeMinor: px(c, 'close'),
      volume,
      currency: VENUE_CURRENCY[this.opts.venue],
    };
    validateBar(bar, this.at());
    assertAscending(this.last, bar, this.at());
    if (this.opts.isSession !== undefined && !this.opts.isSession(this.opts.venue, bar.dayUtc)) {
      this.bad('MARKET_CSV_NOT_A_SESSION', `${bar.dayUtc} is not a trading session for ${this.opts.venue}`, {
        day: bar.dayUtc,
      });
    }
    this.last = bar;
    return bar;
  }

  /** EOF check: a file with a header and no rows is almost always a failed download. */
  finish(): void {
    if (!this.headerSeen) {
      throw new AresError('MARKET_CSV_EMPTY', `${this.opts.source}: file is empty (no header row)`, {
        source: this.opts.source,
        symbol: this.opts.symbol,
      });
    }
    if (this.count === 0) {
      throw new AresError('MARKET_CSV_NO_ROWS', `${this.opts.source}: header present but no data rows`, {
        source: this.opts.source,
        symbol: this.opts.symbol,
      });
    }
  }
}

/** Parse CSV already in memory (used by HttpFeed, whose body is size-bounded). */
export function parseCsvText(text: string, opts: CsvParseOptions): Bar[] {
  const p = new CsvRowParser(opts);
  const out: Bar[] = [];
  for (const line of text.split('\n')) {
    const bar = p.push(line);
    if (bar !== null) out.push(bar);
  }
  p.finish();
  return out;
}

/**
 * Stream a CSV file from disk, never holding more than one chunk plus the parsed
 * bars. The byte ceiling is checked BEFORE opening (stat) and again while reading,
 * because a file can grow between the two.
 */
export async function parseCsvFile(path: string, opts: CsvParseOptions & { maxBytes?: number }): Promise<Bar[]> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_CSV_BYTES;
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) {
      throw new AresError('MARKET_CSV_NOT_A_FILE', `${path}: not a regular file`, { path });
    }
    size = st.size;
  } catch (err) {
    if (err instanceof AresError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new AresError(
        'MARKET_CSV_MISSING',
        `${path}: no price file for this symbol. CsvFeed reads ` +
          `<dataDir>/market/<venue>/<symbol>.csv — the operator supplies these files. The venue directory is ` +
          `lower-case ("us", "tadawul"); the file name is matched case-insensitively, so AAPL.csv and aapl.csv ` +
          `both load.`,
        { path, symbol: opts.symbol, venue: opts.venue },
      );
    }
    throw new AresError('MARKET_CSV_UNREADABLE', `${path}: ${String((err as Error).message)}`, { path, code });
  }
  if (size > maxBytes) {
    throw new AresError('MARKET_CSV_TOO_LARGE', `${path}: ${size} bytes exceeds the ${maxBytes}-byte ceiling`, {
      path,
      size,
      maxBytes,
    });
  }

  const parser = new CsvRowParser(opts);
  const bars: Bar[] = [];
  let pending = '';
  let read = 0;
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      const s = chunk as string;
      read += Buffer.byteLength(s, 'utf8');
      if (read > maxBytes) {
        throw new AresError('MARKET_CSV_TOO_LARGE', `${path}: exceeded the ${maxBytes}-byte ceiling while reading`, {
          path,
          maxBytes,
        });
      }
      pending += s;
      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        const bar = parser.push(pending.slice(0, nl));
        if (bar !== null) bars.push(bar);
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
    }
    if (pending !== '') {
      const bar = parser.push(pending);
      if (bar !== null) bars.push(bar);
    }
  } finally {
    stream.destroy();
  }
  parser.finish();
  return bars;
}

export interface CsvFeedOptions {
  /**
   * cfg.dataDir. Files live at <dataDir>/market/<venue>/<symbol>.csv, with the
   * venue directory lower-cased and the file name matched case-insensitively
   * (`aapl.csv`, `AAPL.csv` and the symbol as written all resolve).
   */
  dataDir: string;
  logger?: Logger;
  maxBytes?: number;
  maxRows?: number;
  /** Optional per-venue session check; see CsvParseOptions.isSession. */
  isSession?: (venue: Venue, dayUtc: string) => boolean;
}

/**
 * The offline feed. It is the one that works in this environment, and it is not a
 * second-class stand-in: a forward run is a CSV that the operator appends a row to
 * each evening, and a backtest is the same code over a longer file.
 */
export class CsvFeed implements PriceFeed {
  readonly name = 'csv';
  private readonly cache = new Map<string, Bar[]>();
  private readonly log: Logger;
  private closed = false;

  constructor(private readonly opts: CsvFeedOptions) {
    if (typeof opts.dataDir !== 'string' || opts.dataDir === '') {
      throw new AresError('MARKET_CSV_BAD_DIR', 'CsvFeed: dataDir is required', {});
    }
    this.log = opts.logger ?? nullLogger;
  }

  /**
   * The CANONICAL path for a symbol: `<dataDir>/market/<venue lower>/<symbol lower>.csv`.
   *
   * Symbols are conventionally written upper-cased (`AAPL`, and that is how they
   * are configured in ARES_MARKET_US_SYMBOLS), so an operator naturally saves
   * `AAPL.csv`. This returns `aapl.csv`. The two must not be allowed to disagree
   * silently — a file the operator can see in the directory, that the feed reports
   * as missing, is the kind of defect that gets blamed on the data. So the
   * canonical name is lower-case, and `resolvePath` ALSO accepts the symbol as
   * written and upper-cased. See `pathCandidatesFor`.
   */
  pathFor(symbol: string, venue: Venue): string {
    assertSymbol(symbol, 'CsvFeed.pathFor');
    assertVenue(venue, 'CsvFeed.pathFor');
    return join(this.opts.dataDir, 'market', venue.toLowerCase(), `${symbol.toLowerCase()}.csv`);
  }

  /**
   * Every file name accepted for a symbol, most canonical first: lower-case, then
   * the symbol exactly as written, then upper-case. A fixed, deduplicated list —
   * no directory scan, so the answer does not depend on what else is in the folder
   * and two runs over the same tree resolve identically.
   */
  pathCandidatesFor(symbol: string, venue: Venue): string[] {
    assertSymbol(symbol, 'CsvFeed.pathCandidatesFor');
    assertVenue(venue, 'CsvFeed.pathCandidatesFor');
    const dir = join(this.opts.dataDir, 'market', venue.toLowerCase());
    const names = [symbol.toLowerCase(), symbol, symbol.toUpperCase()];
    const out: string[] = [];
    for (const n of names) {
      const path = join(dir, `${n}.csv`);
      if (!out.includes(path)) out.push(path);
    }
    return out;
  }

  /**
   * The first candidate that exists, or the canonical path when none does — so a
   * genuinely missing file still fails with the name the operator should create.
   */
  async resolvePath(symbol: string, venue: Venue): Promise<string> {
    const candidates = this.pathCandidatesFor(symbol, venue);
    for (const candidate of candidates) {
      try {
        const st = await stat(candidate);
        if (st.isFile()) return candidate;
      } catch {
        // Not this one. A missing candidate is the normal case, not an error.
      }
    }
    return candidates[0] as string;
  }

  private assertOpen(op: string): void {
    if (this.closed) {
      throw new AresError('MARKET_FEED_CLOSED', `CsvFeed.${op}: feed is closed`, { op });
    }
  }

  /** Whole series for a symbol, parsed once and cached (files do not change mid-run). */
  async series(symbol: string, venue: Venue): Promise<Bar[]> {
    this.assertOpen('series');
    const key = `${venue}:${symbol}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const path = await this.resolvePath(symbol, venue);
    const parsed = await parseCsvFile(path, {
      symbol,
      venue,
      source: path,
      ...(this.opts.maxRows === undefined ? {} : { maxRows: this.opts.maxRows }),
      ...(this.opts.maxBytes === undefined ? {} : { maxBytes: this.opts.maxBytes }),
      ...(this.opts.isSession === undefined ? {} : { isSession: this.opts.isSession }),
    });
    this.cache.set(key, parsed);
    this.log.debug('market.csv.loaded', { path, bars: parsed.length, symbol, venue });
    return parsed;
  }

  async bars(symbol: string, venue: Venue, fromDay: string, toDay: string): Promise<Bar[]> {
    assertDayUtc(fromDay, 'CsvFeed.bars(fromDay)');
    assertDayUtc(toDay, 'CsvFeed.bars(toDay)');
    if (cmpDay(fromDay, toDay) > 0) {
      throw new AresError('MARKET_BAD_RANGE', `CsvFeed.bars: fromDay ${fromDay} is after toDay ${toDay}`, {
        fromDay,
        toDay,
        symbol,
        venue,
      });
    }
    return sliceDays(await this.series(symbol, venue), fromDay, toDay);
  }

  /**
   * The newest bar IN THE FILE. In a forward run that is "yesterday's close",
   * because the file only contains sessions that have finished. It is NOT a
   * licence to peek: the equities channel never prices a fill off latest().
   */
  async latest(symbol: string, venue: Venue): Promise<Bar | null> {
    const s = await this.series(symbol, venue);
    return s.length === 0 ? null : (s[s.length - 1] as Bar);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cache.clear();
  }
}

/**
 * An in-memory PriceFeed over bars a caller already holds. Not a toy: report.ts
 * runs the benchmark and the window distribution through the same code path as a
 * live feed, and tests build adversarial series with it.
 */
export class MemoryFeed implements PriceFeed {
  readonly name: string;
  private readonly data = new Map<string, Bar[]>();

  constructor(bars: readonly Bar[] = [], name = 'memory') {
    this.name = name;
    for (const b of bars) this.add(b);
  }

  add(bar: Bar): void {
    validateBar(bar, `${this.name}:${bar.symbol}@${bar.dayUtc}`);
    const key = `${bar.venue}:${bar.symbol}`;
    const arr = this.data.get(key);
    if (arr === undefined) {
      this.data.set(key, [bar]);
      return;
    }
    assertAscending(arr[arr.length - 1], bar, `${this.name}:${bar.symbol}@${bar.dayUtc}`);
    arr.push(bar);
  }

  async bars(symbol: string, venue: Venue, fromDay: string, toDay: string): Promise<Bar[]> {
    return sliceDays(this.data.get(`${venue}:${symbol}`) ?? [], fromDay, toDay);
  }

  async latest(symbol: string, venue: Venue): Promise<Bar | null> {
    const arr = this.data.get(`${venue}:${symbol}`) ?? [];
    return arr.length === 0 ? null : (arr[arr.length - 1] as Bar);
  }

  async close(): Promise<void> {
    this.data.clear();
  }
}
