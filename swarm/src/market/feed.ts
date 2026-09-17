/**
 * market/feed.ts — the seam between ARES and real price data (SPEC §2, FROZEN).
 * Invariant: a price is NEVER a float. Decimal text is parsed into integer minor
 * units exactly, or the parse throws — a price that cannot be represented exactly
 * is bad data, not a rounding opportunity. Every Bar is validated before it leaves
 * a feed, and every rejection names the source and the line.
 * Callers: market/csv.ts, market/http.ts, channels/equities.ts, market/report.ts.
 *
 * READ-ONLY BOUNDARY: a PriceFeed reads. It has no write verb, no order path and
 * no knowledge that orders exist. Fills are modelled locally in channels/equities.ts
 * against the bars a feed returns; nothing here can reach a venue.
 */

import { AresError } from '../core/errors.js';
import type { Currency, Minor } from '../core/money.js';

/* ------------------------------------------------------------------ §2 types */

export type Venue = 'US' | 'TADAWUL';

export interface Bar {
  symbol: string;
  venue: Venue;
  dayUtc: string; // YYYY-MM-DD
  openMinor: Minor;
  highMinor: Minor;
  lowMinor: Minor;
  closeMinor: Minor;
  volume: number;
  currency: Currency;
}

export interface PriceFeed {
  readonly name: string;
  bars(symbol: string, venue: Venue, fromDay: string, toDay: string): Promise<Bar[]>;
  latest(symbol: string, venue: Venue): Promise<Bar | null>;
  close(): Promise<void>;
}

/* --------------------------------------------------------------- venue facts */

export const VENUES: readonly Venue[] = Object.freeze(['US', 'TADAWUL'] as const);

/**
 * The currency each venue quotes in. This is a property of the venue, not a
 * preference: a US bar is USD, a Tadawul bar is SAR, and a feed that returns a
 * bar in the other currency is rejected. Cross-currency arithmetic happens once,
 * explicitly, at the FX boundary in channels/equities.ts.
 */
export const VENUE_CURRENCY: Readonly<Record<Venue, Currency>> = Object.freeze({
  US: 'USD',
  TADAWUL: 'SAR',
});

/** Minor units per major unit. Both SAR and USD are 2-decimal currencies. */
export const VENUE_EXPONENT: Readonly<Record<Venue, number>> = Object.freeze({
  US: 2,
  TADAWUL: 2,
});

export function isVenue(v: unknown): v is Venue {
  return typeof v === 'string' && (VENUES as readonly string[]).includes(v);
}

export function assertVenue(v: unknown, where: string): Venue {
  if (!isVenue(v)) {
    throw new AresError('MARKET_BAD_VENUE', `${where}: unknown venue ${JSON.stringify(v)} (expected US or TADAWUL)`, {
      venue: v,
      where,
    });
  }
  return v;
}

/**
 * Symbols are used to build a file path and a URL path, so they are restricted
 * to a conservative character set. This is the traversal guard: "../../etc/passwd"
 * is not a ticker.
 */
const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function assertSymbol(symbol: unknown, where: string): string {
  if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol) || symbol.includes('..')) {
    throw new AresError('MARKET_BAD_SYMBOL', `${where}: illegal symbol ${JSON.stringify(symbol)}`, { symbol, where });
  }
  return symbol;
}

/* -------------------------------------------------------------- day handling */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real UTC calendar date in YYYY-MM-DD form. 2025-02-30 is false. */
export function isDayUtc(d: unknown): d is string {
  if (typeof d !== 'string') return false;
  const m = DAY_RE.exec(d);
  if (m === null) return false;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return false;
  const t = Date.UTC(y, mo - 1, da);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === da;
}

export function assertDayUtc(d: unknown, where: string): string {
  if (!isDayUtc(d)) {
    throw new AresError('MARKET_BAD_DAY', `${where}: expected a real YYYY-MM-DD UTC date, got ${JSON.stringify(d)}`, {
      day: d,
      where,
    });
  }
  return d;
}

/** Lexicographic comparison is chronological for YYYY-MM-DD; -1 | 0 | 1. */
export function cmpDay(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function dayToUtcMs(day: string): number {
  assertDayUtc(day, 'dayToUtcMs');
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

export function utcMsToDay(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const da = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** Calendar-day arithmetic (NOT session arithmetic — see market/calendar.ts). */
export function addDaysUtc(day: string, n: number): string {
  if (!Number.isInteger(n)) {
    throw new AresError('MARKET_BAD_DAY', `addDaysUtc: n must be an integer, got ${String(n)}`, { day, n });
  }
  return utcMsToDay(dayToUtcMs(day) + n * 86_400_000);
}

/** 0 = Sunday … 6 = Saturday, in UTC. */
export function weekdayUtc(day: string): number {
  return new Date(dayToUtcMs(day)).getUTCDay();
}

/* ----------------------------------------------------- exact decimal parsing */

/**
 * Parse a decimal price string into integer minor units, EXACTLY.
 *
 * Rounding policy, stated once and enforced everywhere: there is none. A value
 * with more significant decimal places than the currency has (e.g. "123.456" in
 * a 2-decimal currency) THROWS. Trailing zeros are not significant, so "123.4500"
 * is accepted and is exactly 12345 minor units.
 *
 * Why no silent rounding: a feed that quietly rounds sub-minor precision hides
 * the fact that its data is in a different unit (or a different currency, or a
 * split-adjusted series) than the caller believes. The crash is the finding.
 *
 * The parse is done on digit STRINGS, never on a float: `Number("0.1") * 100`
 * is 10.000000000000002, and that is exactly the class of error this exists to
 * prevent.
 */
export function parseDecimalToMinor(text: string, exponent: number, where: string): Minor {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new AresError('MARKET_BAD_EXPONENT', `${where}: exponent must be an integer in 0..6, got ${String(exponent)}`, {
      exponent,
      where,
    });
  }
  if (typeof text !== 'string') {
    throw new AresError('MARKET_BAD_PRICE', `${where}: expected a decimal string, got ${typeof text}`, { where });
  }
  const s = text.trim();
  if (s === '') {
    throw new AresError('MARKET_BAD_PRICE', `${where}: empty price field`, { where });
  }
  // Deliberately strict: no thousands separators, no exponent notation, no
  // currency symbols, no leading '+'. Anything unusual is a data-source change
  // we want to hear about, loudly, the first time.
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (m === null) {
    throw new AresError(
      'MARKET_BAD_PRICE',
      `${where}: ${JSON.stringify(text)} is not a plain decimal number (no separators, no exponent notation)`,
      { text, where },
    );
  }
  const sign = m[1] === '-' ? -1 : 1;
  const whole = m[2] ?? '0';
  const frac = m[3] ?? '';
  let significant = frac;
  while (significant.length > exponent && significant.endsWith('0')) significant = significant.slice(0, -1);
  if (significant.length > exponent) {
    throw new AresError(
      'MARKET_PRICE_NOT_EXACT',
      `${where}: ${JSON.stringify(text)} has ${significant.length} decimal place(s) but this currency has ` +
        `${exponent}; it cannot be represented exactly in minor units and this parser refuses to round it`,
      { text, exponent, decimals: significant.length, where },
    );
  }
  const padded = significant.padEnd(exponent, '0');
  const digits = `${whole}${padded}`;
  // Reject before Number(): a 20-digit price is a corrupt field, not a price.
  if (digits.length > 15) {
    throw new AresError('MARKET_BAD_PRICE', `${where}: ${JSON.stringify(text)} is too large to hold exactly`, {
      text,
      where,
    });
  }
  const n = Number(digits);
  if (!Number.isSafeInteger(n)) {
    throw new AresError('MARKET_BAD_PRICE', `${where}: ${JSON.stringify(text)} does not fit a safe integer`, {
      text,
      where,
    });
  }
  return n === 0 ? 0 : sign * n;
}

/** Render integer minor units back to a decimal string. Pure string maths. */
export function minorToDecimal(minor: Minor, exponent: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new AresError('MARKET_BAD_PRICE', `minorToDecimal: ${String(minor)} is not a safe integer`, { minor });
  }
  if (exponent === 0) return String(minor);
  const neg = minor < 0;
  const d = Math.abs(minor).toString().padStart(exponent + 1, '0');
  return `${neg ? '-' : ''}${d.slice(0, d.length - exponent)}.${d.slice(d.length - exponent)}`;
}

/* ------------------------------------------------------------ bar validation */

/**
 * Every structural truth a bar must satisfy. `where` is the source location —
 * "aapl.us.csv:14" or "stooq:AAPL.US line 14" — and it is REQUIRED, because a
 * rejection that does not say which line is wrong makes the operator re-derive
 * it by hand from a file with thousands of rows.
 */
export function validateBar(bar: Bar, where: string): Bar {
  const bad = (code: string, msg: string, meta: Record<string, unknown> = {}): never => {
    throw new AresError(code, `${where}: ${msg}`, { ...meta, where, symbol: bar.symbol, day: bar.dayUtc });
  };
  assertVenue(bar.venue, where);
  assertSymbol(bar.symbol, where);
  assertDayUtc(bar.dayUtc, where);
  if (bar.currency !== VENUE_CURRENCY[bar.venue]) {
    bad('MARKET_BAR_CURRENCY', `venue ${bar.venue} quotes ${VENUE_CURRENCY[bar.venue]}, bar claims ${bar.currency}`);
  }
  const fields: ReadonlyArray<readonly [string, number]> = [
    ['open', bar.openMinor],
    ['high', bar.highMinor],
    ['low', bar.lowMinor],
    ['close', bar.closeMinor],
  ];
  for (const [nm, v] of fields) {
    if (!Number.isSafeInteger(v)) bad('MARKET_BAR_PRICE', `${nm} must be an integer minor amount, got ${String(v)}`);
    if (v <= 0) {
      bad('MARKET_BAR_PRICE', `${nm} must be > 0, got ${minorToDecimal(v, VENUE_EXPONENT[bar.venue])}`, { field: nm });
    }
  }
  if (bar.highMinor < bar.lowMinor) {
    bad('MARKET_BAR_RANGE', `high (${bar.highMinor}) is below low (${bar.lowMinor})`);
  }
  if (bar.openMinor < bar.lowMinor || bar.openMinor > bar.highMinor) {
    bad('MARKET_BAR_RANGE', `open (${bar.openMinor}) is outside [low ${bar.lowMinor}, high ${bar.highMinor}]`);
  }
  if (bar.closeMinor < bar.lowMinor || bar.closeMinor > bar.highMinor) {
    bad('MARKET_BAR_RANGE', `close (${bar.closeMinor}) is outside [low ${bar.lowMinor}, high ${bar.highMinor}]`);
  }
  if (!Number.isSafeInteger(bar.volume) || bar.volume < 0) {
    bad('MARKET_BAR_VOLUME', `volume must be a non-negative integer, got ${String(bar.volume)}`);
  }
  return bar;
}

/** Reject an out-of-order or duplicated series. `where` names the later row. */
export function assertAscending(prev: Bar | undefined, next: Bar, where: string): void {
  if (prev === undefined) return;
  const c = cmpDay(prev.dayUtc, next.dayUtc);
  if (c === 0) {
    throw new AresError('MARKET_DUPLICATE_DAY', `${where}: duplicate date ${next.dayUtc}`, {
      where,
      day: next.dayUtc,
      symbol: next.symbol,
    });
  }
  if (c > 0) {
    throw new AresError(
      'MARKET_OUT_OF_ORDER',
      `${where}: date ${next.dayUtc} is earlier than the preceding row's ${prev.dayUtc}; ` +
        `series must be strictly ascending`,
      { where, day: next.dayUtc, previousDay: prev.dayUtc, symbol: next.symbol },
    );
  }
}

/** Inclusive [fromDay, toDay] slice of an already-ascending series. */
export function sliceDays(bars: readonly Bar[], fromDay: string, toDay: string): Bar[] {
  assertDayUtc(fromDay, 'sliceDays(fromDay)');
  assertDayUtc(toDay, 'sliceDays(toDay)');
  if (cmpDay(fromDay, toDay) > 0) {
    throw new AresError('MARKET_BAD_RANGE', `sliceDays: fromDay ${fromDay} is after toDay ${toDay}`, { fromDay, toDay });
  }
  return bars.filter((b) => cmpDay(b.dayUtc, fromDay) >= 0 && cmpDay(b.dayUtc, toDay) <= 0);
}

/* ------------------------------------------------- the structural no-lookahead guard */

/** Lower bound for "from the beginning of the series"; older than any listing. */
export const EPOCH_FLOOR_DAY = '1900-01-01';

/**
 * A PriceFeed decorator that CANNOT return a bar dated after `asOfDay`.
 *
 * This is the belt to the equities channel's braces. The channel is careful never
 * to read the future during a decision; this wrapper makes the careful part
 * impossible to get wrong by accident, because the data simply is not there. A
 * decision path handed an AsOfFeed sees exactly what a live trader saw at that
 * day's close, and nothing else.
 *
 * `advanceTo()` moves the seal forward only. It never moves backwards, so a run
 * cannot quietly rewind and re-decide with hindsight.
 */
export class AsOfFeed implements PriceFeed {
  readonly name: string;
  private day: string;

  constructor(
    private readonly inner: PriceFeed,
    asOfDay: string,
  ) {
    this.day = assertDayUtc(asOfDay, 'AsOfFeed');
    this.name = `asof(${inner.name})`;
  }

  get asOfDay(): string {
    return this.day;
  }

  advanceTo(day: string): void {
    assertDayUtc(day, 'AsOfFeed.advanceTo');
    if (cmpDay(day, this.day) < 0) {
      throw new AresError('MARKET_ASOF_REWIND', `AsOfFeed.advanceTo: refusing to rewind from ${this.day} to ${day}`, {
        from: this.day,
        to: day,
      });
    }
    this.day = day;
  }

  async bars(symbol: string, venue: Venue, fromDay: string, toDay: string): Promise<Bar[]> {
    const capped = cmpDay(toDay, this.day) > 0 ? this.day : toDay;
    if (cmpDay(fromDay, capped) > 0) return [];
    return this.inner.bars(symbol, venue, fromDay, capped);
  }

  /** The last bar AT OR BEFORE the seal — never the newest bar the source has. */
  async latest(symbol: string, venue: Venue): Promise<Bar | null> {
    const b = await this.inner.latest(symbol, venue);
    if (b === null) return null;
    if (cmpDay(b.dayUtc, this.day) <= 0) return b;
    const visible = await this.inner.bars(symbol, venue, EPOCH_FLOOR_DAY, this.day);
    return visible.length === 0 ? null : (visible[visible.length - 1] as Bar);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
