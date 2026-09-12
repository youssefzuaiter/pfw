import { multiplyAgorot, type Agorot } from "./money";

/**
 * Full goal-progress summary for display (the /goals screen). Distinct
 * from src/lib/insights/goal-pace.ts, which only decides "is this
 * worth alerting about" (a narrower, binary question) — this describes
 * the complete state, including goals that are perfectly on track, which
 * the insight generator never surfaces at all.
 */

export type GoalProgressStatus = "complete" | "no_target_date" | "overdue" | "ahead" | "on_track" | "behind";

export type GoalProgressSummary = {
  progressPercent: number;
  status: GoalProgressStatus;
  /** Extrapolated from the contribution rate achieved so far — null until at least one contribution has landed. */
  projectedCompletionDate: Date | null;
};

const AHEAD_PACE_RATIO = 1.1;
const ON_TRACK_PACE_RATIO = 0.9;

/**
 * How far ahead a linear extrapolation is still worth reporting. Beyond
 * this the projection has stopped being information — "you'll finish in
 * the year 402,193" tells a user nothing that "not on any meaningful
 * pace" doesn't say better.
 */
const MAX_PROJECTION_YEARS = 100;
const MAX_PROJECTION_DAYS = MAX_PROJECTION_YEARS * 365.25;

/**
 * Linear "at this rate, when does it finish" extrapolation, shared with
 * src/lib/insights/goal-pace.ts so both surfaces project identically.
 *
 * Returns `null` rather than a Date whenever the extrapolation isn't
 * meaningful OR isn't representable. That second case is a real,
 * verified crash this guard exists to prevent, not a hypothetical:
 * `completedFraction` is `currentAmount / targetAmount`, so a tiny
 * contribution against a large target (₪0.01 toward a ₪50,000 goal —
 * a fraction of 2e-7) makes `elapsedDays / completedFraction` around
 * 1.5e8 days. Adding that to `startDate` overflows ECMAScript's
 * ±8.64e15 ms Date range, `new Date(...)` silently becomes `Invalid
 * Date`, and the very next `.toISOString()` throws `RangeError: Invalid
 * time value`. With no try/catch anywhere up the chain and no
 * `error.tsx` boundary, that single row took down `/dashboard` (via
 * generateInsights), `/goals`, and the advisor's `list_goals_with_progress`
 * tool outright.
 */
export function projectCompletionDate(
  startDate: Date,
  elapsedDays: number,
  completedFraction: number,
): Date | null {
  if (!Number.isFinite(completedFraction) || completedFraction <= 0) return null;
  if (!Number.isFinite(elapsedDays) || elapsedDays <= 0) return null;

  const projectedTotalDays = elapsedDays / completedFraction;
  if (!Number.isFinite(projectedTotalDays) || projectedTotalDays > MAX_PROJECTION_DAYS) return null;

  const projected = new Date(startDate.getTime() + projectedTotalDays * 24 * 60 * 60 * 1000);
  // Belt-and-braces: a far-future `startDate` could still push an
  // in-range offset out of range, and an invalid Date is only ever
  // detectable after construction.
  return Number.isNaN(projected.getTime()) ? null : projected;
}

export function summarizeGoalProgress(input: {
  targetAmount: Agorot;
  currentAmount: Agorot;
  startDate: Date;
  targetDate?: Date;
  today: Date;
}): GoalProgressSummary {
  const progressPercent = input.targetAmount > 0 ? (input.currentAmount / input.targetAmount) * 100 : 0;

  if (input.currentAmount >= input.targetAmount) {
    return { progressPercent, status: "complete", projectedCompletionDate: null };
  }

  const elapsedDays = Math.max((input.today.getTime() - input.startDate.getTime()) / (24 * 60 * 60 * 1000), 0);
  const actualFraction = input.targetAmount > 0 ? input.currentAmount / input.targetAmount : 0;

  const projectedCompletionDate = projectCompletionDate(input.startDate, elapsedDays, actualFraction);

  if (!input.targetDate) {
    return { progressPercent, status: "no_target_date", projectedCompletionDate };
  }

  if (input.today >= input.targetDate) {
    return { progressPercent, status: "overdue", projectedCompletionDate };
  }

  const totalDays = (input.targetDate.getTime() - input.startDate.getTime()) / (24 * 60 * 60 * 1000);
  const expectedFraction = totalDays > 0 ? Math.min(elapsedDays / totalDays, 1) : 1;
  const expectedAmount = multiplyAgorot(input.targetAmount, expectedFraction);
  const paceRatio = expectedAmount > 0 ? input.currentAmount / expectedAmount : 1;

  let status: GoalProgressStatus;
  if (paceRatio >= AHEAD_PACE_RATIO) status = "ahead";
  else if (paceRatio >= ON_TRACK_PACE_RATIO) status = "on_track";
  else status = "behind";

  return { progressPercent, status, projectedCompletionDate };
}
