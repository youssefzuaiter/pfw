/**
 * Deterministic, monthly-seeded RNG. The seed is derived from the current
 * calendar month ("YYYY-MM"), so re-running the seed script within the
 * same month always produces byte-for-byte identical mock data — but the
 * demo data set "refreshes" to a different (still fully deterministic)
 * dataset every new month, so it doesn't feel stale in a long-running demo
 * deployment.
 *
 * mulberry32 is a small, well-known 32-bit PRNG — not cryptographic, and
 * not meant to be; it only needs to be fast and reproducible.
 */

export function hashStringToSeed(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SeededRng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** [0, 1) */
  float(): number {
    return this.next();
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.float() * (max - min + 1)) + min;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError("Cannot pick from an empty array");
    }
    return items[this.int(0, items.length - 1)];
  }

  /** True with the given probability (default: fair coin). */
  bool(probability = 0.5): boolean {
    return this.float() < probability;
  }

  /** Fisher-Yates shuffle — does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

/** "YYYY-MM" for the given date, UTC — the unit the seed changes on. */
export function monthKeyFor(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function getMonthlySeed(date: Date = new Date()): number {
  return hashStringToSeed(`pfw-seed-${monthKeyFor(date)}`);
}
