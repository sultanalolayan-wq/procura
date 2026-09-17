/**
 * market/calendar.ts — trading sessions per venue (SPEC §5).
 * Invariant: "10 working days" is NOT one window. The US week is Mon-Fri and the
 * Tadawul week is Sun-Thu, so ten sessions from the same start date end on
 * different calendar days, and every count in this system is a count PER VENUE
 * that says which venue it is counting. No holiday is hardcoded as fact: the
 * holiday list is operator-supplied configuration and ships EMPTY.
 * Callers: channels/equities.ts (settlement + session stepping), market/report.ts,
 * the run controller.
 */

import { AresError } from '../core/errors.js';
import { addDaysUtc, assertDayUtc, assertVenue, cmpDay, weekdayUtc, type Venue } from './feed.js';

/**
 * The regular trading week, as UTC weekday numbers (0 = Sunday .. 6 = Saturday).
 *
 * This is the one calendar fact the module asserts, and it is asserted as a
 * DEFAULT, not as law: a venue can change its trading week (Tadawul itself moved
 * from Sun-Thu having previously run Sat-Wed), so `SessionCalendar` accepts an
 * override. What it will not do is guess.
 */
export const DEFAULT_SESSION_WEEKDAYS: Readonly<Record<Venue, readonly number[]>> = Object.freeze({
  US: Object.freeze([1, 2, 3, 4, 5]), // Mon-Fri
  TADAWUL: Object.freeze([0, 1, 2, 3, 4]), // Sun-Thu
});

/**
 * HOLIDAYS ARE NOT SHIPPED. This default is empty ON PURPOSE.
 *
 * Exchange holiday schedules are published per year, they move (Eid dates are
 * lunar; US market closures for national days of mourning are announced days in
 * advance), and a stale hardcoded list is worse than no list because it is
 * believed. The operator supplies ARES_MARKET_US_HOLIDAYS /
 * ARES_MARKET_TADAWUL_HOLIDAYS from the venue's own published calendar for the
 * period they are running, and the report states which list was used.
 *
 * Consequence of an empty list, stated plainly: the calendar will count a closed
 * holiday as a session. In replay that shows up immediately as a missing bar
 * (the CSV has no row for it); in a forward run it shows up as a day with no
 * data. Neither is silent, but neither is free — supply the list.
 */
export const DEFAULT_HOLIDAYS: Readonly<Record<Venue, readonly string[]>> = Object.freeze({
  US: Object.freeze([] as readonly string[]),
  TADAWUL: Object.freeze([] as readonly string[]),
});

export interface CalendarOptions {
  /** Operator-supplied, per venue. Empty by default. See DEFAULT_HOLIDAYS. */
  holidays?: Partial<Record<Venue, readonly string[]>>;
  /** Override the regular trading week, per venue. */
  weekdays?: Partial<Record<Venue, readonly number[]>>;
  /**
   * Safety stop for the forward/backward scans. A venue whose every weekday is a
   * configured holiday would otherwise spin forever; instead it throws and names
   * the venue. 3660 days is ten years.
   */
  maxScanDays?: number;
}

export const DEFAULT_MAX_SCAN_DAYS = 3660;

export class SessionCalendar {
  private readonly holidays: Record<Venue, ReadonlySet<string>>;
  private readonly weekdays: Record<Venue, ReadonlySet<number>>;
  private readonly maxScanDays: number;

  constructor(opts: CalendarOptions = {}) {
    const mk = (v: Venue): ReadonlySet<string> => {
      const list = opts.holidays?.[v] ?? DEFAULT_HOLIDAYS[v];
      const out = new Set<string>();
      for (const d of list) out.add(assertDayUtc(d, `SessionCalendar(${v} holidays)`));
      return out;
    };
    const wd = (v: Venue): ReadonlySet<number> => {
      const list = opts.weekdays?.[v] ?? DEFAULT_SESSION_WEEKDAYS[v];
      if (list.length === 0) {
        throw new AresError('MARKET_CALENDAR_EMPTY_WEEK', `SessionCalendar(${v}): the trading week cannot be empty`, {
          venue: v,
        });
      }
      for (const n of list) {
        if (!Number.isInteger(n) || n < 0 || n > 6) {
          throw new AresError('MARKET_CALENDAR_BAD_WEEKDAY', `SessionCalendar(${v}): weekday ${String(n)} is not 0..6`, {
            venue: v,
            weekday: n,
          });
        }
      }
      return new Set(list);
    };
    this.holidays = { US: mk('US'), TADAWUL: mk('TADAWUL') };
    this.weekdays = { US: wd('US'), TADAWUL: wd('TADAWUL') };
    this.maxScanDays = opts.maxScanDays ?? DEFAULT_MAX_SCAN_DAYS;
    if (!Number.isInteger(this.maxScanDays) || this.maxScanDays < 1) {
      throw new AresError('MARKET_CALENDAR_BAD_SCAN', `SessionCalendar: maxScanDays must be >= 1`, {
        maxScanDays: this.maxScanDays,
      });
    }
  }

  /** The holiday list actually in force, for the report to quote verbatim. */
  holidaysOf(venue: Venue): string[] {
    return [...this.holidays[assertVenue(venue, 'holidaysOf')]].sort();
  }

  weekdaysOf(venue: Venue): number[] {
    return [...this.weekdays[assertVenue(venue, 'weekdaysOf')]].sort();
  }

  isSession(venue: Venue, dayUtc: string): boolean {
    const v = assertVenue(venue, 'isSession');
    assertDayUtc(dayUtc, 'isSession');
    if (this.holidays[v].has(dayUtc)) return false;
    return this.weekdays[v].has(weekdayUtc(dayUtc));
  }

  /** Inclusive on both ends. Throws if from > to. */
  sessionsBetween(venue: Venue, fromDay: string, toDay: string): string[] {
    const v = assertVenue(venue, 'sessionsBetween');
    assertDayUtc(fromDay, 'sessionsBetween(fromDay)');
    assertDayUtc(toDay, 'sessionsBetween(toDay)');
    if (cmpDay(fromDay, toDay) > 0) {
      throw new AresError('MARKET_BAD_RANGE', `sessionsBetween(${v}): fromDay ${fromDay} is after toDay ${toDay}`, {
        venue: v,
        fromDay,
        toDay,
      });
    }
    const out: string[] = [];
    let d = fromDay;
    for (let i = 0; cmpDay(d, toDay) <= 0; i++) {
      if (i > this.maxScanDays) {
        throw new AresError(
          'MARKET_CALENDAR_SCAN_LIMIT',
          `sessionsBetween(${v}): ${fromDay}..${toDay} exceeds maxScanDays=${this.maxScanDays}`,
          { venue: v, fromDay, toDay, maxScanDays: this.maxScanDays },
        );
      }
      if (this.isSession(v, d)) out.push(d);
      d = addDaysUtc(d, 1);
    }
    return out;
  }

  /** The first session STRICTLY AFTER `dayUtc`. Never returns `dayUtc` itself. */
  nextSession(venue: Venue, dayUtc: string): string {
    return this.step(venue, dayUtc, 1, 'nextSession');
  }

  /** The last session STRICTLY BEFORE `dayUtc`. */
  prevSession(venue: Venue, dayUtc: string): string {
    return this.step(venue, dayUtc, -1, 'prevSession');
  }

  private step(venue: Venue, dayUtc: string, dir: 1 | -1, where: string): string {
    const v = assertVenue(venue, where);
    assertDayUtc(dayUtc, where);
    let d = dayUtc;
    for (let i = 0; i < this.maxScanDays; i++) {
      d = addDaysUtc(d, dir);
      if (this.isSession(v, d)) return d;
    }
    throw new AresError(
      'MARKET_CALENDAR_SCAN_LIMIT',
      `${where}(${v}): no session found within ${this.maxScanDays} days of ${dayUtc} — ` +
        `check the configured holiday list and trading week for this venue`,
      { venue: v, day: dayUtc, maxScanDays: this.maxScanDays, direction: dir },
    );
  }

  /**
   * `dayUtc` itself if it is a session, otherwise the next one. Used to snap an
   * operator-supplied start date onto the venue's grid.
   */
  sessionOnOrAfter(venue: Venue, dayUtc: string): string {
    return this.isSession(venue, dayUtc) ? assertDayUtc(dayUtc, 'sessionOnOrAfter') : this.nextSession(venue, dayUtc);
  }

  sessionOnOrBefore(venue: Venue, dayUtc: string): string {
    return this.isSession(venue, dayUtc) ? assertDayUtc(dayUtc, 'sessionOnOrBefore') : this.prevSession(venue, dayUtc);
  }

  /**
   * Move `n` SESSIONS (not calendar days) from `dayUtc`. n=0 returns the day
   * itself if it is a session, otherwise it snaps forward. This is the T+2
   * settlement primitive: settlement is two SESSIONS later, so a Thursday sale on
   * Tadawul settles on the Monday, not "Saturday".
   */
  addSessions(venue: Venue, dayUtc: string, n: number): string {
    if (!Number.isInteger(n)) {
      throw new AresError('MARKET_BAD_SESSION_COUNT', `addSessions: n must be an integer, got ${String(n)}`, { n });
    }
    let d = n >= 0 ? this.sessionOnOrAfter(venue, dayUtc) : this.sessionOnOrBefore(venue, dayUtc);
    const dir = n >= 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(n); i++) d = this.step(venue, d, dir, 'addSessions');
    return d;
  }

  /**
   * The next `count` sessions starting at (and including) the first session on or
   * after `startDay`. THIS is "10 working days", and it is deliberately the only
   * way to get one: the caller must name a venue, and the answer differs.
   */
  sessionWindow(venue: Venue, startDay: string, count: number): string[] {
    const v = assertVenue(venue, 'sessionWindow');
    if (!Number.isInteger(count) || count < 1) {
      throw new AresError('MARKET_BAD_SESSION_COUNT', `sessionWindow(${v}): count must be >= 1, got ${String(count)}`, {
        venue: v,
        count,
      });
    }
    const out: string[] = [this.sessionOnOrAfter(v, startDay)];
    while (out.length < count) out.push(this.nextSession(v, out[out.length - 1] as string));
    return out;
  }
}

/**
 * Both venues' windows for the same nominal run length, side by side. The run
 * controller reports this so nobody ever compares a US "10 days" with a Tadawul
 * "10 days" and assumes they covered the same calendar.
 */
export interface VenueWindow {
  venue: Venue;
  sessions: string[];
  firstSession: string;
  lastSession: string;
  calendarDaysSpanned: number;
}

export function describeWindows(
  cal: SessionCalendar,
  startDay: string,
  count: number,
  venues: readonly Venue[] = ['US', 'TADAWUL'],
): VenueWindow[] {
  return venues.map((v) => {
    const sessions = cal.sessionWindow(v, startDay, count);
    const first = sessions[0] as string;
    const last = sessions[sessions.length - 1] as string;
    return {
      venue: v,
      sessions,
      firstSession: first,
      lastSession: last,
      calendarDaysSpanned:
        Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1,
    };
  });
}
