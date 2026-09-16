/**
 * core/money.ts — integer minor-unit money. NO FLOATS EVER LEAVE THIS MODULE.
 * Invariant: `amount` is always a safe integer count of minor units (halalas /
 * cents); every binary op refuses mixed currencies; mul rounds half AWAY FROM ZERO.
 * Callers: ledger, budget governor, agents, adapters, api.
 */

import { AresError } from './errors.js';

export type Minor = number;
export type Currency = 'SAR' | 'USD';

export interface Money {
  readonly amount: Minor;
  readonly currency: Currency;
}

const CURRENCIES: readonly Currency[] = ['SAR', 'USD'];
/** Minor units per major unit, per currency. Both are 2-decimal currencies. */
const EXPONENT: Record<Currency, number> = { SAR: 2, USD: 2 };

export function isCurrency(c: unknown): c is Currency {
  return typeof c === 'string' && (CURRENCIES as readonly string[]).includes(c);
}

export function money(amount: Minor, c: Currency): Money {
  if (!Number.isSafeInteger(amount)) {
    throw new AresError('INVALID_MONEY', `money(): amount must be a safe integer minor unit, got ${String(amount)}`, {
      amount,
      currency: c,
    });
  }
  if (!isCurrency(c)) {
    throw new AresError('INVALID_CURRENCY', `money(): unknown currency ${String(c)}`, { currency: c });
  }
  return Object.freeze({ amount, currency: c });
}

export function zero(c: Currency): Money {
  return money(0, c);
}

function assertSame(a: Money, b: Money, op: string): void {
  if (a.currency !== b.currency) {
    throw new AresError('CURRENCY_MISMATCH', `${op}(): ${a.currency} vs ${b.currency}`, {
      a: a.currency,
      b: b.currency,
      op,
    });
  }
}

export function add(a: Money, b: Money): Money {
  assertSame(a, b, 'add');
  return money(a.amount + b.amount, a.currency);
}

export function sub(a: Money, b: Money): Money {
  assertSame(a, b, 'sub');
  return money(a.amount - b.amount, a.currency);
}

/**
 * Scale by a real number, rounding the integer result HALF AWAY FROM ZERO.
 * mul(money(-5,'SAR'), 0.5) === -3   (NOT -2, which Math.round would give)
 */
export function mul(a: Money, scalar: number): Money {
  if (!Number.isFinite(scalar)) {
    throw new AresError('INVALID_SCALAR', `mul(): scalar must be finite, got ${String(scalar)}`, { scalar });
  }
  return money(roundHalfAwayFromZero(a.amount * scalar), a.currency);
}

export function roundHalfAwayFromZero(x: number): number {
  if (!Number.isFinite(x)) {
    throw new AresError('INVALID_SCALAR', `roundHalfAwayFromZero(): non-finite ${String(x)}`, { x });
  }
  const sign = x < 0 ? -1 : 1;
  const r = Math.round(Math.abs(x));
  const out = sign * r;
  // -0 is a footgun in ledger equality checks; normalise it away.
  return out === 0 ? 0 : out;
}

export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b, 'cmp');
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

export function isNeg(m: Money): boolean {
  return m.amount < 0;
}

export function isZero(m: Money): boolean {
  return m.amount === 0;
}

export function neg(m: Money): Money {
  return money(-m.amount, m.currency);
}

export function abs(m: Money): Money {
  return money(Math.abs(m.amount), m.currency);
}

/** "SAR 1,234.56" / "SAR -1,234.56". */
export function fmt(m: Money): string {
  const exp = EXPONENT[m.currency];
  const neg = m.amount < 0;
  const digits = Math.abs(m.amount).toString().padStart(exp + 1, '0');
  const whole = digits.slice(0, digits.length - exp);
  const frac = digits.slice(digits.length - exp);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${m.currency} ${neg ? '-' : ''}${grouped}.${frac}`;
}

/**
 * Convert via an explicit rate table. Accepted key spellings for SAR->USD:
 * "SAR->USD", "SAR_USD", "SARUSD", "SAR/USD". Same-currency is the identity.
 * Rounds half away from zero, like mul.
 */
export function convert(m: Money, to: Currency, rates: Record<string, number>): Money {
  if (!isCurrency(to)) {
    throw new AresError('INVALID_CURRENCY', `convert(): unknown target currency ${String(to)}`, { to });
  }
  if (m.currency === to) return m;
  const keys = [`${m.currency}->${to}`, `${m.currency}_${to}`, `${m.currency}${to}`, `${m.currency}/${to}`];
  let rate: number | undefined;
  for (const k of keys) {
    const v = rates[k];
    if (typeof v === 'number') {
      rate = v;
      break;
    }
  }
  if (rate === undefined) {
    // Try the inverse direction before giving up.
    const inv = [`${to}->${m.currency}`, `${to}_${m.currency}`, `${to}${m.currency}`, `${to}/${m.currency}`];
    for (const k of inv) {
      const v = rates[k];
      if (typeof v === 'number' && v !== 0) {
        rate = 1 / v;
        break;
      }
    }
  }
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
    throw new AresError('RATE_MISSING', `convert(): no usable rate ${m.currency}->${to}`, {
      from: m.currency,
      to,
      tried: keys,
    });
  }
  return money(roundHalfAwayFromZero(m.amount * rate), to);
}
