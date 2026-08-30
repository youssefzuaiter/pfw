import { addAgorot, isNegativeAgorot, ZERO_AGOROT, type Agorot } from "./money";
import type { LiquidityBreakdown } from "./liquidity-classification";

/**
 * Runway-forecasting half of the Real-Time Liquidity Runway & Burn-Rate
 * Engine (AGENTS.md §3v). Pure function over already-computed inputs
 * (a `LiquidityBreakdown` from `liquidity-classification.ts`, a monthly
 * burn rate from `burn-rate.ts`), same `src/lib/` convention as every
 * other engine (§3b).
 *
 * Average days per calendar month (365.25/12, the standard "average
 * Gregorian month" constant already used for exactly this kind of
 * day-precision conversion in actuarial/finance contexts) — not a flat
 * 30 or 31, and not a real calendar walk (unlike
 * `cash-flow-forecast.ts`'s day-by-day simulation): a runway figure is a
 * single point-in-time RATE-based estimate ("at your current burn rate,
 * how many days"), not a projection of specific future calendar dates,
 * so there's no real calendar for it to walk — the average-month
 * constant is what makes "day-precision" meaningful without pretending
 * to know which specific future months will have 28, 30, or 31 days in
 * them.
 */
export const AVERAGE_DAYS_PER_MONTH = 365.25 / 12;

export type LiquidityRunwayResult = {
  /** Liquid + semi-liquid assets — illiquid assets are deliberately excluded, per the spec's own framing ("divide available liquid/semi-liquid assets by burn rate"): a paid-off apartment or a locked pension can't fund next month's rent no matter how large it is. */
  availableAgorot: Agorot;
  monthlyBurnRateAgorot: Agorot;
  /** A rate, not a stored monetary amount — deliberately a plain `number`, not `Agorot`, matching `money.ts`'s own established distinction between money (integer agorot) and a ratio/rate derived from it (e.g. `multiplyAgorot`'s `factor` parameter). A fraction-of-an-agorot-per-day is expected and correct here, not a rounding bug. */
  dailyBurnRateAgorot: number;
  /**
   * `null` means infinite runway (zero or negative burn rate — spending
   * nothing, or net saving) — deliberately NOT `Infinity`: `Infinity`
   * survives arithmetic in confusing ways (`Infinity - 5 === Infinity`)
   * and doesn't survive `JSON.stringify` (silently becomes `null` in a
   * `NextResponse.json()` body anyway, per Section 2's "every route
   * handler's response must be valid JSON" — better to make that
   * conversion explicit and intentional here than to rely on an
   * accidental serialization quirk). A finite result is never negative:
   * `availableAgorot <= 0` with a positive burn rate reports exactly
   * `0`, not a negative "days already overdrawn" figure — see this
   * function's own doc comment for why.
   */
  runwayDays: number | null;
};

/**
 * `availableAgorot <= 0` (structurally rare in this app — bank checking/
 * savings balances and portfolio holding values are never negative, see
 * `computeLiveNetWorth`'s own doc comment — but defended against
 * anyway, the same belt-and-suspenders habit this codebase applies
 * everywhere) reports exactly 0 days of runway, not a negative number.
 * A negative "days remaining" has no natural reading (day -12 isn't a
 * real point the user is trying to picture) — 0 correctly reads as
 * "you have no runway left," which is the true state being described.
 */
export function calculateLiquidityRunway(
  breakdown: LiquidityBreakdown,
  monthlyBurnRateAgorot: Agorot,
): LiquidityRunwayResult {
  const availableAgorot = addAgorot(breakdown.liquidAgorot, breakdown.semiLiquidAgorot);
  const dailyBurnRateAgorot = monthlyBurnRateAgorot / AVERAGE_DAYS_PER_MONTH;

  const runwayDays =
    monthlyBurnRateAgorot <= 0
      ? null
      : isNegativeAgorot(availableAgorot) || availableAgorot === ZERO_AGOROT
        ? 0
        : availableAgorot / dailyBurnRateAgorot;

  return { availableAgorot, monthlyBurnRateAgorot, dailyBurnRateAgorot, runwayDays };
}
