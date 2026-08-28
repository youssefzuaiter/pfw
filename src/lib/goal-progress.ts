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

  const projectedCompletionDate =
    actualFraction > 0 && elapsedDays > 0
      ? new Date(input.startDate.getTime() + (elapsedDays / actualFraction) * 24 * 60 * 60 * 1000)
      : null;

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
