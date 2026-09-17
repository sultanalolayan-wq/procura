/**
 * agents/scout.ts — the buyer. Finds an edge, proves it clears BOTH a margin and
 * a confidence bar, and only then spends money through policy + budget.
 * Invariants: a channel that cannot buy is never bought from; policy.checkBuy
 * runs BEFORE adapter.buy, so a ToS-refusing channel (ksa_ecom) is never reached;
 * every purchase carries an idempotency key; and the bandit's reward is the
 * REALISED margin correlated by traceId when the sale settles, NEVER the margin
 * estimated at purchase time. Callers: runtime/supervisor, registry.
 */

import { BudgetDenied, PolicyDenied } from '../core/errors.js';
import { idempotencyKey, newId } from '../core/ids.js';
import { money, type Minor, type Money } from '../core/money.js';
import type { AgentId, Holding, Opportunity } from '../core/types.js';
import type { Envelope } from '../bus/protocol.js';
import { CircuitBreaker, RateLimiter } from '../governance/circuit.js';
import { Bandit } from '../memory/learning.js';
import type { ChannelAdapter } from '../channels/adapter.js';
import { BaseAgent, type AgentDeps } from './base.js';

/** One exploration arm: a (margin, confidence) pair the bandit can prefer. */
export interface ScoutArm {
  id: string;
  /** Required expected margin as a fraction of the all-in cost. */
  minMarginRatio: number;
  /** Required estimator confidence, 0..1. */
  minConfidence: number;
  qty: number;
}

/**
 * The arms. They differ in how much apparent edge and how much estimator
 * precision they insist on; the bandit learns which combination actually pays.
 */
export const SCOUT_ARMS: readonly ScoutArm[] = Object.freeze([
  Object.freeze({ id: 'strict', minMarginRatio: 0.34, minConfidence: 0.88, qty: 1 }),
  Object.freeze({ id: 'balanced', minMarginRatio: 0.24, minConfidence: 0.78, qty: 1 }),
  Object.freeze({ id: 'wide', minMarginRatio: 0.16, minConfidence: 0.66, qty: 1 }),
]) as readonly ScoutArm[];

/** Strategy families the registry can choose between when respawning a scout. */
export const SCOUT_STRATEGIES: readonly string[] = Object.freeze(['edge-hunter', 'value-hunter', 'patient-hunter']);

/** Per-strategy tightening applied on top of the arm's own thresholds. */
const STRATEGY_TIGHTEN: Readonly<Record<string, { margin: number; confidence: number }>> = Object.freeze({
  'edge-hunter': { margin: 1.0, confidence: 1.0 },
  'value-hunter': { margin: 1.25, confidence: 0.98 },
  'patient-hunter': { margin: 1.6, confidence: 1.06 },
});

/**
 * Conservative round-trip sell cost when the channel does not advertise one.
 * 900 bps is the worst sell commission of the three configured channels; being
 * pessimistic here can only make the scout refuse more, never overspend.
 */
export const DEFAULT_SELL_FEE_BPS = 900;

/** After this many ticks an unresolved purchase is judged on what it did earn. */
export const TRADE_RESOLUTION_TICKS = 40;

export interface ScoutOptions {
  /** Explicit arm set (tests pin this); defaults to SCOUT_ARMS. */
  arms?: readonly ScoutArm[];
  /** Ticks after which an unsettled trade is force-resolved for learning. */
  tradeResolutionTicks?: number;
  circuit?: { failureThreshold: number; cooldownMs: number; halfOpenMax: number };
}

/** What the scout spent, and what it is still waiting to learn from. */
export interface OpenTrade {
  traceId: string;
  arm: string;
  channel: string;
  sku: string;
  holdingId: string;
  qty: number;
  /** Cash that actually left the till: ask * qty + buy fee. */
  costMinor: Minor;
  /** What the scout THOUGHT it would make. Recorded for audit; never a reward. */
  estMarginMinor: Minor;
  tick: number;
  proceedsMinor: Minor;
  disposedQty: number;
  resolved: boolean;
}

export interface OpportunityScore {
  allInMinor: Minor;
  expectedNetMinor: Minor;
  marginRatio: number;
  confidence: number;
}

/**
 * Score an opportunity the way the round trip really works: the ask, the buy
 * commission and the sell commission all come out before anything is earned.
 * Pure, so the thresholds can be tested without a market.
 */
export function scoreOpportunity(o: Opportunity, buyFeeMinor: Minor, sellFeeBps: number): OpportunityScore {
  const ask = o.askPrice.amount;
  const resale = o.estResaleValue.amount;
  const allIn = ask + Math.max(0, buyFeeMinor);
  const sellFee = Math.ceil((Math.max(0, resale) * Math.max(0, sellFeeBps)) / 10_000);
  const expectedNet = resale - sellFee - allIn;
  return {
    allInMinor: allIn,
    expectedNetMinor: expectedNet,
    // A zero-cost opportunity (a mintable data product) has no margin RATIO;
    // report 0 so it can never pass a buy threshold. Minting is the seller's job.
    marginRatio: allIn > 0 ? expectedNet / allIn : 0,
    confidence: typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? o.confidence : 0,
  };
}

/**
 * BOTH bars, never one. The channels suite measures that a strategy trading on
 * apparent margin alone loses money: the estimate's error is what eats the edge,
 * and only the confidence bar filters for a small error.
 */
export function passesThresholds(s: OpportunityScore, arm: ScoutArm, tighten: { margin: number; confidence: number }): boolean {
  if (s.expectedNetMinor <= 0) return false;
  if (s.marginRatio < arm.minMarginRatio * tighten.margin) return false;
  if (s.confidence < Math.min(0.99, arm.minConfidence * tighten.confidence)) return false;
  return true;
}

interface Candidate {
  channel: string;
  adapter: ChannelAdapter;
  opportunity: Opportunity;
  score: OpportunityScore;
  buyFeeMinor: Minor;
  qty: number;
}

export class ScoutAgent extends BaseAgent {
  private readonly arms: readonly ScoutArm[];
  private readonly bandit: Bandit;
  private readonly limiter: RateLimiter;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly openTrades = new Map<string, OpenTrade>();
  /** Channels whose policy refusal is settled; re-asking would only spam. */
  private readonly policyBlocked = new Map<string, string>();
  private readonly tradeResolutionTicks: number;
  private readonly tighten: { margin: number; confidence: number };
  private readonly circuitOpts: { failureThreshold: number; cooldownMs: number; halfOpenMax: number };
  private currentArm: ScoutArm;
  private buys = 0;
  private refusals = 0;

  constructor(id: AgentId, strategyId: string, deps: AgentDeps, opts: ScoutOptions = {}) {
    super(id, 'scout', strategyId, deps);
    this.arms = opts.arms && opts.arms.length > 0 ? opts.arms : SCOUT_ARMS;
    this.tighten = STRATEGY_TIGHTEN[strategyId] ?? { margin: 1.0, confidence: 1.0 };
    this.tradeResolutionTicks = opts.tradeResolutionTicks ?? TRADE_RESOLUTION_TICKS;
    const saved = deps.memory.getFact<unknown>('scout.bandit', null);
    this.bandit =
      saved === null
        ? new Bandit(this.arms.map((a) => a.id), deps.rng)
        : Bandit.fromJSON(saved, deps.rng);
    for (const a of this.arms) this.bandit.addArm(a.id);
    this.currentArm = this.arms[0] as ScoutArm;
    this.limiter = new RateLimiter(deps.cfg.limits.externalCallsPerMinute, deps.clock);
    this.circuitOpts = opts.circuit ?? { failureThreshold: 3, cooldownMs: 30_000, halfOpenMax: 1 };
    for (const name of deps.channels.keys()) {
      for (const op of ['scan', 'buy'] as const) {
        this.breakers.set(`${name}:${op}`, new CircuitBreaker(`scout:${name}:${op}`, this.circuitOpts, deps.clock, this.log));
      }
    }
    // The realised-margin feedback loop. Correlated by traceId, not by guesswork.
    this.subscribe(['SALE_FILLED'], (e) => this.onSaleFilled(e));
  }

  /** Read-only view of the learner (tests and the dashboard). */
  get learner(): Bandit {
    return this.bandit;
  }

  get armInUse(): string {
    return this.currentArm.id;
  }

  trades(): OpenTrade[] {
    return [...this.openTrades.values()].map((t) => ({ ...t }));
  }

  stats(): { buys: number; refusals: number; openTrades: number; policyBlocked: string[] } {
    return {
      buys: this.buys,
      refusals: this.refusals,
      openTrades: this.openTrades.size,
      policyBlocked: [...this.policyBlocked.keys()],
    };
  }

  // ------------------------------------------------------------------- tick --

  override async onTick(tick: number): Promise<void> {
    this.resolveStaleTrades(tick);
    const armId = this.bandit.select();
    this.currentArm = this.arms.find((a) => a.id === armId) ?? (this.arms[0] as ScoutArm);

    const budget = this.scanBudget();
    if (budget.amount <= 0) {
      this.log.debug('scout.no_budget', { tick });
      return;
    }

    const candidates: Candidate[] = [];
    for (const [name, adapter] of this.deps.channels) {
      if (this.actionsLeft <= 1) break; // keep at least one action for the buy
      // dataproducts declares canBuy=false: there is no acquisition path at all.
      // Inventory on that channel is MINTED by the seller, never bought.
      if (!adapter.capabilities.canBuy) continue;
      if (this.policyBlocked.has(name)) continue;
      const found = await this.act(`scan:${name}`, () => this.scanChannel(adapter, tick, budget));
      if (found !== null) candidates.push(...found);
    }
    if (candidates.length === 0) return;

    candidates.sort((a, b) => b.score.marginRatio - a.score.marginRatio);
    for (const c of candidates) {
      if (this.actionsLeft <= 0) break;
      if (this.policyBlocked.has(c.channel)) continue;
      const done = await this.act(`buy:${c.channel}`, () => this.attemptBuy(c, tick));
      if (done === true) break; // one purchase per tick: capital is finite
    }
  }

  private scanBudget(): Money {
    const available = this.deps.budget.availableCash(this.id);
    const cap = this.cfg.budget.perTradeCapMinor;
    return money(Math.max(0, Math.min(available, cap)), this.cfg.baseCurrency);
  }

  // ------------------------------------------------------------------ scan --

  private async scanChannel(adapter: ChannelAdapter, tick: number, budget: Money): Promise<Candidate[]> {
    if (!this.limiter.tryTake()) {
      this.log.warn('scout.rate_limited', { channel: adapter.name, tick });
      return [];
    }
    const breaker = this.breaker(adapter.name, 'scan');
    const opportunities = await breaker.exec(() => adapter.scan(tick, budget));
    const out: Candidate[] = [];
    for (const o of opportunities) {
      if (o.askPrice.currency !== this.cfg.baseCurrency) continue;
      if (o.askPrice.amount <= 0) continue; // zero-cost => minted, not bought
      const quoted = await breaker.exec(() => adapter.quote(o, tick));
      const buyFee = quoted.feeMinor;
      const sellBps = this.sellFeeBps(o);
      const score = scoreOpportunity(o, buyFee, sellBps);
      if (!passesThresholds(score, this.currentArm, this.tighten)) {
        this.refusals++;
        this.log.debug('scout.refused', {
          channel: adapter.name,
          sku: o.sku,
          arm: this.currentArm.id,
          marginRatio: Number(score.marginRatio.toFixed(4)),
          confidence: Number(score.confidence.toFixed(4)),
          needMargin: this.currentArm.minMarginRatio * this.tighten.margin,
          needConfidence: this.currentArm.minConfidence * this.tighten.confidence,
        });
        continue;
      }
      const qty = Math.max(1, this.currentArm.qty);
      const total = score.allInMinor * qty;
      if (total > budget.amount) continue;
      out.push({ channel: adapter.name, adapter, opportunity: o, score, buyFeeMinor: buyFee, qty });
      this.emit('OPPORTUNITY_FOUND', {
        channel: adapter.name,
        opportunityId: o.id,
        sku: o.sku,
        askMinor: o.askPrice.amount,
        estResaleMinor: o.estResaleValue.amount,
        confidence: o.confidence,
        expectedNetMinor: score.expectedNetMinor,
        marginRatio: score.marginRatio,
        arm: this.currentArm.id,
        tick,
      });
    }
    return out;
  }

  /** Round-trip sell cost: the channel's own number when it exposes one. */
  private sellFeeBps(o: Opportunity): number {
    const declared = o.meta['sellCommissionBps'];
    return typeof declared === 'number' && Number.isFinite(declared) && declared >= 0 ? declared : DEFAULT_SELL_FEE_BPS;
  }

  /**
   * One breaker per (channel, operation). Sharing a breaker across read and
   * write paths would be worse than having none: a channel that scans perfectly
   * but refuses every purchase would keep resetting the failure counter with its
   * successful scans, so the buy path could never trip.
   */
  private breaker(name: string, op: 'scan' | 'buy'): CircuitBreaker {
    const key = `${name}:${op}`;
    let b = this.breakers.get(key);
    if (b === undefined) {
      b = new CircuitBreaker(`scout:${key}`, this.circuitOpts, this.deps.clock, this.log);
      this.breakers.set(key, b);
    }
    return b;
  }

  // ------------------------------------------------------------------- buy --

  /** Returns true when a purchase actually happened. */
  private async attemptBuy(c: Candidate, tick: number): Promise<boolean> {
    const o = c.opportunity;
    const totalMinor = c.score.allInMinor * c.qty;
    const total = money(totalMinor, this.cfg.baseCurrency);

    // 1. POLICY FIRST. ksa_ecom's buy() is an unconditional ToS refusal; the
    //    scout must never get that far, and this is the gate that stops it.
    try {
      this.deps.policy.checkBuy(c.adapter, o, c.qty, total, tick);
    } catch (err) {
      if (err instanceof PolicyDenied) {
        this.policyBlocked.set(c.channel, err.code);
        this.refusals++;
        this.emit('POLICY_DENIED', {
          channel: c.channel,
          sku: o.sku,
          code: err.code,
          reason: err.message,
          stage: 'buy',
          tick,
        });
        this.deps.memory.setFact(`policyBlocked:${c.channel}`, err.code);
        this.log.warn('scout.policy_blocked_channel', { channel: c.channel, code: err.code });
        return false;
      }
      throw err;
    }

    // 2. BUDGET. A refusal here is normal operation, not a crash.
    let reservation;
    try {
      reservation = this.reserve('cash', totalMinor, tick);
    } catch (err) {
      if (err instanceof BudgetDenied) {
        this.refusals++;
        this.emit('BUDGET_DENIED', { channel: c.channel, sku: o.sku, code: err.code, amountMinor: totalMinor, tick });
        return false;
      }
      throw err;
    }

    const idem = idempotencyKey(['scout.buy', this.id, c.channel, o.id, c.qty, tick]);
    this.emit('BUY_REQUEST', { channel: c.channel, opportunityId: o.id, sku: o.sku, qty: c.qty, totalMinor, idem, tick });

    let bought: { holding: Holding; feeMinor: Minor };
    try {
      bought = await this.breaker(c.channel, 'buy').exec(() => c.adapter.buy(o, c.qty, tick, idem));
    } catch (err) {
      this.releaseReservation(reservation);
      this.emit('BUY_RESULT', {
        channel: c.channel,
        sku: o.sku,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        tick,
      });
      throw err; // act() counts it, logs it and contains it
    }

    const filledQty = Math.max(0, bought.holding.qty);
    const costMinor = bought.holding.unitCost.amount * filledQty;
    const feeMinor = Math.max(0, bought.feeMinor);
    const spentMinor = costMinor + feeMinor;
    if (filledQty <= 0 || spentMinor <= 0) {
      this.releaseReservation(reservation);
      this.log.warn('scout.empty_fill', { channel: c.channel, sku: o.sku, tick });
      return false;
    }

    // 3. LEDGER: inventory + fees debited, cash credited. Balanced by construction.
    this.deps.ledger.append({
      tick,
      type: 'BUY',
      agentId: this.id,
      currency: this.cfg.baseCurrency,
      legs: [
        { account: 'inventory', amount: costMinor },
        { account: 'fees', amount: feeMinor },
        { account: 'cash', amount: -spentMinor },
      ],
      idempotencyKey: idem,
      meta: {
        channel: c.channel,
        sku: o.sku,
        qty: filledQty,
        requestedQty: c.qty,
        holdingId: bought.holding.id,
        arm: this.currentArm.id,
        strategyId: this.strategyId,
        estMarginMinor: c.score.expectedNetMinor,
        confidence: o.confidence,
      },
    });
    this.commitReservation(reservation, Math.min(spentMinor, totalMinor), { channel: c.channel, sku: o.sku });
    this.buys++;

    // 4. Hand the holding to the seller and open a trade the sale will close.
    const env = this.emit('INVENTORY_ADDED', {
      holding: bought.holding,
      channel: c.channel,
      sku: o.sku,
      qty: filledQty,
      unitCostMinor: bought.holding.unitCost.amount,
      costMinor: spentMinor,
      estResaleMinor: o.estResaleValue.amount,
      buyerId: this.id,
      arm: this.currentArm.id,
      tick,
    });
    this.openTrades.set(env.traceId, {
      traceId: env.traceId,
      arm: this.currentArm.id,
      channel: c.channel,
      sku: o.sku,
      holdingId: bought.holding.id,
      qty: filledQty,
      costMinor: spentMinor,
      estMarginMinor: c.score.expectedNetMinor,
      tick,
      proceedsMinor: 0,
      disposedQty: 0,
      resolved: false,
    });
    this.emit('BUY_RESULT', {
      channel: c.channel,
      sku: o.sku,
      ok: true,
      qty: filledQty,
      spentMinor,
      holdingId: bought.holding.id,
      traceId: env.traceId,
      tick,
    });
    this.persistBandit();
    return true;
  }

  // ------------------------------------------------- realised-margin feedback --

  /**
   * THE learning rule. The bandit is updated from `proceeds - cost`, measured
   * when the sale settles and matched to the purchase by traceId. Rewarding the
   * margin the scout *estimated* at purchase time would teach the bandit to
   * trust its own optimism, which is precisely the failure this design exists to
   * avoid; a written-off holding is a disposal with zero proceeds and therefore
   * a loss, exactly as it should be.
   */
  private onSaleFilled(e: Envelope): void {
    const p = e.payload as Record<string, unknown>;
    const traceId = typeof p['traceId'] === 'string' ? (p['traceId'] as string) : e.traceId;
    const trade = this.openTrades.get(traceId) ?? this.findByHolding(p['holdingId']);
    if (trade === undefined || trade.resolved) return;
    const qty = typeof p['qty'] === 'number' ? (p['qty'] as number) : 0;
    const remaining = typeof p['remaining'] === 'number' ? (p['remaining'] as number) : null;
    // PROCEEDS = cash in, i.e. gross less the selling fee and before any cost of
    // goods: the cost of goods for this trade is what the scout itself paid and
    // already sits in costMinor. Double-counting it would flatter every trade.
    const proceeds =
      typeof p['proceedsMinor'] === 'number'
        ? (p['proceedsMinor'] as number)
        : (typeof p['netMinor'] === 'number' ? (p['netMinor'] as number) : 0) +
          (typeof p['cogsMinor'] === 'number' ? (p['cogsMinor'] as number) : 0);
    trade.proceedsMinor += proceeds;
    trade.disposedQty += qty;
    if (remaining === 0 || trade.disposedQty >= trade.qty) {
      this.resolveTrade(trade, typeof p['tick'] === 'number' ? (p['tick'] as number) : this.tick, 'settled');
    }
  }

  private findByHolding(holdingId: unknown): OpenTrade | undefined {
    if (typeof holdingId !== 'string') return undefined;
    for (const t of this.openTrades.values()) if (t.holdingId === holdingId) return t;
    return undefined;
  }

  private resolveStaleTrades(tick: number): void {
    for (const t of [...this.openTrades.values()]) {
      if (t.resolved) continue;
      if (tick - t.tick < this.tradeResolutionTicks) continue;
      // Never sold, never written off: judged on what it actually earned, which
      // for an unsold holding is a loss of the whole outlay.
      this.resolveTrade(t, tick, 'unresolved_timeout');
    }
  }

  private resolveTrade(t: OpenTrade, tick: number, how: string): void {
    t.resolved = true;
    this.openTrades.delete(t.traceId);
    const realisedMinor = t.proceedsMinor - t.costMinor;
    const success = realisedMinor > 0;
    try {
      this.bandit.update(t.arm, success ? 1 : 0);
    } catch (err) {
      this.log.error('scout.bandit_update_failed', { arm: t.arm, error: err instanceof Error ? err.message : String(err) });
    }
    this.deps.memory.observe(`realisedMargin:${t.arm}`, realisedMinor);
    this.deps.memory.observe(`estimateError:${t.arm}`, realisedMinor - t.estMarginMinor);
    this.learn({
      strategyId: `${this.strategyId}/${t.arm}`,
      agentId: this.id,
      tick,
      netMinor: realisedMinor,
      success,
      meta: {
        kind: 'trade',
        how,
        arm: t.arm,
        channel: t.channel,
        sku: t.sku,
        holdingId: t.holdingId,
        costMinor: t.costMinor,
        proceedsMinor: t.proceedsMinor,
        // Kept side by side so the audit trail shows how wrong the estimate was.
        estMarginMinor: t.estMarginMinor,
        realisedMinor,
      },
    });
    this.persistBandit();
  }

  private persistBandit(): void {
    try {
      this.deps.memory.setFact('scout.bandit', this.bandit.toJSON());
    } catch (err) {
      this.log.error('scout.bandit_persist_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  protected override async onTerminate(reason: string): Promise<void> {
    // Whatever is still in flight is a loss the successor should know about.
    for (const t of [...this.openTrades.values()]) this.resolveTrade(t, this.tick < 0 ? 0 : this.tick, `terminated:${reason}`);
    this.persistBandit();
    this.deps.memory.setFact('scout.armWeights', this.bandit.weights());
    this.deps.memory.flush();
  }
}

/** Factory shape the registry uses when it respawns a scout. */
export function scoutFactory(opts: ScoutOptions = {}) {
  return (id: AgentId, strategyId: string, deps: AgentDeps): ScoutAgent => new ScoutAgent(id, strategyId, deps, opts);
}

/** Convenience for the orchestrator: a fresh, deterministically named scout. */
export function newScoutId(): AgentId {
  return newId('scout');
}
