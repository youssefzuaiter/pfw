import { Badge, type BadgeVariant } from "../../../components/badge/badge";
import { formatUsdDecimal, formatUtcDateTime } from "../../../lib/core-format";
import { shortId, type CorePlan, type CorePlanStatus } from "../../../lib/core-journal";
import { formatDecimalTrimmed } from "../../../lib/decimal-string";
import { CoreOrdersTable } from "./core-orders-table";

export const PLAN_STATUS_LABEL: Record<CorePlanStatus, string> = {
  awaiting_approval: "Waiting for your approval",
  approved: "Approved",
  selling: "Selling",
  buying: "Buying",
  done: "Done",
  abandoned: "Abandoned",
  expired: "Expired",
  deferred: "Deferred",
  halted: "Halted",
  superseded: "Replaced",
  rejected: "Rejected",
};

export const PLAN_STATUS_VARIANT: Record<CorePlanStatus, BadgeVariant> = {
  awaiting_approval: "warning",
  approved: "neutral",
  selling: "neutral",
  buying: "neutral",
  done: "positive",
  abandoned: "critical",
  expired: "warning",
  deferred: "warning",
  halted: "critical",
  superseded: "neutral",
  rejected: "critical",
};

export const PLAN_KIND_LABEL: Record<string, string> = {
  initial: "Initial build",
  rebalance: "Rebalance",
  raise_cash: "Raise cash",
};

export function planKindLabel(kind: string): string {
  return PLAN_KIND_LABEL[kind] ?? kind;
}

/** What a plan intends to trade, in plain terms. */
export function PlanIntent({ plan }: { plan: CorePlan }) {
  if (plan.sells.length === 0 && plan.buys.length === 0) {
    return <p className="text-sm text-muted">Nothing to trade.</p>;
  }
  return (
    <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {plan.sells.map((sell) => (
        <li key={`sell-${sell.symbol}`} className="text-fg">
          Sell <span className="font-tabular-figures">{formatDecimalTrimmed(sell.qty, 6)}</span> {sell.symbol}
        </li>
      ))}
      {plan.buys.map((buy) => (
        <li key={`buy-${buy.symbol}`} className="text-fg">
          Buy <span className="font-tabular-figures">{formatUsdDecimal(buy.notionalUsd)}</span> of {buy.symbol}
        </li>
      ))}
    </ul>
  );
}

/**
 * The plan that is open right now, if one is. This page is read-only: a
 * plan waiting on the owner is approved from the router's own console
 * (`core_ctl approve`), because that is a signed command to the router and
 * this app holds no credential for it, on purpose.
 */
export function CoreOpenPlanCard({ plan }: { plan: CorePlan | null }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4" aria-labelledby="core-open-plan-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="core-open-plan-heading" className="mr-2 text-sm font-medium uppercase tracking-wide text-muted">
          Open plan
        </h2>
        {plan && <Badge variant={PLAN_STATUS_VARIANT[plan.status]}>{PLAN_STATUS_LABEL[plan.status]}</Badge>}
      </div>

      {!plan ? (
        <p className="text-sm text-muted">
          No plan is open. The Allocator proposes one after a close when the policy calls for it — the initial build, then
          each quarter&rsquo;s last session.
        </p>
      ) : (
        <>
          <p className="text-sm text-fg">
            {planKindLabel(plan.kind)}
            {plan.redecision ? " (re-decision)" : ""} · <span className="font-tabular-figures text-muted">{shortId(plan.id)}</span>
            {plan.executeOn && <span className="text-muted"> · executes at the open on {plan.executeOn}</span>}
          </p>
          {plan.orders.length === 0 && <PlanIntent plan={plan} />}
          {plan.status === "awaiting_approval" && (
            <div className="rounded-lg border border-signature/40 bg-signature/10 p-3 text-sm text-fg">
              This plan needs your signed approval before it can trade. Approve it on the router&rsquo;s host with{" "}
              <code className="font-tabular-figures">core_ctl approve</code>
              {plan.kind === "initial" ? (
                <>
                  {" "}
                  and <code className="font-tabular-figures">--fund</code>
                </>
              ) : null}
              ; this page cannot, by design. Proposed {formatUtcDateTime(plan.acceptedAt)}.
            </div>
          )}
          {plan.orders.length > 0 && <CoreOrdersTable orders={plan.orders} />}
          {plan.notes.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-muted">
              {plan.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
