/**
 * core/rng.ts — the ONLY source of randomness in the swarm (no Math.random).
 * Invariant: a given seed always produces the same stream, so a whole run is
 * reproducible from cfg.seed; xorshift128+ seeded through splitmix64.
 * Callers: agents, channel simulators, bandits, tests.
 */

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(a: T[]): T;
  gauss(mu: number, sigma: number): number;
}

const MASK64 = (1n << 64n) - 1n;

function splitmix64(state: bigint): { value: bigint; state: bigint } {
  let s = (state + 0x9e3779b97f4a7c15n) & MASK64;
  let z = s;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  z = z ^ (z >> 31n);
  s = s & MASK64;
  return { value: z & MASK64, state: s };
}

class Xorshift128Plus implements Rng {
  private s0: bigint;
  private s1: bigint;
  private spare: number | null = null;

  constructor(seed: number) {
    if (!Number.isFinite(seed)) throw new RangeError(`makeRng: seed must be finite, got ${String(seed)}`);
    let st = BigInt(Math.trunc(seed)) & MASK64;
    const a = splitmix64(st);
    st = a.state;
    const b = splitmix64(st);
    this.s0 = a.value === 0n && b.value === 0n ? 0x9e3779b97f4a7c15n : a.value;
    this.s1 = b.value === 0n ? 0xbf58476d1ce4e5b9n : b.value;
  }

  private next64(): bigint {
    let x = this.s0;
    const y = this.s1;
    this.s0 = y;
    x = x ^ ((x << 23n) & MASK64);
    this.s1 = (x ^ y ^ (x >> 17n) ^ (y >> 26n)) & MASK64;
    return (this.s1 + y) & MASK64;
  }

  /** Uniform in [0, 1). 53 bits of entropy. */
  next(): number {
    return Number(this.next64() >> 11n) / 9007199254740992; // 2^53
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`Rng.int: maxExclusive must be a positive integer, got ${String(maxExclusive)}`);
    }
    const v = Math.floor(this.next() * maxExclusive);
    return v >= maxExclusive ? maxExclusive - 1 : v;
  }

  pick<T>(a: T[]): T {
    if (!Array.isArray(a) || a.length === 0) throw new RangeError('Rng.pick: empty array');
    const idx = this.int(a.length);
    // Safe: idx is always within [0, a.length).
    return a[idx] as T;
  }

  gauss(mu: number, sigma: number): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return mu + sigma * s;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return mu + sigma * (u * mul);
  }
}

export function makeRng(seed: number): Rng {
  return new Xorshift128Plus(seed);
}
