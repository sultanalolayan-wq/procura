/**
 * test/orchestrator.test.ts — the boot contract. Everything here is about
 * REFUSING to come up half-safe: no usable channel, an unauthenticated public
 * API bind, a policy engine that is not consulting the kill switch.
 * Deterministic: TestClock, temp dirs, the API never binds unless the test
 * says so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TestClock } from '../src/core/clock.js';
import { loadConfig, type AresConfig, type Env } from '../src/core/config.js';
import { AresError } from '../src/core/errors.js';
import { nullLogger } from '../src/core/logger.js';
import { policyKillSwitch } from '../src/agents/base.js';
import { bootstrap, type Ares } from '../src/runtime/orchestrator.js';

interface Fixture {
  dir: string;
  cfg: AresConfig;
  clock: TestClock;
  cleanup: () => void;
}

function fixture(env: Env = {}, patch: (c: AresConfig) => AresConfig = (c) => c): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ares-boot-'));
  const cfg = patch(loadConfig({ ARES_DATA_DIR: dir, ARES_TICK_MS: '1000', ...env }));
  return {
    dir,
    cfg,
    clock: new TestClock(1_000),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function boot(f: Fixture): Promise<Ares> {
  return bootstrap(f.cfg, { clock: f.clock, logger: nullLogger, startApi: false });
}

test('bootstrap wires the swarm in dependency order and opens the books', async () => {
  const f = fixture();
  let ares: Ares | null = null;
  try {
    ares = await boot(f);

    // The opening entry exists, so drawdown is measured against something real.
    assert.equal(ares.ledger.size(), 1, 'budget.bootstrap() wrote the opening cash/equity entry');
    assert.equal(ares.budget.cashOnHand(), f.cfg.budget.startingCashMinor);
    assert.equal(ares.budget.drawdownMinor(), 0);
    assert.equal(ares.ledger.verify().ok, true);

    // The policy engine is consulting exactly the swarm's kill switch. A
    // mismatch here would mean a halted swarm that keeps trading.
    assert.equal(policyKillSwitch(ares.policy), ares.killSwitch);

    const roles = ares.registry.all().map((a) => a.role).sort();
    assert.deepEqual(roles, ['scout', 'seller', 'treasury']);
    assert.ok(ares.registry.strategies('scout').length > 1, 'a respawn menu exists for the scout');
    assert.ok(ares.registry.strategies('seller').length > 1);
    assert.equal(ares.treasury.role, 'treasury');
  } finally {
    if (ares) await ares.shutdown('test over');
    f.cleanup();
  }
});

test('only channels that pass policy.checkChannel are registered; the rest are rejected and logged', async () => {
  const f = fixture();
  let ares: Ares | null = null;
  try {
    ares = await boot(f);
    // ksa_ecom declares canBuy AND buyRequiresHumanApproval with no approval
    // channel configured, so the policy engine refuses it at the gate. It must
    // never reach the channel map.
    assert.deepEqual([...ares.channels.keys()].sort(), ['dataproducts', 'digitalassets']);
    assert.equal(ares.channels.has('ksa_ecom'), false);
    const rej = ares.rejectedChannels.find((r) => r.name === 'ksa_ecom');
    assert.ok(rej, 'the rejection is recorded, not swallowed');
    assert.match(rej.reason, /approval/i);
    assert.match(rej.code, /^POLICY_/);
  } finally {
    if (ares) await ares.shutdown('test over');
    f.cleanup();
  }
});

test('booting with zero usable channels is a loud refusal, not a silently idle swarm', async () => {
  const f = fixture({ ARES_CHANNELS: 'ksa_ecom' });
  try {
    await assert.rejects(
      () => boot(f),
      (err: unknown) => {
        assert.ok(err instanceof AresError);
        assert.equal(err.code, 'BOOT_NO_USABLE_CHANNELS');
        assert.match(err.message, /idle, not safe/);
        return true;
      },
    );
  } finally {
    f.cleanup();
  }
});

test('a channel with no adapter is refused rather than quietly ignored', async () => {
  const f = fixture({ ARES_CHANNELS: 'not_a_real_channel' });
  try {
    await assert.rejects(() => boot(f), /BOOT_NO_USABLE_CHANNELS|no usable/i);
  } finally {
    f.cleanup();
  }
});

test('the API refuses to bind a non-loopback host with no token, and bootstrap fails with it', async () => {
  const f = fixture({ ARES_API_HOST: '0.0.0.0' });
  try {
    await assert.rejects(
      () => bootstrap(f.cfg, { clock: f.clock, logger: nullLogger, startApi: false }),
      (err: unknown) => {
        assert.ok(err instanceof AresError);
        assert.equal(err.code, 'API_UNAUTHENTICATED_PUBLIC_BIND');
        return true;
      },
    );
  } finally {
    f.cleanup();
  }
});

test('a non-loopback host WITH a token boots', async () => {
  const f = fixture({ ARES_API_HOST: '0.0.0.0', ARES_API_TOKEN: 'a-long-operator-secret' });
  let ares: Ares | null = null;
  try {
    ares = await bootstrap(f.cfg, { clock: f.clock, logger: nullLogger, startApi: false });
    assert.ok(ares.api);
  } finally {
    if (ares) await ares.shutdown('test over');
    f.cleanup();
  }
});

test('the HALT file watcher is armed at boot', async () => {
  const f = fixture();
  let ares: Ares | null = null;
  try {
    ares = await bootstrap(f.cfg, {
      clock: f.clock,
      logger: nullLogger,
      startApi: false,
      haltWatchIntervalMs: 100,
    });
    assert.equal(ares.killSwitch.tripped, false);
    writeFileSync(join(f.dir, 'HALT'), 'operator halt\n', 'utf8');
    f.clock.advance(200);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(ares.killSwitch.tripped, true);
    assert.match(String(ares.killSwitch.reason), /halt file/i);
  } finally {
    if (ares) await ares.shutdown('test over');
    f.cleanup();
  }
});

test('the bootstrapped swarm actually ticks, and the books survive it', async () => {
  const f = fixture({ ARES_WINDOW_TICKS: '5' });
  let ares: Ares | null = null;
  try {
    ares = await boot(f);
    for (let t = 0; t < 12; t++) {
      await ares.supervisor.runTick(t);
      f.clock.advance(1_000);
    }
    assert.equal(ares.ledger.verify().ok, true, 'the hash chain survived real traffic');
    assert.ok(ares.ledger.size() > 1, 'something actually happened');
    assert.ok(ares.treasury.stats().audits >= 1, 'the auditor audited');
    assert.ok(ares.bus.stats().published > 0);
    for (const a of ares.registry.all()) {
      assert.equal(a.crashes, 0, `${a.id} crashed: ${String(a.snapshot().lastError)}`);
    }
  } finally {
    if (ares) await ares.shutdown('test over');
    f.cleanup();
  }
});

test('shutdown is idempotent, closes the adapters and leaves a verifiable ledger', async () => {
  const f = fixture();
  const ares = await boot(f);
  try {
    await ares.supervisor.runTick(0);
    const closed: string[] = [];
    for (const [name, a] of ares.channels) {
      const orig = a.close.bind(a);
      (a as unknown as { close: () => Promise<void> }).close = async () => {
        closed.push(name);
        await orig();
      };
    }
    const p1 = ares.shutdown('first');
    const p2 = ares.shutdown('second');
    assert.equal(p1, p2, 'both callers await the same shutdown');
    await p1;
    await p2;
    assert.deepEqual(closed.sort(), ['dataproducts', 'digitalassets'], 'each adapter closed exactly once');
    assert.equal(ares.supervisor.snapshot().stopped, true);
    assert.equal(existsSync(join(f.dir, 'ledger.jsonl')), true);
  } finally {
    f.cleanup();
  }
});

test('the ledger written by one boot is re-opened and verified by the next', async () => {
  const f = fixture();
  try {
    const first = await boot(f);
    for (let t = 0; t < 4; t++) {
      await first.supervisor.runTick(t);
      f.clock.advance(1_000);
    }
    const sizeAfterFirst = first.ledger.size();
    const headAfterFirst = first.ledger.head();
    await first.shutdown('restart');

    // A second process on the same data directory replays and verifies.
    const f2: Fixture = { ...f, clock: new TestClock(50_000) };
    const second = await boot(f2);
    try {
      assert.equal(second.ledger.verify().ok, true);
      assert.ok(second.ledger.size() >= sizeAfterFirst, 'nothing was lost across the restart');
      assert.equal(second.ledger.head(), headAfterFirst, 'the reopened chain continues from the same head');
    } finally {
      await second.shutdown('test over');
    }
  } finally {
    f.cleanup();
  }
});
