/**
 * test/market.calendar.test.ts — sessions, per venue.
 * Pins: the US week is Mon-Fri and the Tadawul week is Sun-Thu; "10 working days"
 * is a DIFFERENT calendar window for each of them and the code says which; holidays
 * come from configuration and the shipped list is EMPTY (no holiday is asserted as
 * fact anywhere); T+2 counts SESSIONS, so a Thursday Tadawul sale settles on the
 * Monday; and a venue with no reachable session fails loudly instead of spinning.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AresError } from '../src/core/errors.js';
import {
  DEFAULT_HOLIDAYS,
  DEFAULT_SESSION_WEEKDAYS,
  SessionCalendar,
  describeWindows,
} from '../src/market/calendar.js';
import { weekdayUtc } from '../src/market/feed.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AresError, `expected AresError, got ${String(err)}`);
    return err.code;
  }
  throw new Error('expected a throw, got none');
}

test('NO holiday is shipped as fact — the default list is empty for both venues', () => {
  assert.deepEqual([...DEFAULT_HOLIDAYS.US], []);
  assert.deepEqual([...DEFAULT_HOLIDAYS.TADAWUL], []);
  const cal = new SessionCalendar();
  assert.deepEqual(cal.holidaysOf('US'), []);
  assert.deepEqual(cal.holidaysOf('TADAWUL'), []);
  // ...including the dates one would be most tempted to hardcode.
  assert.equal(cal.isSession('US', '2025-12-25'), true);
  assert.equal(cal.isSession('US', '2025-07-04'), true);
  assert.equal(cal.isSession('TADAWUL', '2025-09-23'), true);
});

test('the two venues keep different weeks', () => {
  assert.deepEqual([...DEFAULT_SESSION_WEEKDAYS.US], [1, 2, 3, 4, 5]);
  assert.deepEqual([...DEFAULT_SESSION_WEEKDAYS.TADAWUL], [0, 1, 2, 3, 4]);
  const cal = new SessionCalendar();
  // 2025-01-03 Fri, 2025-01-04 Sat, 2025-01-05 Sun.
  assert.equal(weekdayUtc('2025-01-03'), 5);
  assert.equal(cal.isSession('US', '2025-01-03'), true);
  assert.equal(cal.isSession('TADAWUL', '2025-01-03'), false);
  assert.equal(cal.isSession('US', '2025-01-04'), false);
  assert.equal(cal.isSession('TADAWUL', '2025-01-04'), false);
  assert.equal(cal.isSession('US', '2025-01-05'), false);
  assert.equal(cal.isSession('TADAWUL', '2025-01-05'), true);
});

test('"10 working days" is a different window per venue, and the code says so', () => {
  const cal = new SessionCalendar();
  const [us, tad] = describeWindows(cal, '2025-01-01', 10);
  assert.ok(us && tad);
  assert.equal(us.venue, 'US');
  assert.equal(tad.venue, 'TADAWUL');
  assert.equal(us.sessions.length, 10);
  assert.equal(tad.sessions.length, 10);
  // Same nominal length, different calendars — this is the whole point.
  assert.notDeepEqual(us.sessions, tad.sessions);
  assert.equal(us.firstSession, '2025-01-01'); // Wednesday
  assert.equal(us.lastSession, '2025-01-14');
  assert.equal(tad.firstSession, '2025-01-01');
  assert.equal(tad.lastSession, '2025-01-14');
  // They span the same number of calendar days here but NOT the same days:
  assert.ok(us.sessions.includes('2025-01-03')); // Friday: US only
  assert.ok(!tad.sessions.includes('2025-01-03'));
  assert.ok(tad.sessions.includes('2025-01-05')); // Sunday: Tadawul only
  assert.ok(!us.sessions.includes('2025-01-05'));
});

test('operator-supplied holidays remove sessions and lengthen the window', () => {
  const cal = new SessionCalendar({ holidays: { US: ['2025-01-02', '2025-01-03'] } });
  assert.equal(cal.isSession('US', '2025-01-02'), false);
  assert.deepEqual(cal.holidaysOf('US'), ['2025-01-02', '2025-01-03']);
  const w = cal.sessionWindow('US', '2025-01-01', 3);
  assert.deepEqual(w, ['2025-01-01', '2025-01-06', '2025-01-07']);
  // A holiday list with a fake date is refused at construction.
  assert.equal(codeOf(() => new SessionCalendar({ holidays: { US: ['2025-02-30'] } })), 'MARKET_BAD_DAY');
});

test('sessionsBetween is inclusive, ordered and refuses an inverted range', () => {
  const cal = new SessionCalendar();
  assert.deepEqual(cal.sessionsBetween('US', '2025-01-03', '2025-01-07'), ['2025-01-03', '2025-01-06', '2025-01-07']);
  assert.deepEqual(cal.sessionsBetween('TADAWUL', '2025-01-03', '2025-01-07'), [
    '2025-01-05',
    '2025-01-06',
    '2025-01-07',
  ]);
  assert.equal(codeOf(() => cal.sessionsBetween('US', '2025-01-07', '2025-01-03')), 'MARKET_BAD_RANGE');
});

test('next/prev session are STRICT: they never return the day they were given', () => {
  const cal = new SessionCalendar();
  assert.equal(cal.nextSession('US', '2025-01-03'), '2025-01-06'); // Fri -> Mon
  assert.equal(cal.prevSession('US', '2025-01-06'), '2025-01-03');
  assert.equal(cal.nextSession('TADAWUL', '2025-01-02'), '2025-01-05'); // Thu -> Sun
  assert.equal(cal.prevSession('TADAWUL', '2025-01-05'), '2025-01-02');
  assert.equal(cal.nextSession('US', '2025-01-06'), '2025-01-07');
  assert.equal(cal.sessionOnOrAfter('US', '2025-01-04'), '2025-01-06');
  assert.equal(cal.sessionOnOrAfter('US', '2025-01-06'), '2025-01-06');
});

test('T+2 counts SESSIONS, not calendar days, and each venue counts its own', () => {
  const cal = new SessionCalendar();
  // US: Thursday 2025-01-02 + 2 sessions = Monday 2025-01-06.
  assert.equal(cal.addSessions('US', '2025-01-02', 2), '2025-01-06');
  // Tadawul: Thursday 2025-01-02 + 2 sessions = Monday 2025-01-06 as well, but by
  // a different route (Sun, Mon) — the weekend it skips is Fri/Sat, not Sat/Sun.
  assert.equal(cal.addSessions('TADAWUL', '2025-01-02', 2), '2025-01-06');
  // ...and where they genuinely differ:
  assert.equal(cal.addSessions('US', '2025-01-03', 2), '2025-01-07'); // Fri -> Tue
  assert.equal(cal.addSessions('TADAWUL', '2025-01-01', 2), '2025-01-05'); // Wed -> Sun
  assert.equal(cal.addSessions('US', '2025-01-06', 0), '2025-01-06');
  assert.equal(cal.addSessions('US', '2025-01-04', 0), '2025-01-06'); // snaps forward
  assert.equal(cal.addSessions('US', '2025-01-08', -2), '2025-01-06');
});

test('a calendar that can never open fails loudly instead of looping forever', () => {
  const everyDayAHoliday: string[] = [];
  let d = Date.UTC(2025, 0, 1);
  for (let i = 0; i < 40; i++) {
    everyDayAHoliday.push(new Date(d).toISOString().slice(0, 10));
    d += 86_400_000;
  }
  const cal = new SessionCalendar({ holidays: { US: everyDayAHoliday }, maxScanDays: 30 });
  assert.equal(codeOf(() => cal.nextSession('US', '2025-01-01')), 'MARKET_CALENDAR_SCAN_LIMIT');
  assert.equal(codeOf(() => cal.sessionWindow('US', '2025-01-01', 3)), 'MARKET_CALENDAR_SCAN_LIMIT');
});

test('a bad trading week is refused at construction, not at the first query', () => {
  assert.equal(codeOf(() => new SessionCalendar({ weekdays: { US: [] } })), 'MARKET_CALENDAR_EMPTY_WEEK');
  assert.equal(codeOf(() => new SessionCalendar({ weekdays: { US: [7] } })), 'MARKET_CALENDAR_BAD_WEEKDAY');
  // An overridden week is honoured: Tadawul ran Sat-Wed before 2013.
  const old = new SessionCalendar({ weekdays: { TADAWUL: [6, 0, 1, 2, 3] } });
  assert.equal(old.isSession('TADAWUL', '2025-01-04'), true); // Saturday
  assert.equal(old.isSession('TADAWUL', '2025-01-02'), false); // Thursday
});
