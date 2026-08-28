import type { CashFlowForecast } from "../cash-flow-forecast";
import { agorot, formatAgorot, type Agorot } from "../money";
import { computeRank, type Insight } from "./types";

export type CashFlowRiskThresholds = {
  /** Projected minimum at or below this is a critical risk (default: going negative at all). */
  criticalBelow: Agorot;
  /** Projected minimum at or below this (but above criticalBelow) is a warning (default: a thin ₪500 cushion). */
  warningBelow: Agorot;
};

const DEFAULT_THRESHOLDS: CashFlowRiskThresholds = {
  criticalBelow: agorot(0),
  warningBelow: agorot(50_000),
};

/**
 * Surfaces the forecast's own minimum-balance point as an insight when
 * it's low enough to matter — the forecast engine already does the hard
 * work of finding "the absolute minimum cash point, not just the ending
 * balance"; this just decides whether that point is alarming.
 */
export function generateCashFlowRiskInsights(
  forecast: CashFlowForecast,
  thresholds: CashFlowRiskThresholds = DEFAULT_THRESHOLDS,
): Insight[] {
  const { minimum } = forecast;
  const dateLabel = minimum.date.toISOString().slice(0, 10);

  if (minimum.balance <= thresholds.criticalBelow) {
    const scale = Math.max(Math.abs(thresholds.warningBelow), 1);
    return [
      {
        type: "cash_flow_risk",
        severity: "critical",
        rank: computeRank("critical", (Math.abs(minimum.balance) / scale) * 50),
        title: "Cash flow risk: balance projected to go negative",
        description: `Projected balance drops to ${formatAgorot(minimum.balance)} on ${dateLabel}.`,
      },
    ];
  }

  if (minimum.balance <= thresholds.warningBelow) {
    const range = Math.max(thresholds.warningBelow - thresholds.criticalBelow, 1);
    const proximityToCritical = ((thresholds.warningBelow - minimum.balance) / range) * 100;
    return [
      {
        type: "cash_flow_risk",
        severity: "warning",
        rank: computeRank("warning", proximityToCritical),
        title: "Cash flow running low",
        description: `Projected balance dips to ${formatAgorot(minimum.balance)} on ${dateLabel} — a thin cushion.`,
      },
    ];
  }

  return [];
}
