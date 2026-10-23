import Link from "next/link";
import { ReportingRateNote } from "../../../../components/currency/reporting-currency-provider";
import { minorUnitsToInputText } from "../../../../lib/recurring-bills";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { listCategories } from "../../../../server/dal/categories";
import { buildSubscriptionRadarData } from "../../../../server/subscriptions/build-subscription-radar-data";
import { CashDragCard } from "../_components/cash-drag-card";
import { RecurringNav } from "../_components/recurring-nav";
import { ManualBillList, type ManualBillItem } from "./_components/manual-bill-list";
import { RecurringBillForm } from "./_components/recurring-bill-form";

export const instant = false;

const UPCOMING_DAYS = 30;

/**
 * The bills and subscriptions the user added by hand: something new, a bill
 * paid from another account, a yearly charge. The ones the radar found in the
 * statements live on /transactions/subscriptions (AGENTS.md §3dddd).
 */
export default async function BillsPage() {
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

  // Only the bills added by hand; the radar's own finds are on the other page.
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const upcoming = data.subscriptions
    .filter((subscription) => subscription.manualBillId && subscription.status !== "CANCELLED" && subscription.isRecurring && subscription.nextExpectedDate)
    .map((subscription) => ({ subscription, due: subscription.nextExpectedDate as Date }))
    .filter(({ due }) => {
      const day = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
      return day >= today && day <= today + UPCOMING_DAYS * 24 * 60 * 60 * 1000;
    })
    .sort((a, b) => a.due.getTime() - b.due.getTime());

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold text-fg">Bills</h1>
        <Link
          href="/transactions"
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ← Transactions
        </Link>
      </div>
      <RecurringNav active="bills" />
      <p className="text-sm text-muted">
        Bills and subscriptions you added yourself. They count in Safe to Spend and the cost total, and you can get a
        phone reminder before one is due.
      </p>
      <ReportingRateNote />

      <CashDragCard monthly={data.cashDrag.monthly} annual={data.cashDrag.annual} />

      <section aria-labelledby="coming-up-heading" className="rounded-lg border border-border bg-surface p-4">
        <h2 id="coming-up-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
          Coming up in the next {UPCOMING_DAYS} days
        </h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted">None of your bills are due in the next {UPCOMING_DAYS} days.</p>
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
          Add a bill or subscription
        </h2>
        <p className="mb-3 text-sm text-muted">
          For one the radar cannot see yet: something new, a bill paid from another account, or a yearly charge. You get a
          phone reminder three days before it is due if you turned on phone alerts.
        </p>
        <RecurringBillForm categories={categories} />
      </section>

      <section aria-labelledby="your-bills-heading" className="rounded-lg border border-border bg-surface p-4">
        <h2 id="your-bills-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
          Added by you ({manualItems.length})
        </h2>
        {manualItems.length === 0 ? (
          <p className="text-sm text-muted">You have not added any yet. Use the form above.</p>
        ) : (
          <ManualBillList items={manualItems} categories={categories} />
        )}
      </section>
    </div>
  );
}
