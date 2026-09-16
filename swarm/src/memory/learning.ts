/**
 * memory/learning.ts — the swarm's online learners: a Beta-Bernoulli Thompson
 * sampling Bandit over named arms, and a PriceLearner that learns a per-SKU
 * price multiplier against observed sell-through.
 * Invariants: ALL randomness comes from the injected Rng (a seed replays a run
 * byte-for-byte); state is bounded (LRU-capped SKUs); toJSON/fromJSON round-trip
 * exactly so learning survives a restart. Callers: agents/scout.ts, seller.ts.
 */

import { AresError } from '../core/errors.js';
import { mul, type Money } from '../core/money.js';
import type { Rng } from '../core/rng.js';

// --------------------------------------------------------------- Beta sampling

/**
 * Marsaglia-Tsang Gamma(shape, 1) sampler, driven only by the injected Rng.
 * shape < 1 is handled by the Johnk/boost identity G(a) = G(a+1) * U^(1/a).
 */
export function sampleGamma(shape: number, rng: Rng): number {
  if (!Number.isFinite(shape) || shape <= 0) {
    throw new AresError('INVALID_SHAPE', `sampleGamma: shape must be > 0, got ${String(shape)}`, { shape });
  }
  if (shape < 1) {
    const g = sampleGamma(shape + 1, rng);
    let u = rng.next();
    if (u <= 0) u = Number.EPSILON;
    return g * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Bounded: the acceptance rate is >0.95, so this never spins in practice.
  // The cap only exists so a pathological Rng cannot hang a 24/7 process.
  for (let i = 0; i < 1000; i++) {
    const x = rng.gauss(0, 1);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = rng.next();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (u > 0 && Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // fall back to the mode; astronomically unlikely.
}

/** Beta(a, b) sample as G(a)/(G(a)+G(b)). Always in [0, 1]. */
export function sampleBeta(a: number, b: number, rng: Rng): number {
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  const s = x + y;
  if (!(s > 0) || !Number.isFinite(s)) return 0.5;
  return x / s;
}

// ---------------------------------------------------------------------- Bandit

export interface ArmPosterior {
  /** successes + prior.a */
  a: number;
  /** failures + prior.b */
  b: number;
  /** number of updates seen by this arm */
  n: number;
}

export interface ArmWeight extends ArmPosterior {
  /** posterior mean a/(a+b) */
  mean: number;
}

export interface BanditJSON {
  version: number;
  prior: { a: number; b: number };
  arms: Record<string, ArmPosterior>;
  /** insertion order — select() must be order-stable across a restart */
  order: string[];
}

export const BANDIT_VERSION = 1;
const DEFAULT_PRIOR = { a: 1, b: 1 };

export class Bandit {
  private readonly rng: Rng;
  private readonly prior: { a: number; b: number };
  private readonly arms = new Map<string, ArmPosterior>();

  constructor(arms: string[], rng: Rng, prior: { a: number; b: number } = DEFAULT_PRIOR) {
    if (!rng || typeof rng.next !== 'function' || typeof rng.gauss !== 'function') {
      throw new AresError('INVALID_RNG', 'Bandit: a seeded Rng must be injected (never Math.random)');
    }
    if (!Number.isFinite(prior.a) || !Number.isFinite(prior.b) || prior.a <= 0 || prior.b <= 0) {
      throw new AresError('INVALID_PRIOR', 'Bandit: prior a and b must both be > 0', { prior });
    }
    this.rng = rng;
    this.prior = { a: prior.a, b: prior.b };
    for (const arm of arms ?? []) this.addArm(arm);
  }

  /** Arm names in insertion order (the tie-break order used by select()). */
  armNames(): string[] {
    return [...this.arms.keys()];
  }

  has(arm: string): boolean {
    return this.arms.has(arm);
  }

  /** No-op for an arm that already exists — never resets a live posterior. */
  addArm(arm: string): void {
    if (typeof arm !== 'string' || arm.length === 0) {
      throw new AresError('INVALID_ARM', 'Bandit.addArm: arm must be a non-empty string', { arm });
    }
    if (this.arms.has(arm)) return;
    this.arms.set(arm, { a: this.prior.a, b: this.prior.b, n: 0 });
  }

  /** Removing the last arm is refused: a bandit with no arms cannot select. */
  removeArm(arm: string): void {
    if (!this.arms.has(arm)) {
      throw new AresError('UNKNOWN_ARM', `Bandit.removeArm: unknown arm ${JSON.stringify(arm)}`, {
        arm,
        known: this.armNames(),
      });
    }
    if (this.arms.size === 1) {
      throw new AresError('LAST_ARM', 'Bandit.removeArm: refusing to remove the last remaining arm', { arm });
    }
    this.arms.delete(arm);
  }

  /** Thompson sampling: one Beta draw per arm, highest wins (first on a tie). */
  select(): string {
    if (this.arms.size === 0) {
      throw new AresError('NO_ARMS', 'Bandit.select: no arms configured');
    }
    let best: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [arm, p] of this.arms) {
      const draw = sampleBeta(p.a, p.b, this.rng);
      if (draw > bestScore) {
        bestScore = draw;
        best = arm;
      }
    }
    // Non-null: the map is non-empty and every draw is a finite number >= 0.
    return best as string;
  }

  update(arm: string, reward: 0 | 1): void {
    const p = this.arms.get(arm);
    if (p === undefined) {
      throw new AresError('UNKNOWN_ARM', `Bandit.update: unknown arm ${JSON.stringify(arm)}`, {
        arm,
        known: this.armNames(),
      });
    }
    if (reward !== 0 && reward !== 1) {
      throw new AresError('INVALID_REWARD', `Bandit.update: reward must be 0 or 1, got ${String(reward)}`, {
        arm,
        reward,
      });
    }
    if (reward === 1) p.a += 1;
    else p.b += 1;
    p.n += 1;
  }

  weights(): Record<string, ArmWeight> {
    const out: Record<string, ArmWeight> = {};
    for (const [arm, p] of this.arms) out[arm] = { a: p.a, b: p.b, mean: p.a / (p.a + p.b), n: p.n };
    return out;
  }

  toJSON(): BanditJSON {
    const arms: Record<string, ArmPosterior> = {};
    for (const [arm, p] of this.arms) arms[arm] = { a: p.a, b: p.b, n: p.n };
    return { version: BANDIT_VERSION, prior: { ...this.prior }, arms, order: this.armNames() };
  }

  /** Restores an exact posterior (including n). The Rng is always re-injected. */
  static fromJSON(json: unknown, rng: Rng): Bandit {
    if (typeof json !== 'object' || json === null) {
      throw new AresError('INVALID_BANDIT_JSON', 'Bandit.fromJSON: not an object', { json });
    }
    const rec = json as Partial<BanditJSON>;
    const prior = rec.prior && typeof rec.prior === 'object' ? rec.prior : DEFAULT_PRIOR;
    const armsRec = rec.arms;
    if (typeof armsRec !== 'object' || armsRec === null) {
      throw new AresError('INVALID_BANDIT_JSON', 'Bandit.fromJSON: missing arms', { json });
    }
    const order = Array.isArray(rec.order) ? rec.order.filter((k) => typeof k === 'string') : Object.keys(armsRec);
    const b = new Bandit([], rng, { a: prior.a ?? 1, b: prior.b ?? 1 });
    const names = [...order, ...Object.keys(armsRec).filter((k) => !order.includes(k))];
    for (const name of names) {
      const p = armsRec[name];
      if (!p || typeof p.a !== 'number' || typeof p.b !== 'number') {
        throw new AresError('INVALID_BANDIT_JSON', `Bandit.fromJSON: bad posterior for ${name}`, { arm: name });
      }
      b.arms.set(name, { a: p.a, b: p.b, n: typeof p.n === 'number' ? p.n : 0 });
    }
    return b;
  }
}

// ---------------------------------------------------------------- PriceLearner

export interface PriceLearnerOpts {
  min: number;
  max: number;
  step: number;
  /** LRU cap on tracked SKUs, so a 24/7 process cannot leak memory. */
  maxSkus?: number;
}

export interface PriceLearnerJSON {
  version: number;
  min: number;
  max: number;
  step: number;
  maxSkus: number;
  /** LRU order: oldest first, newest last. Posteriors are step-indexed. */
  skus: Array<{ sku: string; steps: ArmPosterior[] }>;
}

export const PRICE_LEARNER_VERSION = 1;
export const DEFAULT_PRICE_OPTS: Required<PriceLearnerOpts> = {
  min: 0.7,
  max: 1.4,
  step: 0.05,
  maxSkus: 500,
};

/** Kills float drift: 0.7 + 3*0.05 must be exactly 0.85, not 0.8500000000001. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export class PriceLearner {
  private readonly rng: Rng;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly maxSkus: number;
  readonly multipliers: readonly number[];
  /** Map iteration order IS the LRU order: oldest first. */
  private readonly skus = new Map<string, ArmPosterior[]>();

  constructor(rng: Rng, opts: PriceLearnerOpts = DEFAULT_PRICE_OPTS) {
    if (!rng || typeof rng.next !== 'function') {
      throw new AresError('INVALID_RNG', 'PriceLearner: a seeded Rng must be injected');
    }
    const min = opts.min ?? DEFAULT_PRICE_OPTS.min;
    const max = opts.max ?? DEFAULT_PRICE_OPTS.max;
    const step = opts.step ?? DEFAULT_PRICE_OPTS.step;
    const maxSkus = opts.maxSkus ?? DEFAULT_PRICE_OPTS.maxSkus;
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) {
      throw new AresError('INVALID_PRICE_OPTS', 'PriceLearner: min/max/step must be finite', { opts });
    }
    if (min <= 0 || max < min || step <= 0 || step > max - min + Number.EPSILON) {
      throw new AresError('INVALID_PRICE_OPTS', 'PriceLearner: require 0 < min <= max and 0 < step <= (max-min)', {
        min,
        max,
        step,
      });
    }
    if (!Number.isInteger(maxSkus) || maxSkus < 1) {
      throw new AresError('INVALID_PRICE_OPTS', 'PriceLearner: maxSkus must be a positive integer', { maxSkus });
    }
    this.rng = rng;
    this.min = min;
    this.max = max;
    this.step = step;
    this.maxSkus = maxSkus;
    const steps: number[] = [];
    const count = Math.floor(round6((max - min) / step)) + 1;
    for (let i = 0; i < count; i++) steps.push(round6(min + i * step));
    this.multipliers = Object.freeze(steps);
  }

  /** Number of SKUs currently tracked (<= maxSkus). */
  get size(): number {
    return this.skus.size;
  }

  /** LRU order, oldest first. */
  trackedSkus(): string[] {
    return [...this.skus.keys()];
  }

  /** Snaps any multiplier onto the nearest configured step (clamped to range). */
  snap(multiplier: number): number {
    if (!Number.isFinite(multiplier)) {
      throw new AresError('INVALID_MULTIPLIER', `PriceLearner: multiplier must be finite, got ${String(multiplier)}`, {
        multiplier,
      });
    }
    return this.multipliers[this.snapIndex(multiplier)] as number;
  }

  private snapIndex(multiplier: number): number {
    const clamped = Math.min(this.max, Math.max(this.min, multiplier));
    const idx = Math.round((clamped - this.min) / this.step);
    return Math.min(this.multipliers.length - 1, Math.max(0, idx));
  }

  /** Touch = move to the MRU end; creates the SKU (and evicts) when unseen. */
  private touch(sku: string): ArmPosterior[] {
    if (typeof sku !== 'string' || sku.length === 0) {
      throw new AresError('INVALID_SKU', 'PriceLearner: sku must be a non-empty string', { sku });
    }
    const found = this.skus.get(sku);
    if (found !== undefined) {
      this.skus.delete(sku);
      this.skus.set(sku, found);
      return found;
    }
    const fresh: ArmPosterior[] = this.multipliers.map(() => ({ a: 1, b: 1, n: 0 }));
    this.skus.set(sku, fresh);
    while (this.skus.size > this.maxSkus) {
      const oldest = this.skus.keys().next();
      if (oldest.done) break;
      this.skus.delete(oldest.value);
    }
    return fresh;
  }

  /**
   * Thompson-samples a multiplier for this SKU and scales the baseline with
   * core/money.mul, so the result is always an integer Money in the baseline's
   * currency. An unseen SKU explores from a uniform prior; it never throws.
   */
  suggest(sku: string, baseline: Money): Money {
    if (!baseline || typeof baseline.amount !== 'number' || typeof baseline.currency !== 'string') {
      throw new AresError('INVALID_BASELINE', 'PriceLearner.suggest: baseline must be a Money', { baseline });
    }
    if (baseline.amount <= 0) {
      throw new AresError('INVALID_BASELINE', 'PriceLearner.suggest: baseline must be a positive price', {
        baseline,
      });
    }
    const steps = this.touch(sku);
    let bestIdx = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < steps.length; i++) {
      const p = steps[i] as ArmPosterior;
      const draw = sampleBeta(p.a, p.b, this.rng);
      if (draw > bestScore) {
        bestScore = draw;
        bestIdx = i;
      }
    }
    const chosen = this.multipliers[bestIdx] as number;
    const price = mul(baseline, chosen);
    // min > 0 and baseline >= 1 minor unit, so this only bites on a 1-unit
    // baseline rounding to 0; a zero or negative ask price is never valid.
    if (price.amount <= 0) return mul(baseline, 1);
    return price;
  }

  /** Feeds sell-through back. The multiplier is snapped, never stored raw. */
  observe(sku: string, multiplier: number, sold: boolean): void {
    if (typeof sold !== 'boolean') {
      throw new AresError('INVALID_OBSERVATION', 'PriceLearner.observe: sold must be a boolean', { sku, sold });
    }
    const steps = this.touch(sku);
    const p = steps[this.snapIndex(this.assertFinite(multiplier))] as ArmPosterior;
    if (sold) p.a += 1;
    else p.b += 1;
    p.n += 1;
  }

  private assertFinite(multiplier: number): number {
    if (!Number.isFinite(multiplier)) {
      throw new AresError('INVALID_MULTIPLIER', `PriceLearner: multiplier must be finite, got ${String(multiplier)}`, {
        multiplier,
      });
    }
    return multiplier;
  }

  /** Posterior means per multiplier for a SKU (diagnostics / dashboard). */
  posterior(sku: string): Array<{ multiplier: number; a: number; b: number; mean: number; n: number }> | null {
    const steps = this.skus.get(sku);
    if (steps === undefined) return null;
    return steps.map((p, i) => ({
      multiplier: this.multipliers[i] as number,
      a: p.a,
      b: p.b,
      mean: p.a / (p.a + p.b),
      n: p.n,
    }));
  }

  toJSON(): PriceLearnerJSON {
    return {
      version: PRICE_LEARNER_VERSION,
      min: this.min,
      max: this.max,
      step: this.step,
      maxSkus: this.maxSkus,
      skus: [...this.skus.entries()].map(([sku, steps]) => ({
        sku,
        steps: steps.map((p) => ({ a: p.a, b: p.b, n: p.n })),
      })),
    };
  }

  static fromJSON(json: unknown, rng: Rng): PriceLearner {
    if (typeof json !== 'object' || json === null) {
      throw new AresError('INVALID_PRICE_JSON', 'PriceLearner.fromJSON: not an object', { json });
    }
    const rec = json as Partial<PriceLearnerJSON>;
    const opts: PriceLearnerOpts = {
      min: typeof rec.min === 'number' ? rec.min : DEFAULT_PRICE_OPTS.min,
      max: typeof rec.max === 'number' ? rec.max : DEFAULT_PRICE_OPTS.max,
      step: typeof rec.step === 'number' ? rec.step : DEFAULT_PRICE_OPTS.step,
      maxSkus: typeof rec.maxSkus === 'number' ? rec.maxSkus : DEFAULT_PRICE_OPTS.maxSkus,
    };
    const pl = new PriceLearner(rng, opts);
    const rows = Array.isArray(rec.skus) ? rec.skus : [];
    for (const row of rows) {
      if (!row || typeof row.sku !== 'string' || !Array.isArray(row.steps)) {
        throw new AresError('INVALID_PRICE_JSON', 'PriceLearner.fromJSON: malformed sku row', { row });
      }
      if (row.steps.length !== pl.multipliers.length) {
        throw new AresError('INVALID_PRICE_JSON', 'PriceLearner.fromJSON: step count does not match the grid', {
          sku: row.sku,
          got: row.steps.length,
          want: pl.multipliers.length,
        });
      }
      const steps = row.steps.map((p) => ({
        a: typeof p.a === 'number' ? p.a : 1,
        b: typeof p.b === 'number' ? p.b : 1,
        n: typeof p.n === 'number' ? p.n : 0,
      }));
      pl.skus.set(row.sku, steps);
    }
    while (pl.skus.size > pl.maxSkus) {
      const oldest = pl.skus.keys().next();
      if (oldest.done) break;
      pl.skus.delete(oldest.value);
    }
    return pl;
  }
}
