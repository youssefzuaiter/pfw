import { Badge } from "../../../../components/badge/badge";
import { ReportingAmount } from "../../../../components/currency/reporting-currency-provider";
import { formatMonthKey } from "../../../../lib/date-month";
import type { SafeToSpendResult } from "../../../../lib/safe-to-spend";

export type SafeToSpendCardProps = SafeToSpendResult & { month: string };

function formatDueDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** One line of the calculation: an operator, a label, and a positive amount. */
function Line({ sign, label, hint, value }: { sign: "+" | "−"; label: string; hint?: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-sm text-fg">
        <span aria-hidden="true" className="mr-2 inline-block w-3 text-muted">
          {sign}
        </span>
        <span className="sr-only">{sign === "+" ? "Plus " : "Minus "}</span>
        {label}
        {hint ? <span className="block pl-5 text-xs text-muted">{hint}</span> : null}
      </dt>
      <dd className="font-tabular-figures shrink-0 text-sm tracking-tight text-fg">
        <ReportingAmount value={value} />
      </dd>
    </div>
  );
}

/**
 * The dashboard's "Safe to Spend" figure (`src/lib/safe-to-spend.ts` has the
 * formula and every edge case): what is genuinely left this month after the
 * money already spoken for. The number is the headline; the native
 * `<details>` below it is the breakdown, so how the figure was reached is
 * one keyboard-reachable click away rather than hidden in a hover tooltip a
 * phone can't show.
 *
 * A negative figure is shown as negative, in red, with a badge: promising
 * more than there is should never read as "zero left".
 */
export function SafeToSpendCard(props: SafeToSpendCardProps) {
  const { safeToSpendAgorot, isOverCommitted, bills, goals, overspentEnvelopes, debts, expectedIncome, month } = props;
  const monthName = formatMonthKey(month);
  const goalsWithPace = goals.filter((goal) => goal.requiredThisMonthAgorot > 0);
  const nextIncome = expectedIncome[0];

  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="safe-to-spend-heading">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="safe-to-spend-heading" className="text-xs font-medium uppercase tracking-wide text-muted">
          Safe to spend
        </h2>
        {isOverCommitted ? <Badge variant="critical">Over-committed</Badge> : null}
      </div>

      <p
        data-testid="safe-to-spend-value"
        className={`font-tabular-figures text-3xl font-semibold tracking-tight ${isOverCommitted ? "text-negative" : "text-fg"}`}
      >
        <ReportingAmount value={safeToSpendAgorot} />
      </p>
      <p className="mt-1 text-xs text-muted">
        {isOverCommitted
          ? `More is promised than you have for the rest of ${monthName}. Move or cover something to get back above zero.`
          : `What is left for the rest of ${monthName}, after bills still to come, your envelopes and your goals.`}
      </p>
      {props.expectedIncomeAgorot > 0 ? (
        <p data-testid="safe-to-spend-expected-income" className="mt-1 text-xs text-muted">
          Not counted: <ReportingAmount value={props.expectedIncomeAgorot} /> of income still expected this month
          {nextIncome ? ` (${nextIncome.displayName}, ${formatDueDate(nextIncome.dueDate)})` : ""}. If it arrives, you would have{" "}
          <ReportingAmount value={props.safeToSpendWithExpectedIncomeAgorot} />.
        </p>
      ) : null}

      <details className="group mt-3 border-t border-border pt-2">
        <summary className="cursor-pointer rounded text-xs font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          How this is calculated
        </summary>

        <dl className="mt-2 divide-y divide-border">
          <Line
            sign="+"
            label={props.savingsCounted ? "Cash in checking and savings" : "Cash in checking"}
            hint={props.savingsCounted ? undefined : "Savings are kept as a reserve and not counted (a setting)."}
            value={props.cashAgorot}
          />
          <Line sign="−" label="Credit card balances owed" hint="Already spent, not yet paid out of cash." value={props.cardOwedAgorot} />
          <Line sign="−" label="Envelope money still unspent" hint="Promised to a category and not used yet." value={props.envelopeReserveAgorot} />
          <Line
            sign="−"
            label="Bills still due this month"
            hint="Only the part an envelope doesn't already hold."
            value={props.billsNotCoveredAgorot}
          />
          <Line sign="−" label="Debt minimum payments due" hint="Payments you have not made yet this month." value={props.debtDueAgorot} />
          <Line sign="−" label="Goal contributions due this month" value={props.goalDueAgorot} />
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="text-sm font-medium text-fg">
              <span aria-hidden="true" className="mr-2 inline-block w-3 text-muted">
                =
              </span>
              <span className="sr-only">Equals </span>
              Safe to spend
            </dt>
            <dd className={`font-tabular-figures shrink-0 text-sm font-medium tracking-tight ${isOverCommitted ? "text-negative" : "text-fg"}`}>
              <ReportingAmount value={safeToSpendAgorot} />
            </dd>
          </div>
        </dl>

        {bills.length > 0 ? (
          <div className="mt-3">
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Bills still to come</h3>
            <ul className="flex flex-col gap-1.5">
              {bills.map((bill) => (
                <li key={bill.merchantKey} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="text-fg">
                    {bill.displayName}
                    <span className="ml-2 text-xs text-muted">
                      {bill.overdue ? "expected " : "due "}
                      {formatDueDate(bill.dueDate)}
                      {bill.overdue ? ", not charged yet" : ""}
                      {bill.occurrences > 1 ? `, ${bill.occurrences} charges` : ""}
                    </span>
                  </span>
                  <span className="font-tabular-figures tracking-tight text-fg">
                    <ReportingAmount value={bill.totalAgorot} />
                  </span>
                  {bill.coveredByEnvelopeAgorot > 0 ? (
                    <span className="basis-full text-xs text-muted">
                      {bill.deductedAgorot === 0 ? (
                        "Paid from its envelope, so it is not deducted again."
                      ) : (
                        <>
                          <ReportingAmount value={bill.coveredByEnvelopeAgorot} /> covered by its envelope,{" "}
                          <ReportingAmount value={bill.deductedAgorot} /> deducted here.
                        </>
                      )}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {debts.length > 0 ? (
          <div className="mt-3">
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Debt payments this month</h3>
            <ul className="flex flex-col gap-1.5">
              {debts.map((debt) => (
                <li key={debt.debtId} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="text-fg">
                    {debt.name}
                    <span className="ml-2 text-xs text-muted">
                      {debt.handledByBill !== null ? (
                        `paid as the recurring bill "${debt.handledByBill}", so not counted again`
                      ) : debt.dueAgorot === 0 ? (
                        "minimum already paid"
                      ) : (
                        <>
                          minimum <ReportingAmount value={debt.minimumAgorot} />, paid <ReportingAmount value={debt.paidThisMonthAgorot} />
                        </>
                      )}
                    </span>
                  </span>
                  <span className="font-tabular-figures tracking-tight text-fg">
                    <ReportingAmount value={debt.dueAgorot} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {goalsWithPace.length > 0 ? (
          <div className="mt-3">
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Goals this month</h3>
            <ul className="flex flex-col gap-1.5">
              {goalsWithPace.map((goal) => (
                <li key={goal.goalId} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="text-fg">
                    {goal.name}
                    <span className="ml-2 text-xs text-muted">
                      needs <ReportingAmount value={goal.requiredThisMonthAgorot} />, saved{" "}
                      <ReportingAmount value={Math.max(0, goal.contributedThisMonthAgorot)} />
                    </span>
                  </span>
                  <span className="font-tabular-figures tracking-tight text-fg">
                    <ReportingAmount value={goal.dueAgorot} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {overspentEnvelopes.length > 0 ? (
          <div className="mt-3">
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Over budget</h3>
            <ul className="flex flex-col gap-1">
              {overspentEnvelopes.map((envelope) => (
                <li key={envelope.categoryId} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-fg">{envelope.categoryName}</span>
                  <span className="font-tabular-figures tracking-tight text-negative">
                    <ReportingAmount value={envelope.overspentAgorot} />
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted">
              That money has already left your accounts, so it is already lowering the figure above. An over-budget envelope never adds anything back.
            </p>
          </div>
        ) : null}

        {expectedIncome.length > 0 ? (
          <div className="mt-3">
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Income still expected (not counted)</h3>
            <ul className="flex flex-col gap-1">
              {expectedIncome.map((income) => (
                <li key={income.merchantKey} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-fg">
                    {income.displayName}
                    <span className="ml-2 text-xs text-muted">
                      {income.overdue ? "expected " : "due "}
                      {formatDueDate(income.dueDate)}
                      {income.overdue ? ", not received yet" : ""}
                    </span>
                  </span>
                  <span className="font-tabular-figures tracking-tight text-fg">
                    <ReportingAmount value={income.totalAgorot} />
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted">Money that has not arrived is not spendable yet, so the figure above leaves it out.</p>
          </div>
        ) : null}

        <p className="mt-3 text-xs text-muted">
          {props.savingsCounted ? "Counts checking and savings." : "Counts checking only; savings are a reserve."} Moves between your own accounts are neither
          income nor spending. Balances count only the transactions dated after the day you gave for each balance.
        </p>
      </details>
    </section>
  );
}
