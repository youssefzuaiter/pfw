import Link from "next/link";
import { ReportingRateNote } from "../../../../components/currency/reporting-currency-provider";
import { minorUnitsToInputText } from "../../../../lib/recurring-bills";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { listCategories } from "../../../../server/dal/categories";
import { buildRecurringCalendar, resolveCalendarMonth } from "../../../../server/subscriptions/build-recurring-calendar";
import { buildSubscriptionRadarData } from "../../../../server/subscriptions/build-subscription-radar-data";
import { AddItemPanel } from "../_components/add-item-panel";
import { MonthTotalsCard } from "../_components/month-totals-card";
import { RecurringCalendar } from "../_components/recurring-calendar";
import { RecurringNav } from "../_components/recurring-nav";
import { ManualBillList, type ManualBillItem } from "./_components/manual-bill-list";

export const instant = false;

const UPCOMING_DAYS = 30;

/**
 * The bills and subscriptions the user added by hand: something new, a bill
 * paid from another account, a yearly charge. The ones the radar found in the
 * statements live on /transactions/subscriptions (AGENTS.md §3dddd).
 */
export default async function BillsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const user = await getCurrentUser();
  const { month } = await searchParams;
  const now = new Date();
  const monthKey = resolveCalendarMonth(month, now);
  const [data, allCategories, calendar] = await Promise.all([
    buildSubscriptionRadarData(user.id),
    listCategories(user.id),
    buildRecurringCalendar(user.id, "bill", monthKey),
  ]);
  const categories = allCategories.filter((category) => category.slug !== "uncategorized").map((category) => ({ id: category.id, name: category.name }));
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

  // Only bills: subscriptions added by hand belong to the Subscriptions page.
  const manualItems: ManualBillItem[] = data.manualBills.filter((bill) => bill.kind === "bill").map((bill) => ({
    id: bill.id,
    kind: bill.kind,
    name: bill.name,
    amount: minorUnitsToInputText(bill.nativeAmount),
    amountVaries: bill.amountVaries,
    estimateBasedOnPayments: bill.estimateBasedOnPayments,
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
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const upcoming = data.subscriptions
    .filter((subscription) => subscription.manualBillKind === "bill" && subscription.status !== "CANCELLED" && subscription.isRecurring && subscription.nextExpectedDate)
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
        Bills you add yourself: rent, electricity, insurance, anything that comes round on a schedule. They count in Safe
        to Spend, and you can get a phone reminder before one is due.
      </p>
      <ReportingRateNote />

      <MonthTotalsCard
        title="Spent on bills"
        noun="bills"
        totals={data.monthTotals.bills}
        usualMonthly={data.billsCashDrag.monthly}
        usualAnnual={data.billsCashDrag.annual}
      />

      <AddItemPanel
        kind="bill"
        categories={categories}
        help="Add something paid on a schedule: rent, electricity, insurance. You get a phone reminder three days before it is due if you turned on phone alerts."
      />

      <RecurringCalendar calendar={calendar} basePath="/transactions/bills" currentMonthKey={resolveCalendarMonth(undefined, now)} noun="bills" />

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

      <section aria-labelledby="your-bills-heading" className="rounded-lg border border-border bg-surface p-4">
        <h2 id="your-bills-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
          Added by you ({manualItems.length})
        </h2>
        {manualItems.length === 0 ? (
          <p className="text-sm text-muted">You have not added any bills yet. Use the Add button above.</p>
        ) : (
          <ManualBillList items={manualItems} categories={categories} />
        )}
      </section>
    </div>
  );
}
