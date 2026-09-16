/**
 * test/budget.test.ts — the reservation protocol under attack: fail-closed
 * denial codes, double-spend of the same riyal, over-commit, settle-twice,
 * token pricing that must round UP, reallocation and drawdown. Real Ledger on a
 * temp dir, TestClock, no mocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetGovernor, BudgetDeny, tokenCostMinor } from '../src/governance/budget.js';
import { KillSwitch } from '../src/governance/killswitch.js';
import { Ledger } from '../src/core/ledger.js';
import { TestClock } from '../src/core/clock.js';
import { nullLogger } from '../src/core/logger.js';
import { loadConfig, type AresConfig, type Env } from '../src/core/config.js';
import { BudgetDenied } from '../src/core/errors.js';

interface Harness {
  cfg: AresConfig;
  ledger: Ledger;
  ks: KillSwitch;
  gov: BudgetGovernor;
  clock: TestClock;
  dir: string;
  close(): void;
}

function harness(env: Env = {}, agents: string[] = ['a1', 'a2']): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ares-budget-'));
  const cfg = loadConfig({ ARES_DATA_DIR: dir, ...env });
  const clock = new TestClock(1_000);
  const ledger = Ledger.open(dir, clock, nullLogger);
  const ks = new KillSwitch(nullLogger, clock);
  const gov = new BudgetGovernor(cfg, ledger, nullLogger, ks);
  gov.bootstrap(0);
  for (const a of agents) gov.register(a);
  return {
    cfg,
    ledger,
    ks,
    gov,
    clock,
    dir,
    close(): void {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function denial(fn: () => unknown): BudgetDenied {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof BudgetDenied, `expected BudgetDenied, got ${String(e)}`);
    return e;
  }
  throw new Error('expected BudgetDenied, but the call returned');
}

test('bootstrap books the opening balance once and is idempotent', () => {
  const h = harness();
  try {
    assert.equal(h.gov.cashOnHand(), 100_000);
    const size = h.ledger.size();
    h.gov.bootstrap(0);
    h.gov.bootstrap(5);
    assert.equal(h.ledger.size(), size);
    assert.equal(h.gov.drawdownMinor(), 0);
  } finally {
    h.close();
  }
});

test('reserve then commit moves outstanding into spent', () => {
  const h = harness();
  try {
    assert.equal(h.gov.availableCash('a1'), 25_000);
    const r = h.gov.reserve('a1', 'cash', 4_000, 1);
    assert.equal(r.agentId, 'a1');
    assert.equal(r.amount, 4_000);
    assert.equal(h.gov.availableCash('a1'), 21_000, 'an open reservation reduces availability');
    h.gov.commit(r, 4_000, { note: 'bought' });
    assert.equal(h.gov.availableCash('a1'), 21_000, 'committed spend keeps the headroom consumed');
    assert.equal(h.gov.openReservations('a1').length, 0);
  } finally {
    h.close();
  }
});

test('committing less than reserved returns the slack', () => {
  const h = harness();
  try {
    const r = h.gov.reserve('a1', 'cash', 4_000, 1);
    h.gov.commit(r, 1_500);
    assert.equal(h.gov.availableCash('a1'), 23_500);
  } finally {
    h.close();
  }
});

test('reserve fails CLOSED once the kill switch is tripped', () => {
  const h = harness();
  try {
    h.ks.trip('treasury: drawdown');
    const e = denial(() => h.gov.reserve('a1', 'cash', 10, 1));
    assert.equal(e.code, BudgetDeny.HALTED);
  } finally {
    h.close();
  }
});

test('a halted swarm reports no spendable budget, but still settles in-flight work', () => {
  const h = harness();
  try {
    const r = h.gov.reserve('a1', 'cash', 1_000, 1);
    const tok = h.gov.reserve('a1', 'tokens', 1_000, 1);
    h.ks.trip('treasury: integrity');
    assert.equal(h.gov.availableCash('a1'), 0);
    assert.equal(h.gov.availableTokens('a1'), 0);
    // Settling what is already in flight must never be blocked by the halt.
    assert.doesNotThrow(() => h.gov.commit(r, 1_000));
    assert.doesNotThrow(() => h.gov.release(tok));
  } finally {
    h.close();
  }
});

test('reserve refuses unknown and terminated agents', () => {
  const h = harness();
  try {
    assert.equal(denial(() => h.gov.reserve('ghost', 'cash', 10, 1)).code, BudgetDeny.UNKNOWN_AGENT);
    h.gov.terminateAgent('a2', 'survival');
    assert.equal(denial(() => h.gov.reserve('a2', 'cash', 10, 1)).code, BudgetDeny.AGENT_TERMINATED);
    assert.equal(h.gov.availableCash('a2'), 0);
  } finally {
    h.close();
  }
});

test('reserve refuses non-positive and non-integer amounts', () => {
  const h = harness();
  try {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(denial(() => h.gov.reserve('a1', 'cash', bad, 1)).code, BudgetDeny.INVALID_AMOUNT, `amount ${bad}`);
    }
  } finally {
    h.close();
  }
});

test('reserve refuses an unknown resource', () => {
  const h = harness();
  try {
    // Deliberate contract violation from untyped callers (api / json).
    const bad = 'gold' as unknown as 'cash';
    assert.equal(denial(() => h.gov.reserve('a1', bad, 10, 1)).code, BudgetDeny.INVALID_RESOURCE);
  } finally {
    h.close();
  }
});

test('the per-trade cap bites before anything else', () => {
  const h = harness();
  try {
    const e = denial(() => h.gov.reserve('a1', 'cash', 5_001, 1));
    assert.equal(e.code, BudgetDeny.TRADE_CAP);
  } finally {
    h.close();
  }
});

test('the per-agent cap counts spent AND outstanding', () => {
  const h = harness({ ARES_AGENT_CASH_CAP: '8000', ARES_TRADE_CAP: '5000' });
  try {
    h.gov.reserve('a1', 'cash', 5_000, 1);
    const e = denial(() => h.gov.reserve('a1', 'cash', 5_000, 1));
    assert.equal(e.code, BudgetDeny.AGENT_CAP);
    assert.equal(h.gov.availableCash('a1'), 3_000);
  } finally {
    h.close();
  }
});

test('the global cash cap stops two agents jointly overspending', () => {
  const h = harness({
    ARES_CASH_CAP: '6000',
    ARES_STARTING_CASH: '6000',
    ARES_AGENT_CASH_CAP: '5000',
    ARES_TRADE_CAP: '5000',
  });
  try {
    h.gov.reserve('a1', 'cash', 4_000, 1);
    const e = denial(() => h.gov.reserve('a2', 'cash', 4_000, 1));
    assert.equal(e.code, BudgetDeny.GLOBAL_CAP);
  } finally {
    h.close();
  }
});

test('DOUBLE SPEND: an outstanding reservation is invisible cash to everyone else', () => {
  const h = harness({ ARES_STARTING_CASH: '6000' });
  try {
    const r = h.gov.reserve('a1', 'cash', 4_000, 7);
    assert.equal(h.gov.availableCash('a2'), 2_000, 'a2 only sees unreserved cash');
    const e = denial(() => h.gov.reserve('a2', 'cash', 4_000, 7));
    assert.equal(e.code, BudgetDeny.INSUFFICIENT_CASH);
    assert.equal(e.meta?.['free'], 2_000);

    // Releasing a1's claim hands the money straight back to a2.
    h.gov.release(r);
    assert.equal(h.gov.availableCash('a2'), 6_000);
    const r2 = h.gov.reserve('a2', 'cash', 4_000, 7);
    assert.equal(r2.amount, 4_000);
  } finally {
    h.close();
  }
});

test('commit refuses to spend more than was reserved and leaves the reservation open', () => {
  const h = harness();
  try {
    const r = h.gov.reserve('a1', 'cash', 1_000, 1);
    const e = denial(() => h.gov.commit(r, 1_001));
    assert.equal(e.code, BudgetDeny.OVERSPEND);
    assert.equal(h.gov.openReservations('a1').length, 1, 'a rejected commit must not settle the reservation');
    h.gov.commit(r, 1_000);
    assert.equal(h.gov.openReservations('a1').length, 0);
  } finally {
    h.close();
  }
});

test('commit refuses negative or non-integer actuals', () => {
  const h = harness();
  try {
    const r = h.gov.reserve('a1', 'cash', 1_000, 1);
    assert.equal(denial(() => h.gov.commit(r, -1)).code, BudgetDeny.INVALID_AMOUNT);
    assert.equal(denial(() => h.gov.commit(r, 10.5)).code, BudgetDeny.INVALID_AMOUNT);
  } finally {
    h.close();
  }
});

test('a reservation settles exactly once, whichever way it settles', () => {
  const h = harness();
  try {
    const a = h.gov.reserve('a1', 'cash', 1_000, 1);
    h.gov.commit(a, 1_000);
    assert.equal(denial(() => h.gov.commit(a, 1_000)).code, BudgetDeny.RESERVATION_SETTLED);
    assert.equal(denial(() => h.gov.release(a)).code, BudgetDeny.RESERVATION_SETTLED);

    const b = h.gov.reserve('a1', 'cash', 1_000, 1);
    h.gov.release(b);
    assert.equal(denial(() => h.gov.release(b)).code, BudgetDeny.RESERVATION_SETTLED);
    assert.equal(denial(() => h.gov.commit(b, 1)).code, BudgetDeny.RESERVATION_SETTLED);

    const forged = { id: 'res_00000099_a1', agentId: 'a1', resource: 'cash' as const, amount: 1, tick: 1 };
    assert.equal(denial(() => h.gov.commit(forged, 1)).code, BudgetDeny.UNKNOWN_RESERVATION);
    assert.equal(denial(() => h.gov.release(forged)).code, BudgetDeny.UNKNOWN_RESERVATION);
  } finally {
    h.close();
  }
});

test('token reservations obey the per-agent and global token caps', () => {
  const h = harness({ ARES_TOKEN_CAP: '600000', ARES_AGENT_TOKEN_CAP: '500000' });
  try {
    assert.equal(h.gov.availableTokens('a1'), 500_000);
    assert.equal(denial(() => h.gov.reserve('a1', 'tokens', 500_001, 1)).code, BudgetDeny.AGENT_CAP);
    h.gov.reserve('a1', 'tokens', 400_000, 1);
    assert.equal(h.gov.availableTokens('a1'), 100_000);
    assert.equal(h.gov.availableTokens('a2'), 200_000, 'outstanding tokens are gone from the global pool too');
    assert.equal(denial(() => h.gov.reserve('a2', 'tokens', 400_000, 1)).code, BudgetDeny.GLOBAL_CAP);
  } finally {
    h.close();
  }
});

test('committing a token reservation prices it into the ledger (compute debit / cash credit)', () => {
  const h = harness();
  try {
    const r = h.gov.reserve('a1', 'tokens', 400_000, 3);
    h.gov.commit(r, 400_000);
    const b = h.ledger.balances();
    assert.equal(b.compute, 750, '400k tokens at 1875 minor/MTok = 750');
    assert.equal(b.cash, 100_000 - 750);
    const e = h.ledger.entries({ type: 'TOKEN_SPEND' });
    assert.equal(e.length, 1);
    assert.equal(e[0]?.agentId, 'a1');
    assert.equal(e[0]?.tick, 3);
    assert.equal(h.gov.availableTokens('a1'), 100_000);
  } finally {
    h.close();
  }
});

test('token cost uses integer maths and always rounds UP', () => {
  assert.equal(tokenCostMinor(0, 1875), 0);
  assert.equal(tokenCostMinor(1, 1875), 1, 'never under-charge a fractional halala');
  assert.equal(tokenCostMinor(533, 1875), 1);
  assert.equal(tokenCostMinor(1_000_000, 1875), 1875);
  assert.equal(tokenCostMinor(1_000_001, 1875), 1876);
  assert.equal(tokenCostMinor(400_000, 1875), 750);
  assert.equal(tokenCostMinor(12_345, 0), 0);
  assert.throws(() => tokenCostMinor(-1, 1875), BudgetDenied);
  assert.throws(() => tokenCostMinor(1.5, 1875), BudgetDenied);
});

test('chargeTokens debits compute, credits cash and rejects bad inputs', () => {
  const h = harness();
  try {
    h.gov.chargeTokens('a1', 1, 2, 'sonnet');
    assert.equal(h.ledger.balanceOf('compute'), 1);
    assert.equal(h.ledger.balanceOf('cash'), 99_999);
    h.gov.chargeTokens('a1', 0, 2);
    assert.equal(h.ledger.size(), 2, 'a zero charge writes nothing');
    assert.equal(denial(() => h.gov.chargeTokens('a1', -5, 2)).code, BudgetDeny.INVALID_AMOUNT);
    assert.equal(denial(() => h.gov.chargeTokens('ghost', 5, 2)).code, BudgetDeny.UNKNOWN_AGENT);
    assert.equal(h.gov.availableTokens('a1'), 500_000 - 1);
  } finally {
    h.close();
  }
});

test('chargeTokens is idempotent per (agent, tick, call) across a replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ares-budget-idem-'));
  const cfg = loadConfig({ ARES_DATA_DIR: dir });
  const clock = new TestClock(1_000);
  try {
    const l1 = Ledger.open(dir, clock, nullLogger);
    const g1 = new BudgetGovernor(cfg, l1, nullLogger, new KillSwitch(nullLogger, clock));
    g1.bootstrap(0);
    g1.register('a1');
    g1.chargeTokens('a1', 1_000_000, 4, 'sonnet');
    g1.chargeTokens('a1', 1_000_000, 4, 'sonnet');
    assert.equal(l1.entries({ type: 'TOKEN_SPEND' }).length, 2, 'two distinct calls charge twice');
    const size = l1.size();
    const cash = l1.balanceOf('cash');
    l1.close();

    // Crash + restart: the identical call sequence must not double-charge.
    const l2 = Ledger.open(dir, clock, nullLogger);
    const g2 = new BudgetGovernor(cfg, l2, nullLogger, new KillSwitch(nullLogger, clock));
    g2.bootstrap(0);
    g2.register('a1');
    g2.chargeTokens('a1', 1_000_000, 4, 'sonnet');
    g2.chargeTokens('a1', 1_000_000, 4, 'sonnet');
    assert.equal(l2.size(), size, 'replayed charges are suppressed by idempotency key');
    assert.equal(l2.balanceOf('cash'), cash);
    l2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reallocate releases the source reservations and moves the remaining caps', () => {
  const h = harness();
  try {
    const spent = h.gov.reserve('a1', 'cash', 5_000, 1);
    h.gov.commit(spent, 5_000);
    h.gov.reserve('a1', 'cash', 4_000, 1);
    assert.equal(h.gov.openReservations('a1').length, 1);

    const moved = h.gov.reallocate('a1', 'a2');
    assert.equal(moved.cash, 20_000, '25000 cap - 5000 spent');
    assert.equal(moved.tokens, 500_000);
    assert.equal(h.gov.openReservations('a1').length, 0, 'in-flight claims die with the agent');
    assert.equal(h.gov.availableCash('a1'), 0);
    assert.equal(h.gov.availableCash('a2'), 45_000, 'a2 now holds its own 25000 plus a1\'s unspent 20000');
  } finally {
    h.close();
  }
});

test('reallocate never lifts the target above the global cap', () => {
  const h = harness({
    ARES_CASH_CAP: '30000',
    ARES_STARTING_CASH: '30000',
    ARES_AGENT_CASH_CAP: '25000',
  });
  try {
    const moved = h.gov.reallocate('a1', 'a2');
    assert.equal(moved.cash, 5_000, 'target was at 25000, global cap 30000');
    const snap = h.gov.snapshot();
    const a2 = snap.agents.find((a) => a.agentId === 'a2');
    assert.equal(a2?.cashCapMinor, 30_000);
  } finally {
    h.close();
  }
});

test('reallocate refuses self, unknown agents and terminated targets', () => {
  const h = harness();
  try {
    assert.equal(denial(() => h.gov.reallocate('a1', 'a1')).code, BudgetDeny.REALLOCATE_SELF);
    assert.equal(denial(() => h.gov.reallocate('ghost', 'a1')).code, BudgetDeny.UNKNOWN_AGENT);
    h.gov.terminateAgent('a2', 'dead');
    assert.equal(denial(() => h.gov.reallocate('a1', 'a2')).code, BudgetDeny.AGENT_TERMINATED);
  } finally {
    h.close();
  }
});

test('register refuses duplicates and empty ids', () => {
  const h = harness();
  try {
    assert.equal(denial(() => h.gov.register('a1')).code, BudgetDeny.DUPLICATE_AGENT);
    assert.equal(denial(() => h.gov.register('')).code, BudgetDeny.UNKNOWN_AGENT);
  } finally {
    h.close();
  }
});

test('setCaps never drops a cap below what the agent already spent', () => {
  const h = harness();
  try {
    const r = h.gov.reserve('a1', 'cash', 5_000, 1);
    h.gov.commit(r, 5_000);
    h.gov.setCaps('a1', { cashCapMinor: 1_000 });
    const a1 = h.gov.snapshot().agents.find((a) => a.agentId === 'a1');
    assert.equal(a1?.cashCapMinor, 5_000);
    h.gov.setCaps('a1', { cashCapMinor: 12_500 });
    assert.equal(h.gov.availableCash('a1'), 7_500, 'probation halving takes effect');
  } finally {
    h.close();
  }
});

test('drawdown is starting cash minus the ledger, never negative', () => {
  const h = harness();
  try {
    assert.equal(h.gov.drawdownMinor(), 0);
    h.gov.chargeTokens('a1', 400_000, 1);
    assert.equal(h.gov.drawdownMinor(), 750);
    h.ledger.append({
      tick: 2,
      type: 'SALE',
      agentId: 'a1',
      currency: 'SAR',
      legs: [
        { account: 'cash', amount: 5_000 },
        { account: 'revenue', amount: -5_000 },
      ],
      idempotencyKey: 'sale-1',
      meta: {},
    });
    assert.equal(h.gov.cashOnHand(), 104_250);
    assert.equal(h.gov.drawdownMinor(), 0, 'a profit is not a negative drawdown');
  } finally {
    h.close();
  }
});

test('snapshot reports the halt state, outstanding reservations and per-agent rows', () => {
  const h = harness();
  try {
    h.gov.reserve('a1', 'cash', 2_000, 1);
    const s = h.gov.snapshot();
    assert.equal(s.halted, false);
    assert.equal(s.reservationsOpen, 1);
    assert.equal(s.cash.outstandingMinor, 2_000);
    assert.equal(s.cash.onHandMinor, 100_000);
    assert.equal(s.agents.length, 2);
    h.ks.trip('manual');
    assert.equal(h.gov.snapshot().halted, true);
  } finally {
    h.close();
  }
});
