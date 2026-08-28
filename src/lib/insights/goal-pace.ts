import { formatAgorot, multiplyAgorot, type Agorot } from "../money";
import { computeRank, type Insight } from "./types";

/** Below 90% of the expected linear pace counts as "off pace"; below 50% escalates to critical. */
const WARNING_PACE_RATIO = 0.9;
const CRITICAL_PACE_RATIO = 0.5;

export type GoalPaceInput = {
  goalId: string;
  goalName: string;
  targetAmount: Agorot;
  /** Derived from summing GoalContribution rows — never stored directly (the "derived truth" law). */
  currentAmount: Agorot;
  startDate: Date;
  /** Goals with no target date have no pace to measure against — omit and this goal is simply skipped. */
  targetDate?: Date;
  today: Date;
};

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000);
}

export function generateGoalPaceInsights(goals: readonly GoalPaceInput[]): Insight[] {
  const insights: Insight[] = [];

  for (const goal of goals) {
    if (!goal.targetDate || goal.targetDate <= goal.startDate || goal.targetAmount <= 0) continue;
    const isComplete = goal.currentAmount >= goal.targetAmount;
    if (isComplete) continue;

    if (goal.today >= goal.targetDate) {
      insights.push({
        type: "goal_off_pace",
        severity: "critical",
        rank: computeRank("critical", 90),
        title: `${goal.goalName} is past its target date`,
        description: `Reached ${formatAgorot(goal.currentAmount)} of ${formatAgorot(goal.targetAmount)} by the target date.`,
        relatedEntityId: goal.goalId,
      });
      continue;
    }

    const totalDurationDays = daysBetween(goal.startDate, goal.targetDate);
    const elapsedDays = Math.min(Math.max(daysBetween(goal.startDate, goal.today), 0), totalDurationDays);
    const expectedFraction = elapsedDays / totalDurationDays;
    if (expectedFraction <= 0) continue; // goal just started; nothing to measure yet

    const expectedAmount = multiplyAgorot(goal.targetAmount, expectedFraction);
    if (expectedAmount <= 0) continue;

    const paceRatio = goal.currentAmount / expectedAmount;
    if (paceRatio >= WARNING_PACE_RATIO) continue;

    const severity = paceRatio < CRITICAL_PACE_RATIO ? "critical" : "warning";
    const shortfallPercent = (1 - paceRatio) * 100;

    // Extrapolate a projected completion date from the actual rate achieved so far.
    const actualFraction = goal.currentAmount / goal.targetAmount;
    let projectionNote = "";
    if (actualFraction > 0) {
      const projectedTotalDays = elapsedDays / actualFraction;
      const projectedCompletion = new Date(goal.startDate.getTime() + projectedTotalDays * 24 * 60 * 60 * 1000);
      projectionNote = ` At the current pace, projected completion is around ${projectedCompletion.toISOString().slice(0, 10)}.`;
    }

    insights.push({
      type: "goal_off_pace",
      severity,
      rank: computeRank(severity, shortfallPercent),
      title: `${goal.goalName} is falling behind pace`,
      description: `Reached ${formatAgorot(goal.currentAmount)} of ${formatAgorot(goal.targetAmount)} — about ${Math.round(shortfallPercent)}% short of the pace needed to hit the target date.${projectionNote}`,
      relatedEntityId: goal.goalId,
    });
  }

  return insights;
}
