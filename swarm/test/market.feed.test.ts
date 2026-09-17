/**
 * test/market.feed.test.ts — the seam, adversarially.
 * Pins: prices are parsed into integer minor units EXACTLY or not at all (the
 * float path that turns 0.07 into 7.000000000000001 is never taken), a price with
 * more precision than the currency has THROWS instead of rounding, every bar
 * invariant is checked and names its source, and AsOfFeed makes lookahead
 * structurally impossible rather than merely discouraged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AresError } from '../src/core/errors.js';
import {
  AsOfFeed,
  addDaysUtc,
  assertAscending,
  assertDayUtc,
  assertSymbol,
  assertVenue,
  cmpDay,
  isDayUtc,
  isVenue,
  minorToDecimal,
  parseDecimalToMinor,
  sliceDays,
  validateBar,
  VENUE_CURRENCY,
  weekdayUtc,
  type Bar,
} from '../src/market/feed.js';
import { MemoryFeed } from '../src/market/csv.js';

function bar(day: string, o: number, h: number, l: number, c: number, symbol = 'AAPL'): Bar {
  return {
    symbol,
    venue: 'US',
    dayUtc: day,
    openMinor: o,
    highMinor: h,
    lowMinor: l,
    closeMinor: c,
    volume: 1000,
    currency: 'USD',
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AresError, `expected AresError, got ${String(err)}`);
    return err.code;
  }
  throw new Error('expected a throw, got none');
}

/* ------------------------------------------------------- exact price parsing */

test('decimal prices become integer minor units exactly', () => {
  assert.equal(parseDecimalToMinor('123.45', 2, 'x'), 12345);
  assert.equal(parseDecimalToMinor('0.07', 2, 'x'), 7);
  assert.equal(parseDecimalToMinor('1', 2, 'x'), 100);
  assert.equal(parseDecimalToMinor('0.1', 2, 'x'), 10);
  assert.equal(parseDecimalToMinor('-4.20', 2, 'x'), -420);
  assert.equal(parseDecimalToMinor('0.00', 2, 'x'), 0);
});

test('the parser never goes through a float: 0.07 * 100 is not 7 in IEEE754', () => {
  // The bug this prevents, demonstrated:
  assert.notEqual(Number('0.07') * 100, 7);
  assert.equal(Number('0.07') * 100, 7.000000000000001);
  // ...and the parser's answer:
  assert.equal(parseDecimalToMinor('0.07', 2, 'x'), 7);
  assert.equal(Number.isSafeInteger(parseDecimalToMinor('0.29', 2, 'x')), true);
  assert.equal(parseDecimalToMinor('0.29', 2, 'x'), 29);
});

test('a price that cannot be held exactly THROWS rather than rounding — 123.456', () => {
  const code = codeOf(() => parseDecimalToMinor('123.456', 2, 'aapl.us.csv:14 [close]'));
  assert.equal(code, 'MARKET_PRICE_NOT_EXACT');
  let msg = '';
  try {
    parseDecimalToMinor('123.456', 2, 'aapl.us.csv:14 [close]');
  } catch (e) {
    msg = (e as Error).message;
  }
  assert.match(msg, /aapl\.us\.csv:14 \[close\]/);
  assert.match(msg, /refuses to round/);
});

test('trailing zeros are not precision: 123.4500 is exactly 12345 minor', () => {
  assert.equal(parseDecimalToMinor('123.4500', 2, 'x'), 12345);
  assert.equal(parseDecimalToMinor('123.45000000', 2, 'x'), 12345);
  // ...but a non-zero digit past the exponent still throws.
  assert.equal(codeOf(() => parseDecimalToMinor('123.4501', 2, 'x')), 'MARKET_PRICE_NOT_EXACT');
});

test('anything that is not a plain decimal is refused, loudly', () => {
  for (const bad of ['1,234.50', '1e3', '+1.00', 'NaN', 'Infinity', '', '  ', '1.2.3', '$5.00', '5.']) {
    assert.equal(codeOf(() => parseDecimalToMinor(bad, 2, 'x')), 'MARKET_BAD_PRICE', `accepted ${JSON.stringify(bad)}`);
  }
});

test('minorToDecimal round-trips every parse', () => {
  for (const s of ['0.00', '0.07', '1.00', '123.45', '99999.99']) {
    assert.equal(minorToDecimal(parseDecimalToMinor(s, 2, 'x'), 2), s);
  }
  assert.equal(minorToDecimal(-420, 2), '-4.20');
});

/* ---------------------------------------------------------------- day maths */

test('dates are real calendar dates, in UTC', () => {
  assert.equal(isDayUtc('2025-02-28'), true);
  assert.equal(isDayUtc('2024-02-29'), true);
  assert.equal(isDayUtc('2025-02-29'), false);
  assert.equal(isDayUtc('2025-02-30'), false);
  assert.equal(isDayUtc('2025-13-01'), false);
  assert.equal(isDayUtc('20250101'), false);
  assert.equal(isDayUtc('2025-1-1'), false);
  assert.equal(codeOf(() => assertDayUtc('2025-02-30', 'x')), 'MARKET_BAD_DAY');
});

test('addDaysUtc crosses months, years and leap days without a timezone in sight', () => {
  assert.equal(addDaysUtc('2024-02-28', 1), '2024-02-29');
  assert.equal(addDaysUtc('2025-02-28', 1), '2025-03-01');
  assert.equal(addDaysUtc('2024-12-31', 1), '2025-01-01');
  assert.equal(addDaysUtc('2025-01-01', -1), '2024-12-31');
  assert.equal(cmpDay('2025-01-01', '2025-01-02'), -1);
  assert.equal(cmpDay('2025-01-02', '2025-01-02'), 0);
  // 2025-03-09 is the US DST switch; UTC arithmetic must not blink.
  assert.equal(addDaysUtc('2025-03-08', 1), '2025-03-09');
  assert.equal(weekdayUtc('2025-03-09'), 0); // Sunday
});

/* ------------------------------------------------------------- bar validity */

test('every bar invariant is enforced and the rejection names the source', () => {
  const where = 'aapl.us.csv:7';
  assert.equal(codeOf(() => validateBar(bar('2025-01-02', 100, 90, 95, 96), where)), 'MARKET_BAR_RANGE'); // high<low
  assert.equal(codeOf(() => validateBar(bar('2025-01-02', 100, 110, 90, 120), where)), 'MARKET_BAR_RANGE'); // close>high
  assert.equal(codeOf(() => validateBar(bar('2025-01-02', 100, 110, 90, 80), where)), 'MARKET_BAR_RANGE'); // close<low
  assert.equal(codeOf(() => validateBar(bar('2025-01-02', 130, 110, 90, 100), where)), 'MARKET_BAR_RANGE'); // open>high
  assert.equal(codeOf(() => validateBar(bar('2025-01-02', -1, 110, 90, 100), where)), 'MARKET_BAR_PRICE'); // negative
  assert.equal(codeOf(() => validateBar(bar('2025-01-02', 0, 110, 0, 100), where)), 'MARKET_BAR_PRICE'); // zero
  assert.equal(codeOf(() => validateBar({ ...bar('2025-01-02', 100, 110, 90, 100), volume: -5 }, where)), 'MARKET_BAR_VOLUME');
  assert.equal(
    codeOf(() => validateBar({ ...bar('2025-01-02', 100, 110, 90, 100), currency: 'SAR' }, where)),
    'MARKET_BAR_CURRENCY',
  );
  let msg = '';
  try {
    validateBar(bar('2025-01-02', 100, 90, 95, 96), where);
  } catch (e) {
    msg = (e as Error).message;
  }
  assert.match(msg, /^aapl\.us\.csv:7: /);
  // The valid one survives untouched.
  const good = bar('2025-01-02', 100, 110, 90, 105);
  assert.equal(validateBar(good, where), good);
});

test('a series must be strictly ascending: duplicates and rewinds are distinct refusals', () => {
  const a = bar('2025-01-02', 100, 110, 90, 105);
  assert.equal(codeOf(() => assertAscending(a, bar('2025-01-02', 100, 110, 90, 105), 'f:3')), 'MARKET_DUPLICATE_DAY');
  assert.equal(codeOf(() => assertAscending(a, bar('2025-01-01', 100, 110, 90, 105), 'f:3')), 'MARKET_OUT_OF_ORDER');
  assert.doesNotThrow(() => assertAscending(a, bar('2025-01-03', 100, 110, 90, 105), 'f:3'));
  assert.doesNotThrow(() => assertAscending(undefined, a, 'f:2'));
});

test('symbols cannot be paths, and venues cannot be invented', () => {
  assert.equal(codeOf(() => assertSymbol('../../etc/passwd', 'x')), 'MARKET_BAD_SYMBOL');
  assert.equal(codeOf(() => assertSymbol('a/b', 'x')), 'MARKET_BAD_SYMBOL');
  assert.equal(codeOf(() => assertSymbol('', 'x')), 'MARKET_BAD_SYMBOL');
  assert.equal(assertSymbol('2222.SR', 'x'), '2222.SR');
  assert.equal(assertSymbol('BRK-B', 'x'), 'BRK-B');
  assert.equal(isVenue('LSE'), false);
  assert.equal(codeOf(() => assertVenue('LSE', 'x')), 'MARKET_BAD_VENUE');
  assert.equal(VENUE_CURRENCY.US, 'USD');
  assert.equal(VENUE_CURRENCY.TADAWUL, 'SAR');
});

test('sliceDays is inclusive on both ends and refuses an inverted range', () => {
  const bars = ['2025-01-02', '2025-01-03', '2025-01-06'].map((d) => bar(d, 100, 110, 90, 105));
  assert.deepEqual(sliceDays(bars, '2025-01-03', '2025-01-06').map((b) => b.dayUtc), ['2025-01-03', '2025-01-06']);
  assert.deepEqual(sliceDays(bars, '2025-01-04', '2025-01-05'), []);
  assert.equal(codeOf(() => sliceDays(bars, '2025-01-06', '2025-01-02')), 'MARKET_BAD_RANGE');
});

/* ---------------------------------------------------------------- AsOfFeed */

test('AsOfFeed cannot return a bar after its seal, however it is asked', async () => {
  const days = ['2025-01-02', '2025-01-03', '2025-01-06', '2025-01-07'];
  const inner = new MemoryFeed(days.map((d, i) => bar(d, 100 + i, 200 + i, 50 + i, 150 + i)));
  const feed = new AsOfFeed(inner, '2025-01-03');

  const all = await feed.bars('AAPL', 'US', '2025-01-01', '2025-12-31');
  assert.deepEqual(all.map((b) => b.dayUtc), ['2025-01-02', '2025-01-03']);

  // Asking directly for a future day gets nothing, not an error the caller can ignore.
  assert.deepEqual(await feed.bars('AAPL', 'US', '2025-01-06', '2025-01-07'), []);

  // latest() is the last bar AT OR BEFORE the seal, not the newest the source holds.
  const latest = await feed.latest('AAPL', 'US');
  assert.equal(latest?.dayUtc, '2025-01-03');
  assert.equal((await inner.latest('AAPL', 'US'))?.dayUtc, '2025-01-07');

  feed.advanceTo('2025-01-06');
  assert.equal((await feed.latest('AAPL', 'US'))?.dayUtc, '2025-01-06');
  assert.equal(codeOf(() => feed.advanceTo('2025-01-02')), 'MARKET_ASOF_REWIND');
});
