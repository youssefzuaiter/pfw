import Link from "next/link";
import { Badge, type BadgeVariant } from "../../../components/badge/badge";
import { getCurrentUser } from "../../../server/auth/current-user";
import { buildSubscriptionRadarData } from "../../../server/subscriptions/build-subscription-radar-data";
import { SubscriptionStatusToggle } from "./_components/subscription-status-toggle";

export const instant = false;

const CADENCE_LABEL: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

const STATUS_BADGE: Record<string, BadgeVariant> = {
  ACTIVE: "positive",
  REVIEWED: "neutral",
  CANCELLED: "critical",
};

export default async function SubscriptionsPage() {
  const user = await getCurrentUser();
  const data = await buildSubscriptionRadarData(user.id);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-fg">Subscriptions radar</h1>
        <Link
          href="/transactions"
          className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ← Transactions
        </Link>
      </div>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">Recurring cash drag</h2>
        <p className="font-tabular-figures text-2xl font-semibold text-fg">
          {data.cashDrag.monthly}
          <span className="text-sm font-normal text-muted"> / month</span>
        </p>
        <p className="font-tabular-figures text-sm text-muted">{data.cashDrag.annual} / year, across active subscriptions</p>
      </section>

      {data.possibleFreeTrials.length > 0 && (
        <section className="rounded-lg border border-border bg-signature/10 p-4">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-signature">Possible forgotten trials</h2>
          <ul className="flex flex-col gap-2">
            {data.possibleFreeTrials.map((trial) => (
              <li key={trial.merchantKey} className="text-sm text-fg">
                <span className="font-medium">{trial.displayName}</span> — {trial.formattedAmount} charged{" "}
                {trial.daysSinceCharge} days ago. Worth checking if this converted to a paid plan.
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
          Detected recurring subscriptions & bills ({data.subscriptions.length})
        </h2>
        {data.subscriptions.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing recurring detected yet — this needs at least a few occurrences of the same merchant at a
            consistent price and interval.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {data.subscriptions.map((subscription) => (
              <li
                key={subscription.merchantKey}
                className={`flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0 ${
                  subscription.status === "CANCELLED" ? "opacity-60" : ""
                }`}
              >
                <div>
                  <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
                    {subscription.displayName}
                    <Badge variant={STATUS_BADGE[subscription.status]}>{subscription.status}</Badge>
                    {subscription.priceHike && (
                      <Badge variant="warning" pulse>
                        Price hike
                      </Badge>
                    )}
                  </p>
                  <p className="font-tabular-figures text-sm text-muted">
                    {subscription.formattedCurrentAmount}
                    {subscription.cadence && ` / ${CADENCE_LABEL[subscription.cadence].toLowerCase()}`}
                    {subscription.nextExpectedDate &&
                      ` — next expected ${subscription.nextExpectedDate.toISOString().slice(0, 10)}`}
                  </p>
                  {subscription.formattedPriceHike && (
                    <p className="text-xs text-signature">
                      Went from {subscription.formattedPriceHike.from} to {subscription.formattedPriceHike.to}
                    </p>
                  )}
                </div>
                <SubscriptionStatusToggle merchantKey={subscription.merchantKey} status={subscription.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
