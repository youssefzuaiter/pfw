import { agorot, ZERO_AGOROT, type Agorot } from "./money";

/**
 * Probabilistic FIRE / retirement Monte Carlo engine (AGENTS.md §3n).
 * Pure function over already-fetched data, following the same convention
 * as every other engine in `src/lib/` (§3b) — nothing here touches the
 * DAL or the database, which is what makes it testable with plain data
 * literals. `src/server/analytics/build-monte-carlo-data.ts` is what
 * feeds it real net worth/allocation/savings-rate figures.
 *
 * Model: each of `numSimulations` independent paths walks forward one
 * year at a time from `currentAge` to `endAge`. Every year draws THREE
 * independent normal random variables — a growth-asset return, a
 * cash-asset return, and an inflation rate — blends the two return draws
 * by `growthAllocationShare`, and subtracts the inflation draw to get a
 * real (inflation-adjusted) return for that year. During working years
 * (age < retirementAge) `annualSavingsAgorot` is added after growth;
 * during retirement years it's `annualSpendAgorot` subtracted instead.
 * Every year's balance is still an `Agorot` at rest — the "money is never
 * a float" law applies just as much inside a stochastic simulation loop
 * as anywhere else in the app — but the per-year update computes the
 * plain-float delta first and rounds/clamps once via `safeAgorot`, rather
 * than chaining `multiplyAgorot`/`addAgorot`/`subtractAgorot` calls: an
 * extreme-volatility input (see the numerical-stability test for exactly
 * this) can compound a balance past `Number.MAX_SAFE_INTEGER` well within
 * a realistic simulation horizon, and `multiplyAgorot` would throw right
 * there rather than let the request finish. `safeAgorot` saturates
 * instead — an astronomically, unrealistically large outcome is still a
 * *success* for that path, not a crash for the whole request.
 *
 * Sequence-of-returns risk is not a special case bolted on afterward —
 * it falls straight out of simulating years *in order* with per-year
 * draws and compounding, rather than applying one average return across
 * the whole horizon. A bad early-retirement crash and the same crash
 * decades into retirement produce different survival outcomes here for
 * exactly that reason.
 */

/** 100 years is far beyond any realistic currentAge->endAge span; this only exists to
 * bound worst-case work for a malformed input, same reasoning as debt-math.ts's
 * MAX_SIMULATED_MONTHS. */
const MAX_SIMULATION_YEARS = 100;

/** Defends the engine itself, independent of whatever cap the API route applies to
 * client-supplied input. */
const MAX_NUM_SIMULATIONS = 20_000;

/**
 * A single-year return can statistically go below -100% under a normal
 * distribution with enough variance (a normal curve has no floor), which
 * is nonsensical for a real portfolio — you can't lose more than
 * everything. Floored at -99%, not -100%, so `multiplyAgorot`'s `1 +
 * realReturn` factor never rounds to exactly zero and this stays a
 * meaningfully "very bad year" rather than an exact wipeout every time.
 */
const MIN_ANNUAL_RETURN = -0.99;

export type MonteCarloAssumptions = {
  /** Nominal annual mean/stdDev for the "growth" portion of the portfolio (equities/ETFs/crypto in this app's model). */
  growthReturnMean: number;
  growthReturnStdDev: number;
  /** Nominal annual mean/stdDev for the "cash" portion (bank balances). */
  cashReturnMean: number;
  cashReturnStdDev: number;
  /** Annual inflation mean/stdDev, drawn independently of both return distributions. */
  inflationMean: number;
  inflationStdDev: number;
};

/** Plausible mock defaults — this is a demo app with a mocked market feed, not a source of real financial advice. */
export const DEFAULT_MONTE_CARLO_ASSUMPTIONS: MonteCarloAssumptions = {
  growthReturnMean: 0.09,
  growthReturnStdDev: 0.16,
  cashReturnMean: 0.03,
  cashReturnStdDev: 0.015,
  inflationMean: 0.025,
  inflationStdDev: 0.012,
};

export const DEFAULT_NUM_SIMULATIONS = 5_000;
export const DEFAULT_END_AGE = 95;

export type MonteCarloInput = MonteCarloAssumptions & {
  startingNetWorthAgorot: Agorot;
  /** Not read from any stored field — this app never stores a date of birth (AGENTS.md law #6), so
   * age is a per-request simulation input, never persisted. */
  currentAge: number;
  retirementAge: number;
  /** The simulation horizon's end age. Not currentAge-relative on purpose — two people the same age
   * with different endAge assumptions are asking genuinely different questions. */
  endAge: number;
  annualSavingsAgorot: Agorot;
  annualSpendAgorot: Agorot;
  /** Share (0..1) of the starting balance modeled as "growth" assets; the rest is "cash". A single
   * static split for the whole horizon — no glide path — see AGENTS.md §3n for why. */
  growthAllocationShare: number;
  numSimulations: number;
  /** Injectable for reproducible tests; production callers should leave this unset (defaults to `Math.random`). */
  randomFn?: () => number;
};

export type YearlyPercentile = {
  age: number;
  p10: Agorot;
  p50: Agorot;
  p90: Agorot;
};

export type MonteCarloResult = {
  numSimulations: number;
  /** Fraction of paths (0..1) whose balance never hit zero during a retirement year, all the way to endAge. */
  probabilityOfSuccess: number;
  /** One entry per age from currentAge to endAge, inclusive — the fan-chart data. */
  yearlyPercentiles: YearlyPercentile[];
  medianFinalBalance: Agorot;
  /** The 10th percentile of final-age outcomes — "in the worst 10% of paths, you'd have this much left." */
  worstDecileFinalBalance: Agorot;
};

function validateInput(input: MonteCarloInput): void {
  if (!Number.isInteger(input.currentAge) || input.currentAge < 0) {
    throw new RangeError(`currentAge must be a non-negative integer, received ${input.currentAge}`);
  }
  if (!Number.isInteger(input.retirementAge)) {
    throw new RangeError(`retirementAge must be an integer, received ${input.retirementAge}`);
  }
  if (!Number.isInteger(input.endAge) || input.endAge <= input.currentAge) {
    throw new RangeError(`endAge must be an integer greater than currentAge, received ${input.endAge}`);
  }
  if (input.endAge - input.currentAge > MAX_SIMULATION_YEARS) {
    throw new RangeError(`Simulation horizon cannot exceed ${MAX_SIMULATION_YEARS} years`);
  }
  if (!Number.isInteger(input.numSimulations) || input.numSimulations <= 0) {
    throw new RangeError(`numSimulations must be a positive integer, received ${input.numSimulations}`);
  }
  if (input.numSimulations > MAX_NUM_SIMULATIONS) {
    throw new RangeError(`numSimulations cannot exceed ${MAX_NUM_SIMULATIONS}`);
  }
  if (input.annualSavingsAgorot < 0) {
    throw new RangeError(`annualSavingsAgorot must not be negative, received ${input.annualSavingsAgorot}`);
  }
  if (input.annualSpendAgorot < 0) {
    throw new RangeError(`annualSpendAgorot must not be negative, received ${input.annualSpendAgorot}`);
  }
  if (input.growthAllocationShare < 0 || input.growthAllocationShare > 1) {
    throw new RangeError(`growthAllocationShare must be between 0 and 1, received ${input.growthAllocationShare}`);
  }
  for (const [label, value] of [
    ["growthReturnStdDev", input.growthReturnStdDev],
    ["cashReturnStdDev", input.cashReturnStdDev],
    ["inflationStdDev", input.inflationStdDev],
  ] as const) {
    if (value < 0) throw new RangeError(`${label} must not be negative, received ${value}`);
  }
}

/**
 * Box-Muller transform — one standard-normal sample per call (the
 * transform actually yields two independent samples per pair of
 * uniforms; this discards the second for code clarity, which costs
 * nothing meaningful at this scale). `u1` is re-drawn if it lands
 * exactly on 0, since `Math.log(0)` is `-Infinity`.
 */
function sampleStandardNormal(randomFn: () => number): number {
  let u1 = randomFn();
  while (u1 === 0) u1 = randomFn();
  const u2 = randomFn();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleNormal(mean: number, stdDev: number, randomFn: () => number): number {
  return mean + stdDev * sampleStandardNormal(randomFn);
}

/** mulberry32 — mirrors prisma/seed/rng.ts's algorithm (duplicated rather than imported: that
 * module lives in the seed-script/tooling area, not a dependency `src/lib` should reach into). */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile of an ascending-sorted array — adequate precision for a probabilistic estimate, not a rigorous interpolated statistic. */
function percentileOf(sortedAscending: readonly number[], p: number): number {
  const index = Math.min(sortedAscending.length - 1, Math.max(0, Math.floor(p * sortedAscending.length)));
  return sortedAscending[index];
}

/**
 * Rounds a plain float to the nearest whole agorot (half away from zero,
 * matching `money.ts`'s `multiplyAgorot` convention) and clamps it into
 * `Agorot`'s safe-integer range before construction, rather than letting
 * `agorot()` throw on a value this engine's own extreme-input tests can
 * legitimately produce. See this file's header comment for why that
 * clamp belongs here instead of a tighter per-year return cap: no return
 * cap generous enough to permit realistic strong-growth years would also
 * be tight enough to prevent overflow across up to 100 compounding years.
 */
function safeAgorot(value: number): Agorot {
  const clamped = Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value));
  return agorot(Math.sign(clamped) * Math.round(Math.abs(clamped)));
}

export function runMonteCarloSimulation(input: MonteCarloInput): MonteCarloResult {
  validateInput(input);
  const randomFn = input.randomFn ?? Math.random;
  const numAges = input.endAge - input.currentAge + 1; // includes the starting age itself

  // balancesByYearIndex[i] collects every path's balance at age (currentAge + i).
  const balancesByYearIndex: number[][] = Array.from({ length: numAges }, () => []);
  let successCount = 0;

  for (let sim = 0; sim < input.numSimulations; sim++) {
    let balance: Agorot = input.startingNetWorthAgorot;
    balancesByYearIndex[0].push(balance);
    let failed = false;

    for (let yearIndex = 1; yearIndex < numAges; yearIndex++) {
      const age = input.currentAge + yearIndex - 1; // the age this year-step starts at
      const isWorking = age < input.retirementAge;

      const growthDraw = sampleNormal(input.growthReturnMean, input.growthReturnStdDev, randomFn);
      const cashDraw = sampleNormal(input.cashReturnMean, input.cashReturnStdDev, randomFn);
      const inflationDraw = sampleNormal(input.inflationMean, input.inflationStdDev, randomFn);
      const nominalReturn = input.growthAllocationShare * growthDraw + (1 - input.growthAllocationShare) * cashDraw;
      const realReturn = Math.max(nominalReturn - inflationDraw, MIN_ANNUAL_RETURN);

      const grown = balance * (1 + realReturn);
      const adjusted = isWorking ? grown + input.annualSavingsAgorot : grown - input.annualSpendAgorot;
      balance = safeAgorot(adjusted);

      if (!isWorking && balance <= 0) {
        failed = true;
        for (let fillIndex = yearIndex; fillIndex < numAges; fillIndex++) {
          balancesByYearIndex[fillIndex].push(ZERO_AGOROT);
        }
        break;
      }

      balancesByYearIndex[yearIndex].push(balance);
    }

    if (!failed) successCount++;
  }

  const yearlyPercentiles: YearlyPercentile[] = balancesByYearIndex.map((balances, i) => {
    const sorted = [...balances].sort((a, b) => a - b);
    return {
      age: input.currentAge + i,
      p10: agorot(percentileOf(sorted, 0.1)),
      p50: agorot(percentileOf(sorted, 0.5)),
      p90: agorot(percentileOf(sorted, 0.9)),
    };
  });

  const finalBalances = [...balancesByYearIndex[numAges - 1]].sort((a, b) => a - b);

  return {
    numSimulations: input.numSimulations,
    probabilityOfSuccess: successCount / input.numSimulations,
    yearlyPercentiles,
    medianFinalBalance: agorot(percentileOf(finalBalances, 0.5)),
    worstDecileFinalBalance: agorot(percentileOf(finalBalances, 0.1)),
  };
}
