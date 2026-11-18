/**
 * The dashboard shows two forecasts of the same cash, built on different
 * assumptions (AGENTS.md §3qqqq):
 *
 *  - the 60-day forecast counts what is KNOWN to be coming: bills, regular
 *    charges, and an average of everyday spending. It assumes no new income
 *    unless a deposit was detected as regular, so it answers "what if no
 *    new money arrives";
 *  - the 30-day forecast learns from the last 90 days of actual net cash
 *    flow, income included, and knows nothing about a specific bill coming
 *    due, so it answers "what if the last 90 days repeat".
 *
 * Both start from the same cash, so they can finish on opposite sides of it
 * (one -$385, the other +$5,000) without either being wrong. This decides
 * when that is worth a sentence, in plain money, so the screen can say why
 * instead of leaving two contradicting numbers side by side.
 */

/** Below this many minor units (₪1 = 100) a gap is rounding noise whatever the balance. */
export const MINIMUM_NOTEWORTHY_GAP_MINOR = 10_000;

/** A gap must also be at least this share of the larger balance involved. */
export const NOTEWORTHY_GAP_SHARE = 0.1;

export type ForecastComparisonInput = {
  /** Cash today, in the reporting currency's minor units. */
  startingMinor: number;
  /** The 60-day (bills and average spending) forecast on the day the 30-day one ends. */
  knownMinor: number;
  /** The 30-day forecast's median on its last day. */
  patternMinor: number;
};

export type ForecastComparison = {
  /** True when one forecast ends above today's cash and the other below it. */
  oppositeDirections: boolean;
};

/** Returns null when the two forecasts agree closely enough that explaining them would only add noise. */
export function compareForecasts(input: ForecastComparisonInput): ForecastComparison | null {
  const { startingMinor, knownMinor, patternMinor } = input;
  if (![startingMinor, knownMinor, patternMinor].every(Number.isFinite)) return null;

  const gap = Math.abs(patternMinor - knownMinor);
  const scale = Math.max(Math.abs(startingMinor), Math.abs(knownMinor), Math.abs(patternMinor));
  if (gap < MINIMUM_NOTEWORTHY_GAP_MINOR || gap < scale * NOTEWORTHY_GAP_SHARE) return null;

  const knownChange = knownMinor - startingMinor;
  const patternChange = patternMinor - startingMinor;
  return { oppositeDirections: knownChange * patternChange < 0 };
}

/** Average net cash flow per day over a history, in the history's own unit; zero for an empty one. */
export function averageDailyNet(dailyNet: readonly number[]): number {
  if (dailyNet.length === 0) return 0;
  return Math.round(dailyNet.reduce((sum, value) => sum + value, 0) / dailyNet.length);
}
