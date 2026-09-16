/**
 * test/money.test.ts — integer-money invariants.
 * Focus: half-away-from-zero rounding (including negatives), currency mismatch
 * refusal, safe-integer enforcement, formatting and conversion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AresError } from '../src/core/errors.js';
import {
  abs,
  add,
  cmp,
  convert,
  fmt,
  isNeg,
  isZero,
  money,
  mul,
  neg,
  roundHalfAwayFromZero,
  sub,
  zero,
} from '../src/core/money.js';

test('money() rejects non-integers and unsafe integers', () => {
  assert.throws(() => money(1.5, 'SAR'), (e: unknown) => e instanceof AresError && e.code === 'INVALID_MONEY');
  assert.throws(() => money(NaN, 'SAR'), (e: unknown) => e instanceof AresError && e.code === 'INVALID_MONEY');
  assert.throws(
    () => money(Number.MAX_SAFE_INTEGER + 2, 'SAR'),
    (e: unknown) => e instanceof AresError && e.code === 'INVALID_MONEY',
  );
  // @ts-expect-error adversarial: unknown currency at runtime
  assert.throws(() => money(1, 'EUR'), (e: unknown) => e instanceof AresError && e.code === 'INVALID_CURRENCY');
});

test('money values are frozen', () => {
  const m = money(100, 'SAR');
  assert.ok(Object.isFrozen(m));
});

test('add/sub/cmp refuse mixed currencies', () => {
  const s = money(100, 'SAR');
  const u = money(100, 'USD');
  for (const f of [() => add(s, u), () => sub(s, u), () => cmp(s, u)]) {
    assert.throws(f, (e: unknown) => e instanceof AresError && e.code === 'CURRENCY_MISMATCH');
  }
});

test('add/sub are exact integer arithmetic', () => {
  assert.equal(add(money(199, 'SAR'), money(1, 'SAR')).amount, 200);
  assert.equal(sub(money(1, 'SAR'), money(200, 'SAR')).amount, -199);
  assert.equal(zero('USD').amount, 0);
  assert.equal(zero('USD').currency, 'USD');
});

test('mul rounds HALF AWAY FROM ZERO on negatives (the Math.round trap)', () => {
  // The spec case: -5 * 0.5 = -2.5 -> -3, NOT Math.round's -2.
  assert.equal(mul(money(-5, 'SAR'), 0.5).amount, -3);
  assert.equal(mul(money(5, 'SAR'), 0.5).amount, 3);
  assert.equal(mul(money(-7, 'SAR'), 0.5).amount, -4); // -3.5 -> -4
  assert.equal(mul(money(7, 'SAR'), 0.5).amount, 4);
  assert.equal(mul(money(-1, 'SAR'), 0.5).amount, -1); // -0.5 -> -1
  assert.equal(mul(money(1, 'SAR'), 0.5).amount, 1);
  assert.equal(mul(money(-3, 'SAR'), 0.5).amount, -2); // -1.5 -> -2
});

test('mul never produces -0 and preserves currency', () => {
  const r = mul(money(-1, 'USD'), 0);
  assert.equal(r.amount, 0);
  assert.ok(!Object.is(r.amount, -0));
  assert.equal(r.currency, 'USD');
});

test('mul rejects non-finite scalars', () => {
  assert.throws(
    () => mul(money(10, 'SAR'), Infinity),
    (e: unknown) => e instanceof AresError && e.code === 'INVALID_SCALAR',
  );
  assert.throws(() => mul(money(10, 'SAR'), NaN), (e: unknown) => e instanceof AresError);
});

test('roundHalfAwayFromZero direct cases', () => {
  assert.equal(roundHalfAwayFromZero(2.5), 3);
  assert.equal(roundHalfAwayFromZero(-2.5), -3);
  assert.equal(roundHalfAwayFromZero(2.4), 2);
  assert.equal(roundHalfAwayFromZero(-2.4), -2);
  assert.equal(roundHalfAwayFromZero(-0.4), 0);
});

test('cmp / isNeg / isZero / neg / abs', () => {
  assert.equal(cmp(money(1, 'SAR'), money(2, 'SAR')), -1);
  assert.equal(cmp(money(2, 'SAR'), money(2, 'SAR')), 0);
  assert.equal(cmp(money(3, 'SAR'), money(2, 'SAR')), 1);
  assert.equal(isNeg(money(-1, 'SAR')), true);
  assert.equal(isNeg(money(0, 'SAR')), false);
  assert.equal(isZero(money(0, 'SAR')), true);
  assert.equal(neg(money(-5, 'SAR')).amount, 5);
  assert.equal(abs(money(-5, 'SAR')).amount, 5);
});

test('fmt groups thousands and handles small/negative amounts', () => {
  assert.equal(fmt(money(123456, 'SAR')), 'SAR 1,234.56');
  assert.equal(fmt(money(-123456, 'SAR')), 'SAR -1,234.56');
  assert.equal(fmt(money(0, 'USD')), 'USD 0.00');
  assert.equal(fmt(money(5, 'USD')), 'USD 0.05');
  assert.equal(fmt(money(100000000, 'SAR')), 'SAR 1,000,000.00');
});

test('convert is identity for same currency and uses the rate table', () => {
  const m = money(1000, 'SAR');
  assert.equal(convert(m, 'SAR', {}).amount, 1000);
  assert.equal(convert(m, 'USD', { 'SAR->USD': 0.2666 }).amount, 267); // 266.6 -> 267
  assert.equal(convert(money(-1000, 'SAR'), 'USD', { SAR_USD: 0.2665 }).amount, -267); // -266.5 -> -267
  // Inverse lookup.
  assert.equal(convert(money(100, 'USD'), 'SAR', { 'SAR->USD': 0.25 }).amount, 400);
});

test('convert throws when no rate is available', () => {
  assert.throws(
    () => convert(money(100, 'SAR'), 'USD', {}),
    (e: unknown) => e instanceof AresError && e.code === 'RATE_MISSING',
  );
});
