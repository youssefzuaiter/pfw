import Link from "next/link";
import { ReportingRateNote } from "../../../../components/currency/reporting-currency-provider";
import { Badge, type BadgeVariant } from "../../../../components/badge/badge";
import { minorUnitsToInputText } from "../../../../lib/recurring-bills";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { listCategories } from "../../../../server/dal/categories";
import { buildSubscriptionRadarData } from "../../../../server/subscriptions/build-subscription-radar-data";
import { ManualBillList, type ManualBillItem } from "./_components/manual-bill-list";
import { RecurringBillForm } from "./_components/recurring-bill-form";
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

const UPCOMING_DAYS = 30;

export default async function SubscriptionsPage() {
  const user = await getCurrentUser();
  const [data, allCategories] = await Promise.all([buildSubscriptionRadarData(user.id), listCategories(user.id)]);
  const categories = allCategories.filter((category) => category.slug !== "uncategorized").map((category) => ({ id: category.id, name: category.name }));
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

  const manualItems: ManualBillItem[] = data.manualBills.map((bill) => ({
    id: bill.id,
    name: bill.name,
    amount: minorUnitsToInputText(bill.nativeAmount),
    currency: bill.currency,
    cadence: bill.cadence,
    anchorDate: bill.anchorDate,
    categoryId: bill.categoryId,
    formattedAmount: bill.formattedAmount,
    categoryName: bill.categoryId ? (categoryNames.get(bill.categoryId) ?? null) : null,
    nextDueDate: bill.nextDueDate,
    detectedAs: bill.detectedAs,
    status: bill.status,
  }));

  // What is coming up in the next month, soonest first: bills the user typed in
  // and ones detected from statements, anything not cancelled.
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const upcoming = data.subscriptions
    .filter((subscription) => subscription.status !== "CANCELLED" && subscription.isRecurring && subscription.nextExpectedDate)
    .map((subscription) => ({ subscription, due: subscription.nextExpectedDate as Date }))
    .filter(({ due }) => {
      const day = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
      return day >= today && day <= today + UPCOMING_DAYS * 24 * 60 * 60 * 1000;
    })
    .sort((a, b) => a.due.getTime() - b.due.getTime());

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold text-fg">Subscriptions radar</h1>
        <Link
          href="/transactions"
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ← Transactions
        </Link>
      </div>
      <ReportingRateNote />

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Recurring cash drag</h2>
        <p className="font-tabular-figures text-2xl font-semibold tracking-tight text-fg">
          {data.cashDrag.monthly}
          <span className="text-sm font-normal text-muted"> / month</span>
        </p>
        <p className="font-tabular-figures text-sm tracking-tight text-muted">{data.cashDrag.annual} / year, across active subscriptions</p>
      </section>

      <section aria-labelledby="coming-up-heading" className="rounded-lg border border-border bg-surface p-4">
        <h2 id="coming-up-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
          Coming up in the next {UPCOMING_DAYS} days
        </h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted">Nothing is due in the next {UPCOMING_DAYS} days.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {upcoming.map(({ subscription, due }) => (
              <li key={subscription.merchantKey} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-fg">
                  <span className="font-tabular-figures tracking-tight text-muted">{due.toISOString().slice(0, 10)}</span>{" "}
                  {subscription.displayName}
                </span>
                <span className="font-tabular-figures tracking-tight text-fg">{subscription.formattedCurrentAmount.replace(/^-/, "")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="add-bill-heading" className="rounded-lg border border-border bg-surface p-4">
        <h2 id="add-bill-heading" className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
          Add a subscription or bill
        </h2>
        <p className="mb-3 text-sm text-muted">
          For one the radar cannot see yet: something new, a bill paid from another account, or a yearly charge. It counts
          in Safe to Spend and the totals above, and you get a phone reminder three days before it is due if you turned on
          phone alerts.
        </p>
        <RecurringBillForm categories={categories} />
      </section>

      {manualItems.length > 0 && (
        <section aria-labelledby="your-bills-heading" className="rounded-lg border border-border bg-surface p-4">
          <h2 id="your-bills-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
            Added by you ({manualItems.length})
          </h2>
          <ManualBillList items={manualItems} categories={categories} />
        </section>
      )}

      {data.possibleFreeTrials.length > 0 && (
        <section className="rounded-lg border border-signature/30 bg-signature/10 p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-signature">Possible forgotten trials</h2>
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
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
          Recurring subscriptions & bills ({data.subscriptions.length})
        </h2>
        {data.subscriptions.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing recurring found yet. Detection needs at least a few occurrences of the same merchant at a
            consistent price and interval; you can also add one above.
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
                    {subscription.manualBillId && <Badge variant="neutral">Added by you</Badge>}
                    {subscription.priceHike && (
                      <Badge variant="warning" pulse>
                        Price hike
                      </Badge>
                    )}
                  </p>
                  <p className="font-tabular-figures text-sm tracking-tight text-muted">
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
