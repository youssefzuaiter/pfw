export type InsightSeverity = "critical" | "warning" | "info";

export type InsightType =
  | "budget_breach"
  | "spending_spike"
  | "cash_flow_risk"
  | "goal_off_pace"
  | "portfolio_concentration"
  | "recurring_charge_detected"
  | "transaction_review_needed";

export type Insight = {
  type: InsightType;
  severity: InsightSeverity;
  /** Higher = more urgent. Severity dominates (critical always outranks warning/info); financial impact breaks ties within a severity band. See computeRank(). */
  rank: number;
  title: string;
  description: string;
  relatedEntityId?: string;
};

const SEVERITY_BASE_RANK: Record<InsightSeverity, number> = {
  critical: 200,
  warning: 100,
  info: 0,
};

/**
 * Combines severity and a domain-specific impact score into one sortable
 * rank. `impactScore` should be a roughly 0-99 measure of "how big/urgent
 * is this, within its own severity band" — it's clamped defensively so a
 * generator with a badly-scaled impact score still can't leak into a
 * different severity's rank range.
 */
export function computeRank(severity: InsightSeverity, impactScore: number): number {
  return SEVERITY_BASE_RANK[severity] + Math.min(Math.max(impactScore, 0), 99);
}

/** Ranks highest-priority first — the order the /dashboard attention feed renders in. */
export function rankInsights(insights: readonly Insight[]): Insight[] {
  return [...insights].sort((a, b) => b.rank - a.rank);
}
