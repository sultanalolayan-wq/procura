/**
 * test/orchestrator.test.ts — the boot contract. Everything here is about
 * REFUSING to come up half-safe: no usable channel, an unauthenticated public
 * API bind, a policy engine that is not consulting the kill switch.
 * Deterministic: TestClock, temp dirs, the API never binds unless the test
 * says so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TestClock } from '../src/core/clock.js';
import { loadConfig, type AresConfig, type Env } from '../src/core/config.js';
import { AresError } from '../src/core/errors.js';
import { nullLogger } from '../src/core/logger.js';
import { policyKillSwitch } from '../src/agents/base.js';
import { IntegrityError } from '../src/core/errors.js';
import {
  bootstrap,
  startupExitCode,
  EXIT_LEDGER_CORRUPT,
  LEDGER_SENTINEL_FILE,
  type Ares,
} from '../src/runtime/orchestrator.js';

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
    // CHANGED DELIBERATELY. This used to pin ksa_ecom being REJECTED at boot,
    // because it declared canBuy:true together with buyRequiresHumanApproval:true
    // and no approval channel is configured. That rejection was real, but it was
    // a rejection of a MISDECLARED capability set, not of the channel: the
    // adapter has no automated buy path at all (buy() throws unconditionally).
    // The consequence of pinning it was that the Saudi sell path, its SAR
    // pricing and its VAT handling were unreachable dead code in every default
    // run. ksa_ecom now declares canBuy:false and is admitted SELL-ONLY.
    assert.deepEqual([...ares.channels.keys()].sort(), ['dataproducts', 'digitalassets', 'ksa_ecom']);
    const ksa = ares.channels.get('ksa_ecom');
    assert.ok(ksa, 'the sell-only Saudi channel is admitted');
    assert.equal(ksa.capabilities.canBuy, false, 'admitted precisely BECAUSE it claims no buy path');
    assert.equal(ksa.capabilities.canSell, true);
    assert.deepEqual(ares.rejectedChannels, [], 'nothing in the default allow-list is rejected any more');

    // The gate itself is unchanged: a channel that really does claim canBuy while
    // its own ToS requires a human per purchase is still refused.
    const liar = {
      name: 'ksa_ecom',
      capabilities: {
        canBuy: true,
        canSell: true,
        buyRequiresHumanApproval: true,
        tosNote: 'ToS: every purchase must be confirmed by a human account holder',
        jurisdiction: 'SA',
      },
    };
    const engine = ares.policy;
    assert.throws(
      () => engine.checkChannel(liar as never),
      (err: unknown) => {
        assert.ok(err instanceof AresError);
        assert.match(err.code, /^POLICY_/);
        assert.match(err.message, /approval/i);
        return true;
      },
    );
  } finally {
    if (ares) await ares.shutdown('test over');
    f.cleanup();
  }
});

test('booting with zero usable channels is a loud refusal, not a silently idle swarm', async () => {
  // Was ARES_CHANNELS=ksa_ecom, which is now a usable sell-only channel. An
  // allow-list of channels that have no adapter at all is the remaining way to
  // reach this state, and it is the state that matters: a swarm that comes up
  // with nothing to trade against must refuse, not idle.
  const f = fixture({ ARES_CHANNELS: 'ksa_bazaar,mystery_market' });
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
  const f = fixture({ ARES_API_HOST: '0.0.0.0', ARES_API_TOKEN: 'a-long-operator-secret-of-32-chars' });
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
    // ksa_ecom is admitted now, so it is one of the adapters that must be closed.
    assert.deepEqual(
      closed.sort(),
      ['dataproducts', 'digitalassets', 'ksa_ecom'],
      'each adapter closed exactly once',
    );
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


/* ===================================================================== */
/* FIX B8 — a corrupt ledger is visible, not an indistinguishable crash   */
/* ===================================================================== */

test('FIX B8: a corrupt ledger refuses to boot, writes a sentinel and exits with its OWN code', async () => {
  const f = fixture();
  try {
    // Lay down a real chain, then rewrite history in it.
    const first = await boot(f);
    await first.supervisor.runTick(0);
    await first.shutdown('seeding done');

    const path = join(f.dir, 'ledger.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
    assert.ok(lines.length >= 1);
    lines[0] = (lines[0] as string).replace(/"tick":\d+/, '"tick":424242');
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');

    let caught: unknown = null;
    await assert.rejects(
      () => boot(f),
      (err: unknown) => {
        caught = err;
        assert.ok(err instanceof IntegrityError, 'refusing to open a broken chain is CORRECT and stays');
        return true;
      },
    );

    // The distinct exit code is what lets `restart: unless-stopped` be told
    // apart from an ordinary flap.
    assert.equal(startupExitCode(caught), EXIT_LEDGER_CORRUPT);
    assert.notEqual(EXIT_LEDGER_CORRUPT, 1);
    assert.equal(startupExitCode(new Error('an ordinary crash')), 1);

    // ...and the sentinel says what happened, where, and that restarting will
    // not fix it.
    const sentinel = join(f.dir, LEDGER_SENTINEL_FILE);
    assert.equal(existsSync(sentinel), true, 'a silent crash loop is how this stayed invisible');
    const body = JSON.parse(readFileSync(sentinel, 'utf8')) as Record<string, unknown>;
    assert.equal(body['exitCode'], EXIT_LEDGER_CORRUPT);
    assert.match(String(body['code']), /^LEDGER_/);
    assert.match(String(body['note']), /Restarting will NOT fix it/i);
    assert.equal(typeof (body['meta'] as Record<string, unknown>)['brokenAtSeq'], 'number');
  } finally {
    f.cleanup();
  }
});

/* ===================================================================== */
/* FIX B8 / B7 — snapshot settings come from AresConfig, not process.env  */
/* ===================================================================== */

test('FIX B8: snapshot cadence and retention are read from AresConfig and wired into the supervisor', async () => {
  const f = fixture({ ARES_SNAPSHOT_EVERY: '1', ARES_SNAPSHOT_RETAIN: '2' });
  let ares: Ares | null = null;
  try {
    assert.equal(f.cfg.snapshotEveryTicks, 1, 'ARES_SNAPSHOT_EVERY lives in the config now');
    assert.equal(f.cfg.snapshotRetain, 2);
    ares = await boot(f);
    const snap = ares.supervisor.snapshot();
    assert.equal(snap.snapshotEveryTicks, 1);
    assert.equal(snap.snapshotRetain, 2);

    for (let t = 0; t < 5; t++) {
      await ares.supervisor.runTick(t);
      f.clock.advance(1_000);
    }
    const files = readdirSync(join(f.dir, 'snapshots')).filter((n) => n.endsWith('.json'));
    assert.equal(files.length, 2, 'retention is enforced on the same volume the ledger lives on');
  } finally {
    if (ares) await ares.shutdown('test over');
    f.cleanup();
  }
});

/* ===================================================================== */
/* FIX B5 — the boot-time HALT watcher is not disarmed by a broken link   */
/* ===================================================================== */

test('FIX B5: a pre-planted dangling HALT symlink halts the booted swarm', async () => {
  const f = fixture();
  let ares: Ares | null = null;
  try {
    symlinkSync(join(f.dir, 'target-that-does-not-exist'), join(f.dir, 'HALT'));
    ares = await bootstrap(f.cfg, {
      clock: f.clock,
      logger: nullLogger,
      startApi: false,
      haltWatchIntervalMs: 100,
    });
    assert.equal(ares.killSwitch.tripped, true, 'the emergency stop was silently disarmed by this before');
    assert.match(String(ares.killSwitch.reason), /halt file/i);
    assert.equal(String(ares.killSwitch.reason).includes(f.dir), false, 'and the reason carries no path');
  } finally {
    if (ares) await ares.shutdown('test over');
    f.cleanup();
  }
});
