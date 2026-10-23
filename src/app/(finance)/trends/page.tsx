import Link from "next/link";
import { Badge } from "../../../components/badge/badge";
import { ReportingRateNote } from "../../../components/currency/reporting-currency-provider";
import { Tickbar } from "../../../components/tickbar/tickbar";
import { formatMonthKey } from "../../../lib/date-month";
import { formatBpsChange } from "../../../lib/monthly-review";
import { getCurrentUser } from "../../../server/auth/current-user";
import { buildSpendingTrendsView, type CategoryTrendRow } from "../../../server/reports/build-spending-trends";

// Per-user financial data, never prerendered or cached across requests (AGENTS.md §3c).
export const instant = false;

const linkClass =
  "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function ordinal(day: number): string {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th";
  return `${day}${suffix}`;
}

/** "+34%" style, or "new" when there is nothing earlier to compare with. */
function changeText(row: { differenceBps: number | null; difference: number }): string {
  if (row.differenceBps === null) return row.difference === 0 ? "No change" : "New";
  return formatBpsChange(row.differenceBps);
}

function ChangeBadge({ row }: { row: CategoryTrendRow }) {
  if (row.difference === 0) return <Badge variant="neutral">No change</Badge>;
  return <Badge variant={row.difference > 0 ? "warning" : "positive"}>{changeText(row)}</Badge>;
}

/**
 * Where spending is rising or falling (AGENTS.md §3iiii): this month so far
 * against your usual for the same days of the earlier months, by category,
 * with the last six months for context.
 */
export default async function TrendsPage() {
  const user = await getCurrentUser();
  const view = await buildSpendingTrendsView(user.id);
  const biggestMonth = Math.max(...view.months.map((month) => month.spend), 1);
  const hasHistory = view.baselineMonthsUsed > 0;
  const nothingYet = view.months.every((month) => month.spend === 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold text-fg">Spending trends</h1>
        <Link href="/review" className={linkClass}>
          Monthly review →
        </Link>
      </div>
      <p className="text-sm text-muted">
        {formatMonthKey(view.monthKey)} so far, the 1st to the {ordinal(view.dayOfMonth)}
        {hasHistory
          ? `, against your usual for those same days in the ${view.baselineMonthsUsed === 1 ? "month" : `${view.baselineMonthsUsed} months`} before`
          : ""}
        . Transfers between your own accounts are left out.
      </p>
      <ReportingRateNote className="text-xs text-muted" />

      {nothingYet ? (
        <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
          There is no spending in the last six months yet. Import a statement to see how it changes.
        </p>
      ) : (
        <>
          <section aria-labelledby="summary-heading" className="rounded-lg border border-border bg-surface p-4">
            <h2 id="summary-heading" className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              This month so far
            </h2>
            <p className="font-tabular-figures text-3xl font-semibold tracking-tight text-fg">{view.thisMonthText}</p>
            {hasHistory ? (
              <p className="text-sm text-muted">
                Your usual by now is <span className="font-tabular-figures text-fg">{view.usualByNowText}</span>
                {view.difference === 0 ? (
                  ", so you are right on it."
                ) : (
                  <>
                    , so you have spent <span className="font-tabular-figures text-fg">{view.differenceAbsText}</span>{" "}
                    {view.difference > 0 ? "more" : "less"}
                    {view.differenceBps !== null && ` (${formatBpsChange(view.differenceBps)})`}.
                  </>
                )}
              </p>
            ) : (
              <p className="text-sm text-muted">There are no earlier months with spending to compare with yet.</p>
            )}
          </section>

          {hasHistory && (view.biggestRises.length > 0 || view.biggestFalls.length > 0) && (
            <section aria-labelledby="changes-heading" className="rounded-lg border border-border bg-surface p-4">
              <h2 id="changes-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
                Biggest changes
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  { title: "Spending more on", rows: view.biggestRises },
                  { title: "Spending less on", rows: view.biggestFalls },
                ].map((group) => (
                  <div key={group.title}>
                    <h3 className="mb-1 text-sm font-medium text-fg">{group.title}</h3>
                    {group.rows.length === 0 ? (
                      <p className="text-sm text-muted">Nothing.</p>
                    ) : (
                      <ul className="flex flex-col gap-1.5 text-sm">
                        {group.rows.map((row) => (
                          <li key={row.categoryId} className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="text-fg">{row.name}</span>
                            <span className="font-tabular-figures tracking-tight text-muted">
                              {row.differenceText} <span className="text-xs">({changeText(row)})</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section aria-labelledby="months-heading" className="rounded-lg border border-border bg-surface p-4">
            <h2 id="months-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
              Spending by month
            </h2>
            <ul className="flex flex-col gap-3">
              {view.months.map((month, index) => {
                const current = index === view.months.length - 1;
                const text = view.monthsText[index].spendText;
                return (
                  <li key={month.monthKey}>
                    <Tickbar
                      label={`${formatMonthKey(month.monthKey)}${current ? " (so far)" : ""} · ${text}`}
                      percent={(month.spend / biggestMonth) * 100}
                      status="good"
                    />
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="categories-heading" className="rounded-lg border border-border bg-surface p-4">
            <h2 id="categories-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
              By category
            </h2>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="py-2 pr-3 font-medium">Category</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">So far</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Usual by now</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Change</th>
                    <th scope="col" className="py-2 pl-3 text-right font-medium">Last month</th>
                  </tr>
                </thead>
                <tbody>
                  {view.categories.map((row) => (
                    <tr key={row.categoryId} className="border-b border-border last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-medium text-fg">{row.name}</th>
                      <td className="px-3 py-2 text-right font-tabular-figures tracking-tight text-fg">{row.thisMonthText}</td>
                      <td className="px-3 py-2 text-right font-tabular-figures tracking-tight text-muted">{hasHistory ? row.usualByNowText : "—"}</td>
                      <td className="px-3 py-2 text-right">{hasHistory ? <ChangeBadge row={row} /> : "—"}</td>
                      <td className="py-2 pl-3 text-right font-tabular-figures tracking-tight text-muted">{row.lastMonthText}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="flex flex-col divide-y divide-border md:hidden">
              {view.categories.map((row) => (
                <li key={row.categoryId} className="flex flex-col gap-1 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-fg">{row.name}</span>
                    <span className="font-tabular-figures tracking-tight text-fg">{row.thisMonthText}</span>
                  </div>
                  {hasHistory && (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                      <span>Usual by now {row.usualByNowText}</span>
                      <ChangeBadge row={row} />
                    </div>
                  )}
                  <p className="text-xs text-muted">Last month {row.lastMonthText}</p>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
