/**
 * test/agents.harness.ts — shared deterministic scaffolding for the agent tests.
 * NOT a test file (no `.test.` in the name, so the runner never collects it).
 * Everything here is seeded: TestClock, makeRng(seed), a real Ledger and real
 * MemoryStores on a mkdtemp directory that the caller must close().
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TestClock } from '../src/core/clock.js';
import { makeRng, type Rng } from '../src/core/rng.js';
import { nullLogger, type Logger } from '../src/core/logger.js';
import { loadConfig, type AresConfig, type Env } from '../src/core/config.js';
import { Ledger } from '../src/core/ledger.js';
import { money, type Minor, type Money } from '../src/core/money.js';
import type { AgentId, Fill, Holding, Offer, Opportunity } from '../src/core/types.js';
import { Bus } from '../src/bus/bus.js';
import type { Envelope, MsgType } from '../src/bus/protocol.js';
import { BudgetGovernor } from '../src/governance/budget.js';
import { KillSwitch } from '../src/governance/killswitch.js';
import { PolicyEngine } from '../src/governance/policy.js';
import { SurvivalEvaluator } from '../src/governance/survival.js';
import { MemoryStore } from '../src/memory/store.js';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext } from '../src/channels/adapter.js';
import { MarketSimulator } from '../src/channels/simulator.js';
import { DataProductsAdapter } from '../src/channels/dataproducts.js';
import { DigitalAssetsAdapter } from '../src/channels/digitalassets.js';
import { KsaEcomAdapter } from '../src/channels/ksa_ecom.js';
import { makeAgentDeps, type AgentDeps } from '../src/agents/base.js';
import { AgentRegistry } from '../src/agents/registry.js';

export interface Stack {
  dir: string;
  cfg: AresConfig;
  clock: TestClock;
  rng: Rng;
  logger: Logger;
  ledger: Ledger;
  killSwitch: KillSwitch;
  budget: BudgetGovernor;
  policy: PolicyEngine;
  survival: SurvivalEvaluator;
  bus: Bus;
  registry: AgentRegistry;
  sim: MarketSimulator;
  channels: Map<string, ChannelAdapter>;
  taskMemory: MemoryStore;
  memories: Map<string, MemoryStore>;
  /** Deps for an agent id, with the policy engine's kill switch wired. */
  depsFor(id: AgentId): AgentDeps;
  /** Everything published on the bus, in order. */
  seen: Envelope[];
  of(type: MsgType): Envelope[];
  close(): void;
}

export interface StackOptions {
  seed?: number;
  /** Channel names to wire; defaults to all three. */
  channels?: string[];
  /** Replace/extend the channel map with stubs. */
  extraChannels?: Map<string, ChannelAdapter>;
}

export async function makeStack(env: Env = {}, opts: StackOptions = {}): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), 'ares-agents-'));
  const cfg = loadConfig({ ARES_DATA_DIR: dir, ...env });
  const seed = opts.seed ?? cfg.seed;
  const clock = new TestClock(1_000);
  const rng = makeRng(seed);
  const logger = nullLogger;
  const ledger = Ledger.open(dir, clock, logger);
  const killSwitch = new KillSwitch(logger, clock);
  const budget = new BudgetGovernor(cfg, ledger, logger, killSwitch);
  budget.bootstrap(0);
  // Deliberately constructed WITHOUT a kill switch: makeAgentDeps must wire it.
  const policy = new PolicyEngine(cfg, logger);
  const survival = new SurvivalEvaluator(cfg, ledger, logger);
  const bus = new Bus(cfg, clock, logger);
  const registry = new AgentRegistry(logger);
  const sim = new MarketSimulator({ rng: makeRng(seed), clock, logger });
  const ctx: ChannelContext = { cfg, rng: makeRng(seed + 1), clock, logger };

  const wanted = new Set(opts.channels ?? cfg.channels);
  const channels = new Map<string, ChannelAdapter>();
  const params = { currency: cfg.baseCurrency };
  if (wanted.has('dataproducts')) {
    const a = new DataProductsAdapter(sim, params);
    await a.init(ctx);
    channels.set(a.name, a);
  }
  if (wanted.has('digitalassets')) {
    const a = new DigitalAssetsAdapter(sim, params);
    await a.init(ctx);
    channels.set(a.name, a);
  }
  if (wanted.has('ksa_ecom')) {
    const a = new KsaEcomAdapter(sim, params);
    await a.init(ctx);
    channels.set(a.name, a);
  }
  if (opts.extraChannels) for (const [k, v] of opts.extraChannels) channels.set(k, v);

  const taskMemory = MemoryStore.open(dir, 'task', logger);
  const memories = new Map<string, MemoryStore>();
  const seen: Envelope[] = [];
  bus.subscribe('test-observer', [
    'OPPORTUNITY_FOUND',
    'BUY_REQUEST',
    'BUY_RESULT',
    'INVENTORY_ADDED',
    'OFFER_PUBLISHED',
    'SALE_FILLED',
    'PRICE_ADVICE',
    'AUDIT_TICK',
    'BUDGET_DENIED',
    'HALT',
    'AGENT_TERMINATED',
    'AGENT_SPAWNED',
    'STRATEGY_OUTCOME',
    'POLICY_DENIED',
  ], (e) => {
    seen.push(e);
  });

  return {
    dir,
    cfg,
    clock,
    rng,
    logger,
    ledger,
    killSwitch,
    budget,
    policy,
    survival,
    bus,
    registry,
    sim,
    channels,
    taskMemory,
    memories,
    seen,
    of(type: MsgType): Envelope[] {
      return seen.filter((e) => e.type === type);
    },
    depsFor(id: AgentId): AgentDeps {
      let mem = memories.get(id);
      if (mem === undefined) {
        mem = MemoryStore.open(dir, id, logger);
        memories.set(id, mem);
      }
      return makeAgentDeps({
        cfg,
        bus,
        ledger,
        budget,
        policy,
        killSwitch,
        survival,
        memory: mem,
        taskMemory,
        clock,
        // A per-agent stream so one agent's draws cannot shift another's.
        rng: makeRng(seed + id.length * 31 + id.charCodeAt(0)),
        logger,
        channels,
      });
    },
    close(): void {
      try {
        ledger.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------- stub adapter */

export interface StubOptions {
  name: string;
  capabilities?: Partial<ChannelCapabilities>;
  currency?: 'SAR' | 'USD';
  opportunities?: Opportunity[];
  quoteFeeMinor?: Minor;
  demand?: number;
  listingFeeMinor?: Minor;
}

/**
 * A fully controllable ChannelAdapter. Every call is counted so a test can
 * assert a path was NEVER taken, which is the only way to prove a refusal.
 */
export class StubAdapter implements ChannelAdapter {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  readonly calls: Record<string, number> = {
    init: 0,
    scan: 0,
    quote: 0,
    buy: 0,
    publish: 0,
    poll: 0,
    demandSignal: 0,
    pollExpired: 0,
    close: 0,
  };
  opportunities: Opportunity[];
  fills: Fill[] = [];
  expired: Array<{ channel: string; offerId: string; sku: string; priceMinor: Minor; remaining: number; listedTick: number; expiredTick: number }> = [];
  publishedOffers: Offer[] = [];
  buyThrows: Error | null = null;
  private readonly currency: 'SAR' | 'USD';
  private readonly quoteFee: Minor;
  private readonly demandValue: number;
  private readonly listingFee: Minor;
  private seq = 0;

  constructor(o: StubOptions) {
    this.name = o.name;
    this.capabilities = {
      canBuy: true,
      canSell: true,
      buyRequiresHumanApproval: false,
      tosNote: `stub channel ${o.name}`,
      jurisdiction: 'GLOBAL',
      ...(o.capabilities ?? {}),
    };
    this.currency = o.currency ?? 'SAR';
    this.opportunities = o.opportunities ?? [];
    this.quoteFee = o.quoteFeeMinor ?? 0;
    this.demandValue = o.demand ?? 0.5;
    this.listingFee = o.listingFeeMinor ?? 0;
  }

  async init(): Promise<void> {
    this.calls['init']!++;
  }

  async scan(_tick: number, _budget: Money): Promise<Opportunity[]> {
    this.calls['scan']!++;
    return this.opportunities.slice();
  }

  async quote(o: Opportunity): Promise<{ unitCost: Money; feeMinor: Minor }> {
    this.calls['quote']!++;
    return { unitCost: o.askPrice, feeMinor: this.quoteFee };
  }

  async buy(o: Opportunity, qty: number, tick: number, idem: string): Promise<{ holding: Holding; feeMinor: Minor }> {
    this.calls['buy']!++;
    if (this.buyThrows !== null) throw this.buyThrows;
    return {
      holding: {
        id: `${this.name}:hold:${idem}`,
        channel: this.name,
        sku: o.sku,
        qty,
        unitCost: o.askPrice,
        acquiredTick: tick,
        meta: { estResaleValueMinor: o.estResaleValue.amount },
      },
      feeMinor: this.quoteFee,
    };
  }

  async publish(offer: Offer, _tick: number, _idem: string): Promise<{ offerId: string; feeMinor: Minor }> {
    this.calls['publish']!++;
    this.publishedOffers.push(offer);
    // The channel-scoped form the real adapters use.
    return { offerId: `${this.name}:${offer.id}`, feeMinor: this.listingFee };
  }

  async poll(_tick: number): Promise<Fill[]> {
    this.calls['poll']!++;
    const out = this.fills;
    this.fills = [];
    return out;
  }

  async pollExpired(_tick: number): Promise<Array<{ channel: string; offerId: string; sku: string; priceMinor: Minor; remaining: number; listedTick: number; expiredTick: number }>> {
    this.calls['pollExpired']!++;
    const out = this.expired;
    this.expired = [];
    return out;
  }

  async demandSignal(): Promise<number> {
    this.calls['demandSignal']!++;
    return this.demandValue;
  }

  async close(): Promise<void> {
    this.calls['close']!++;
  }

  opportunity(over: Partial<Opportunity> = {}): Opportunity {
    this.seq += 1;
    return {
      id: `${this.name}-opp-${this.seq}`,
      channel: this.name,
      sku: `${this.name}-sku-${this.seq}`,
      title: `stub ${this.seq}`,
      askPrice: money(1_000, this.currency),
      estResaleValue: money(2_000, this.currency),
      confidence: 0.95,
      ttlTicks: 5,
      meta: { sellCommissionBps: 0 },
      ...over,
    };
  }
}
