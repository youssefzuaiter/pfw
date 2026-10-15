import Link from "next/link";
import { ReportingRateNote } from "../../../components/currency/reporting-currency-provider";
import { Tickbar } from "../../../components/tickbar/tickbar";
import { formatNativeAmount, nativeAmount } from "../../../lib/currency";
import { compareMonthKeys, currentMonthKey, formatMonthKey, isValidMonthKey, shiftMonthKey } from "../../../lib/date-month";
import { changeFrom, formatBpsChange, spendingShares } from "../../../lib/monthly-review";
import { getCurrentUser } from "../../../server/auth/current-user";
import { formatReportingFlow, formatReportingMinorUnits } from "../../../lib/reporting-currency";
import { getReportingContext } from "../../../server/reporting/reporting-context";
import { buildMonthlyReview } from "../../../server/reports/monthly-review";
import { categoryLabel } from "../../../lib/transaction-splits";

// Per-user financial data, never prerendered or cached across requests (AGENTS.md §3c).
export const instant = false;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The requested month, or this month; never a month that has not started. */
function resolveMonth(requested: string | undefined, thisMonth: string): string {
  if (!requested || !isValidMonthKey(requested)) return thisMonth;
  return compareMonthKeys(requested, thisMonth) > 0 ? thisMonth : requested;
}

const linkClass =
  "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * One month at a glance (AGENTS.md §3ppp): money in and out against the
 * month before, where the spending went, the biggest expenses, the
 * net-worth change and the long-term core. The same figures as the monthly
 * email, for any month, without depending on email delivery.
 */
export default async function MonthlyReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  const thisMonth = currentMonthKey();
  const monthKey = resolveMonth(firstParam(params.month), thisMonth);
  const isCurrentMonth = monthKey === thisMonth;
  const previousKey = shiftMonthKey(monthKey, -1);

  const [review, reporting] = await Promise.all([buildMonthlyReview(user.id, monthKey), getReportingContext(user.id)]);
  const { report, previous, largestExpenses, coreBenchmark } = review;

  // Every figure here is already in the reporting currency's minor units
  // (AGENTS.md §3vvv): totals and categories summed per transaction on its
  // own day, snapshots at their own day's rate. The arithmetic below works
  // on those units, so the categories, the totals and the changes agree.
  const money = (minorUnits: bigint | number, signed = false) =>
    formatReportingMinorUnits(Number(minorUnits), reporting, { showPositiveSign: signed });
  const income = BigInt(report.incomeShown);
  const expense = BigInt(report.expenseShown);
  const previousIncome = BigInt(previous.incomeShown);
  const previousExpense = BigInt(previous.expenseShown);
  const shares = spendingShares(report.topCategories.map((category) => ({ name: category.name, spentAgorot: BigInt(category.spentShown) })));
  const isEmpty = report.incomeAgorot === 0n && report.expenseAgorot === 0n && largestExpenses.length === 0;

  const totals = [
    { label: "Money in", value: income, before: previousIncome },
    { label: "Spending", value: expense, before: previousExpense },
    { label: "Net", value: income - expense, before: previousIncome - previousExpense, signed: true },
  ];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold text-fg">Monthly review</h1>
        <nav aria-label="Choose a month" className="flex items-center gap-2">
          <Link href={`/review?month=${previousKey}`} className={linkClass}>
            ← {formatMonthKey(previousKey)}
          </Link>
          {!isCurrentMonth && (
            <Link href={`/review?month=${shiftMonthKey(monthKey, 1)}`} className={linkClass}>
              {formatMonthKey(shiftMonthKey(monthKey, 1))} →
            </Link>
          )}
        </nav>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-fg">{formatMonthKey(monthKey)}</h2>
        {isCurrentMonth && (
          <p className="text-xs text-muted">So far this month, through {new Date().toISOString().slice(0, 10)}.</p>
        )}
        <ReportingRateNote className="mt-1 text-xs text-muted" />
      </div>

      {isEmpty ? (
        <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
          Nothing was recorded for {formatMonthKey(monthKey)}. Import a statement for this month to see its review.
        </p>
      ) : (
        <>
          <section aria-labelledby="totals-heading" className="rounded-lg border border-border bg-surface p-4">
            <h3 id="totals-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
              Money in and out
            </h3>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {totals.map((total) => {
                const change = changeFrom(total.before, total.value);
                return (
                  <div key={total.label}>
                    <dt className="text-xs text-muted">{total.label}</dt>
                    <dd className="font-tabular-figures text-lg font-semibold tracking-tight text-fg">
                      {money(total.value, total.signed)}
                    </dd>
                    <dd className="text-xs text-muted">
                      vs {formatMonthKey(previousKey)}: {money(change.deltaAgorot, true)}
                      {change.bps !== null && !total.signed && ` (${formatBpsChange(change.bps)})`}
                    </dd>
                  </div>
                );
              })}
            </dl>
            <p className="mt-3 text-xs text-muted">Transfers between your own accounts are left out.</p>
          </section>

          <section aria-labelledby="categories-heading" className="rounded-lg border border-border bg-surface p-4">
            <h3 id="categories-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
              Where the money went
            </h3>
            {shares.length === 0 ? (
              <p className="text-sm text-muted">No spending this month.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {shares.map((share) => (
                  <li key={share.name}>
                    <Tickbar label={`${share.name} · ${money(share.spentAgorot)}`} percent={share.percent} status="good" />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {largestExpenses.length > 0 && (
            <section aria-labelledby="largest-heading" className="rounded-lg border border-border bg-surface p-4">
              <h3 id="largest-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
                Largest expenses
              </h3>
              <ul className="flex flex-col divide-y divide-border">
                {largestExpenses.map((expense) => (
                  <li key={expense.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate text-fg">{expense.merchantName ?? expense.description}</p>
                      <p className="text-xs text-muted">
                        {expense.occurredAt.toISOString().slice(0, 10)} · {categoryLabel(expense)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-tabular-figures font-medium tracking-tight text-fg">
                        {formatReportingFlow(
                          { amount: expense.amount, occurredAt: expense.occurredAt, currency: expense.currency, nativeAmount: expense.nativeAmount },
                          reporting,
                        )}
                      </p>
                      {expense.currency !== "ILS" && (
                        <p className="font-tabular-figures text-xs text-muted">
                          {formatNativeAmount(nativeAmount(Number(expense.nativeAmount)), expense.currency)}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <section aria-labelledby="net-worth-heading" className="rounded-lg border border-border bg-surface p-4">
        <h3 id="net-worth-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
          Net worth
        </h3>
        {report.netWorth ? (
          <p className="text-sm text-fg">
            <span className="font-tabular-figures">{money(report.netWorth.startShown)}</span> →{" "}
            <span className="font-tabular-figures">{money(report.netWorth.endShown)}</span>
            <span className="font-tabular-figures text-muted">
              {" "}
              ({money(report.netWorth.endShown - report.netWorth.startShown, true)})
            </span>
          </p>
        ) : (
          <p className="text-sm text-muted">
            Net worth is recorded every night; this month has fewer than two days recorded, so there is no change to
            show yet.
          </p>
        )}
      </section>

      {report.core && (
        <section aria-labelledby="core-heading" className="rounded-lg border border-border bg-surface p-4">
          <h3 id="core-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
            Long-term core (paper account)
          </h3>
          <p className="text-sm text-fg">
            <span className="font-tabular-figures">
              {formatNativeAmount(nativeAmount(report.core.startUsdCents), "USD")}
            </span>{" "}
            →{" "}
            <span className="font-tabular-figures">{formatNativeAmount(nativeAmount(report.core.endUsdCents), "USD")}</span>
          </p>
          {coreBenchmark && coreBenchmark.accountChangeBps !== null && coreBenchmark.benchmarkChangeBps !== null && (
            <p className="mt-1 text-xs text-muted">
              From {coreBenchmark.sinceDay} to {coreBenchmark.lastDay}: the account{" "}
              {formatBpsChange(coreBenchmark.accountChangeBps)}, the same amount in VT{" "}
              {formatBpsChange(coreBenchmark.benchmarkChangeBps)}.
            </p>
          )}
          <Link href="/trading/core" className="mt-2 inline-block text-xs text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Open the core page
          </Link>
        </section>
      )}
    </div>
  );
}
