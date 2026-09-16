/**
 * test/policy.test.ts — the compliance gate is attacked here: deny-by-default,
 * rule ORDER, the ToS rule that forbids autonomous buying on marketplaces that
 * demand human approval, and the bounded audit trail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine, RULES, type PolicyDecision } from '../src/governance/policy.js';
import { KillSwitch } from '../src/governance/killswitch.js';
import { loadConfig, type AresConfig, type Env } from '../src/core/config.js';
import { nullLogger } from '../src/core/logger.js';
import { money, type Money } from '../src/core/money.js';
import { PolicyDenied } from '../src/core/errors.js';
import type { ChannelAdapter, ChannelCapabilities } from '../src/channels/adapter.js';
import type { Offer, Opportunity } from '../src/core/types.js';

function cfgOf(env: Env = {}): AresConfig {
  return loadConfig({ ARES_CHANNELS: 'dataproducts,ksa_ecom', ...env });
}

/** A stand-in adapter: policy only ever reads `name` and `capabilities`. */
function adapter(name: string, caps: Partial<ChannelCapabilities> = {}): ChannelAdapter {
  const unused = (): never => {
    throw new Error('policy must not call adapter behaviour');
  };
  return {
    name,
    capabilities: {
      canBuy: true,
      canSell: true,
      buyRequiresHumanApproval: false,
      tosNote: 'simulated marketplace, PAPER only',
      jurisdiction: 'SA',
      ...caps,
    },
    init: unused,
    scan: unused,
    quote: unused,
    buy: unused,
    publish: unused,
    poll: unused,
    demandSignal: unused,
    close: unused,
  };
}

function opp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'op_1',
    channel: 'ksa_ecom',
    sku: 'SKU-1',
    title: 'thing',
    askPrice: money(1_000, 'SAR'),
    estResaleValue: money(1_800, 'SAR'),
    confidence: 0.8,
    ttlTicks: 10,
    meta: {},
    ...over,
  };
}

function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: 'of_1',
    holdingId: 'h_1',
    channel: 'ksa_ecom',
    sku: 'SKU-1',
    title: 'thing',
    price: money(1_800, 'SAR'),
    qty: 1,
    createdTick: 3,
    variant: 'A',
    meta: {},
    ...over,
  };
}

function denied(fn: () => unknown): PolicyDenied {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PolicyDenied, `expected PolicyDenied, got ${String(e)}`);
    return e;
  }
  throw new Error('expected PolicyDenied, but the call returned');
}

function last(p: PolicyEngine): PolicyDecision {
  const d = p.decisions();
  const x = d[d.length - 1];
  assert.ok(x, 'expected at least one decision');
  return x;
}

test('assertMode passes in PAPER and records the decision', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger);
  p.assertMode();
  const d = last(p);
  assert.equal(d.allowed, true);
  assert.equal(d.rule, RULES.MODE);
});

test('assertMode refuses any mode other than PAPER', () => {
  const live = { ...cfgOf(), mode: 'LIVE' as unknown as 'PAPER' };
  const p = new PolicyEngine(live, nullLogger);
  const e = denied(() => p.assertMode());
  assert.equal(e.code, 'POLICY_MODE_PAPER');
  assert.equal(last(p).allowed, false);
});

test('checkChannel admits a configured, coherent channel', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger);
  p.checkChannel(adapter('ksa_ecom'));
  assert.equal(last(p).rule, RULES.CHANNEL_OK);
});

test('checkChannel denies a channel that is not in the allow-list', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger);
  const e = denied(() => p.checkChannel(adapter('darkmarket')));
  assert.equal(e.meta?.['rule'], RULES.CHANNEL_ALLOWED);
});

test('checkChannel denies capabilities that are internally inconsistent', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger);
  const e = denied(() =>
    p.checkChannel(
      adapter('ksa_ecom', {
        canBuy: true,
        buyRequiresHumanApproval: true,
        tosNote: 'ToS: each purchase must be confirmed by a human account holder',
      }),
    ),
  );
  assert.equal(e.meta?.['rule'], RULES.CHANNEL_APPROVAL);
  assert.match(e.message, /terms of service/i);
});

test('checkChannel accepts an approval-requiring channel when an approval channel exists', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger, { approvalChannel: 'ops-inbox' });
  p.checkChannel(adapter('ksa_ecom', { canBuy: true, buyRequiresHumanApproval: true }));
  assert.equal(last(p).rule, RULES.CHANNEL_OK);
});

test('checkChannel denies a channel that can do nothing, and malformed capabilities', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger);
  assert.equal(
    denied(() => p.checkChannel(adapter('ksa_ecom', { canBuy: false, canSell: false }))).meta?.['rule'],
    RULES.CHANNEL_USELESS,
  );
  assert.equal(
    denied(() => p.checkChannel(adapter('ksa_ecom', { tosNote: '' }))).meta?.['rule'],
    RULES.CHANNEL_CAPS,
  );
  assert.equal(
    denied(() => p.checkChannel(adapter('ksa_ecom', { jurisdiction: '' }))).meta?.['rule'],
    RULES.CHANNEL_CAPS,
  );
});

test('checkBuy allows a compliant purchase and audits it', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger, { killSwitch: new KillSwitch(nullLogger) });
  p.setTick(11);
  p.checkBuy(adapter('ksa_ecom'), opp(), 2, money(2_000, 'SAR'));
  const d = last(p);
  assert.equal(d.allowed, true);
  assert.equal(d.rule, RULES.BUY_OK);
  assert.equal(d.tick, 11);
  assert.equal(d.subject, 'ksa_ecom/SKU-1');
});

test('checkBuy denies autonomous buying on a ToS-restricted marketplace', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger, { killSwitch: new KillSwitch(nullLogger) });
  const a = adapter('ksa_ecom', {
    buyRequiresHumanApproval: true,
    tosNote: 'ToS 4.2: automated purchasing without human confirmation is prohibited',
  });
  const e = denied(() => p.checkBuy(a, opp(), 1, money(1_000, 'SAR')));
  assert.equal(e.code, 'POLICY_BUY_HUMAN_APPROVAL');
  assert.equal(e.meta?.['rule'], RULES.BUY_HUMAN_APPROVAL);
  assert.match(e.message, /terms of service/i);
  assert.match(e.message, /ToS 4\.2/);
  const d = last(p);
  assert.equal(d.allowed, false);
  assert.equal(d.rule, RULES.BUY_HUMAN_APPROVAL);
});

test('checkBuy evaluates its rules in the documented order', () => {
  const ks = new KillSwitch(nullLogger);
  const p = new PolicyEngine(cfgOf(), nullLogger, { killSwitch: ks });
  // Everything below is wrong at once; the FIRST rule must be the one cited.
  const rotten = adapter('darkmarket', { canBuy: false, buyRequiresHumanApproval: true });
  const bad = (): void => p.checkBuy(rotten, opp(), -3, money(9_999_999, 'USD'));

  assert.equal(denied(bad).meta?.['rule'], RULES.BUY_CHANNEL);
  ks.trip('halted for the test');
  assert.equal(denied(bad).meta?.['rule'], RULES.BUY_KILLSWITCH, 'the halt outranks everything');
});

test('checkBuy walks down the rule list as each earlier violation is fixed', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger, { killSwitch: new KillSwitch(nullLogger) });
  assert.equal(
    denied(() => p.checkBuy(adapter('ksa_ecom', { canBuy: false }), opp(), 1, money(100, 'SAR'))).meta?.['rule'],
    RULES.BUY_CAPABILITY,
  );
  const ok = adapter('ksa_ecom');
  assert.equal(denied(() => p.checkBuy(ok, opp(), 0, money(100, 'SAR'))).meta?.['rule'], RULES.BUY_QTY);
  assert.equal(denied(() => p.checkBuy(ok, opp(), 1.5, money(100, 'SAR'))).meta?.['rule'], RULES.BUY_QTY);
  assert.equal(denied(() => p.checkBuy(ok, opp(), 1, money(100, 'USD'))).meta?.['rule'], RULES.BUY_CURRENCY);
  assert.equal(denied(() => p.checkBuy(ok, opp(), 1, money(0, 'SAR'))).meta?.['rule'], RULES.BUY_TOTAL);
  assert.equal(denied(() => p.checkBuy(ok, opp(), 1, money(5_001, 'SAR'))).meta?.['rule'], RULES.BUY_TRADE_CAP);
  p.checkBuy(ok, opp(), 1, money(5_000, 'SAR'));
  assert.equal(last(p).rule, RULES.BUY_OK, 'exactly at the cap is allowed');
});

test('checkBuy without a wired kill switch still enforces every other rule', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger);
  assert.equal(
    denied(() => p.checkBuy(adapter('ksa_ecom'), opp(), 1, money(6_000, 'SAR'))).meta?.['rule'],
    RULES.BUY_TRADE_CAP,
  );
});

test('checkSell enforces halt, channel, capability, qty and price', () => {
  const ks = new KillSwitch(nullLogger);
  const p = new PolicyEngine(cfgOf(), nullLogger, { killSwitch: ks });
  p.checkSell(adapter('ksa_ecom'), offer());
  assert.equal(last(p).rule, RULES.SELL_OK);

  assert.equal(denied(() => p.checkSell(adapter('nope'), offer())).meta?.['rule'], RULES.SELL_CHANNEL);
  assert.equal(
    denied(() => p.checkSell(adapter('ksa_ecom', { canSell: false }), offer())).meta?.['rule'],
    RULES.SELL_CAPABILITY,
  );
  assert.equal(denied(() => p.checkSell(adapter('ksa_ecom'), offer({ qty: 0 }))).meta?.['rule'], RULES.SELL_QTY);
  assert.equal(
    denied(() => p.checkSell(adapter('ksa_ecom'), offer({ price: money(0, 'SAR') }))).meta?.['rule'],
    RULES.SELL_PRICE,
  );
  assert.equal(
    denied(() => p.checkSell(adapter('ksa_ecom'), offer({ price: money(10, 'USD') as Money }))).meta?.['rule'],
    RULES.SELL_PRICE,
  );

  ks.trip('halt');
  assert.equal(denied(() => p.checkSell(adapter('ksa_ecom'), offer())).meta?.['rule'], RULES.SELL_KILLSWITCH);
});

test('every decision — allow and deny — is auditable with tick, subject, rule and reason', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger, { killSwitch: new KillSwitch(nullLogger) });
  p.setTick(4);
  p.checkBuy(adapter('ksa_ecom'), opp(), 1, money(1_000, 'SAR'));
  denied(() => p.checkBuy(adapter('ksa_ecom'), opp({ sku: 'SKU-9' }), 1, money(50_000, 'SAR')));
  const d = p.decisions();
  assert.equal(d.length, 2);
  assert.equal(d[0]?.allowed, true);
  assert.equal(d[1]?.allowed, false);
  assert.equal(d[1]?.subject, 'ksa_ecom/SKU-9');
  assert.equal(d[1]?.tick, 4);
  assert.ok((d[1]?.reason ?? '').length > 0);
  assert.deepEqual(p.stats(), { allowed: 1, denied: 1, retained: 2, capacity: 500 });
  assert.equal(p.decisions(1).length, 1);
});

test('the audit trail is a bounded ring so a 24/7 process cannot grow forever', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger, { maxDecisions: 5 });
  for (let i = 0; i < 40; i++) p.assertMode(i);
  const d = p.decisions();
  assert.equal(d.length, 5);
  assert.equal(d[4]?.tick, 39, 'the newest decision is kept');
  assert.equal(d[0]?.tick, 35, 'the oldest was dropped');
  assert.equal(p.stats().allowed, 40, 'counters survive the ring');
});

test('decisions() hands back copies, so the audit trail cannot be edited', () => {
  const p = new PolicyEngine(cfgOf(), nullLogger);
  p.assertMode(1);
  const d = p.decisions();
  const row = d[0];
  assert.ok(row);
  row.allowed = false;
  row.reason = 'tampered';
  assert.equal(p.decisions()[0]?.allowed, true);
  assert.equal(p.decisions()[0]?.reason !== 'tampered', true);
});
