import { formatAgorot, type Agorot } from "../money";
import { computeRank, type Insight } from "./types";

/**
 * Zero-Sum Envelope Budgeting migration: this generator now reads the
 * ROLLING balance (`src/server/dal/envelopes.ts`'s `getEnvelopeBalances`)
 * instead of a stateless monthly-limit-vs-spend ratio — the old
 * "spent >= 100% of this month's limit" framing doesn't even apply
 * anymore in a system where a category can go whole months with no NEW
 * allocation at all, relying purely on carried-forward surplus.
 *
 * "Breach" (critical): the envelope's rolling balance is negative — it
 * has, in total, spent more than has EVER been allocated to it. This is
 * the correct, unambiguous "zero-sum breach" signal, and it's exactly
 * as meaningful for a category with zero activity this month (a deficit
 * carried forward from a prior month) as one with fresh overspending.
 *
 * "Warning": nothing spent this month never warns (an inactive envelope
 * has nothing new to flag); otherwise, warns when this month's own
 * spend has eaten the balance down to zero or below — i.e. one more
 * month at this pace would push the envelope into deficit.
 */

export type EnvelopeStatus = {
  categoryId: string;
  categoryName: string;
  /** Every allocation minus every expense, up to and including the current month. */
  balanceAgorot: Agorot;
  /** This month's own spend only (not cumulative), a positive magnitude. */
  spentThisMonthAgorot: Agorot;
};

export function generateBudgetBreachInsights(envelopes: readonly EnvelopeStatus[]): Insight[] {
  const insights: Insight[] = [];

  for (const envelope of envelopes) {
    if (envelope.balanceAgorot < 0) {
      const deficitMagnitude = Math.abs(envelope.balanceAgorot);
      insights.push({
        type: "budget_breach",
        severity: "critical",
        rank: computeRank("critical", deficitMagnitude / 100),
        title: `${envelope.categoryName} envelope is overdrawn`,
        description: `This envelope is ${formatAgorot(envelope.balanceAgorot)} — spent more, in total, than has ever been allocated to it.`,
        relatedEntityId: envelope.categoryId,
      });
    } else if (envelope.spentThisMonthAgorot > 0 && envelope.balanceAgorot <= envelope.spentThisMonthAgorot) {
      const impact = ((envelope.spentThisMonthAgorot - envelope.balanceAgorot) / envelope.spentThisMonthAgorot) * 100;
      insights.push({
        type: "budget_breach",
        severity: "warning",
        rank: computeRank("warning", impact),
        title: `${envelope.categoryName} envelope is running low`,
        description: `Only ${formatAgorot(envelope.balanceAgorot)} left after spending ${formatAgorot(envelope.spentThisMonthAgorot)} this month.`,
        relatedEntityId: envelope.categoryId,
      });
    }
  }

  return insights;
}
