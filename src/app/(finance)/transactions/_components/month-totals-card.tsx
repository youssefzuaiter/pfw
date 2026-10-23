import type { MonthTotals } from "../../../../server/subscriptions/build-subscription-radar-data";

/**
 * What one page has cost this calendar month (AGENTS.md §3ffff): the money
 * actually charged so far, what is still to come before the month ends, and
 * the usual monthly cost for context. The Subscriptions page and the Bills page
 * each show their own, so neither shows the other's money.
 */
export function MonthTotalsCard({
  title,
  totals,
  usualMonthly,
  usualAnnual,
  noun,
}: {
  title: string;
  totals: MonthTotals;
  usualMonthly: string;
  usualAnnual: string;
  /** Plural, for the sentence under the figure: "subscriptions" or "bills". */
  noun: string;
}) {
  return (
    <section aria-labelledby={`${noun}-month-heading`} className="rounded-lg border border-border bg-surface p-4">
      <h2 id={`${noun}-month-heading`} className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
        {title} in {totals.monthLabel}
      </h2>
      <p className="font-tabular-figures text-3xl font-semibold tracking-tight text-fg">{totals.spent}</p>
      <p className="text-sm text-muted">
        {totals.spentCount === 0
          ? `No ${noun} charged yet this month.`
          : `${totals.spentCount} ${totals.spentCount === 1 ? "charge" : "charges"} so far this month.`}
      </p>
      <dl className="mt-3 grid gap-2 border-t border-border pt-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Still to be charged this month</dt>
          <dd className="font-tabular-figures tracking-tight text-fg">
            {totals.stillDue}
            {totals.stillDueCount > 0 && <span className="text-muted"> ({totals.stillDueCount})</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Usual cost</dt>
          <dd className="font-tabular-figures tracking-tight text-fg">
            {usualMonthly} <span className="text-muted">/ month</span> · {usualAnnual} <span className="text-muted">/ year</span>
          </dd>
        </div>
      </dl>
    </section>
  );
}
