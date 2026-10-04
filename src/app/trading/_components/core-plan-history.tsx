import { Badge } from "../../../components/badge/badge";
import { formatUtcDateTime } from "../../../lib/core-format";
import { shortId, type CorePlan } from "../../../lib/core-journal";
import { formatNativeAmount, nativeAmount } from "../../../lib/currency";
import { CoreOrdersTable } from "./core-orders-table";
import { PLAN_STATUS_LABEL, PLAN_STATUS_VARIANT, PlanIntent, planKindLabel } from "./core-plan-card";

function tradedText(plan: CorePlan): string {
  if (plan.tradedUsdCents === null) return "—";
  return formatNativeAmount(nativeAmount(plan.tradedUsdCents), "USD");
}

/**
 * Every plan the router has proposed that is no longer open, newest first
 * (the open one has its own card above). Each opens to its orders and
 * what they filled — "did Monday's build go through, and at what price" is
 * the question this answers; the newest starts open. A native disclosure
 * element, so it needs no script and works from the keyboard as it is.
 */
export function CorePlanHistory({ plans, openPlan }: { plans: CorePlan[]; openPlan: CorePlan | null }) {
  const newestFirst = plans.filter((plan) => plan !== openPlan).reverse();
  if (newestFirst.length === 0) {
    return <p className="text-sm text-muted">No plan has closed yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-2" aria-label="Closed plans, newest first">
      {newestFirst.map((plan, position) => {
        const open = position === 0;
        return (
          <li key={`${plan.id}-${plan.acceptedAt.getTime()}`} className="rounded-lg border border-border">
            <details open={open}>
              <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="font-medium text-fg">{plan.executeOn ?? plan.decidedOn ?? "—"}</span>
                <span className="text-fg">{planKindLabel(plan.kind)}</span>
                <Badge variant={PLAN_STATUS_VARIANT[plan.status]}>{PLAN_STATUS_LABEL[plan.status]}</Badge>
                <span className="ml-auto font-tabular-figures text-muted">{tradedText(plan)} traded</span>
              </summary>
              <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                <p className="text-xs text-muted">
                  Plan <span className="font-tabular-figures">{shortId(plan.id)}</span> · proposed {formatUtcDateTime(plan.acceptedAt)}
                  {plan.approvedAt ? ` · approved ${formatUtcDateTime(plan.approvedAt)}${plan.fundedByOwner ? " with the fund command" : ""}` : ""}
                  {plan.closedAt ? ` · closed ${formatUtcDateTime(plan.closedAt)}` : ""}
                </p>
                {plan.outcome && <p className="text-sm text-fg">{plan.outcome}</p>}
                {plan.problems.length > 0 && (
                  <ul className="list-disc pl-5 text-sm text-negative">
                    {plan.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                )}
                {plan.orders.length === 0 ? <PlanIntent plan={plan} /> : <CoreOrdersTable orders={plan.orders} />}
                {plan.notes.length > 0 && (
                  <ul className="list-disc pl-5 text-sm text-muted">
                    {plan.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
