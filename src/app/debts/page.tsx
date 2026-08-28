import { Badge } from "../../components/badge/badge";
import { bps, formatBpsAsPercent } from "../../lib/apr";
import {
  buildAmortizationSchedule,
  compareAvalancheVsSnowball,
  isNegativeAmortization,
  summarizePayoff,
  type DebtInput,
} from "../../lib/debt-math";
import { agorot, formatAgorot, parseShekelsToAgorot } from "../../lib/money";
import { getCurrentUser } from "../../server/auth/current-user";
import { listDebts } from "../../server/dal/debts";
import { CreateDebtForm } from "./_components/create-debt-form";
import { RecordPaymentForm } from "./_components/record-payment-form";

export const instant = false;

const DEBT_TYPE_LABEL: Record<string, string> = {
  CREDIT_CARD: "Credit card",
  MORTGAGE: "Mortgage",
  PERSONAL_LOAN: "Personal loan",
  AUTO_LOAN: "Auto loan",
  STUDENT_LOAN: "Student loan",
  OTHER: "Other",
};

function firstParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function DebtsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const extraBudgetInput = firstParam(params.extra);

  const user = await getCurrentUser();
  const debts = await listDebts(user.id);

  const debtInputs: DebtInput[] = debts.map((d) => ({
    id: d.id,
    balance: agorot(Number(d.currentBalance)),
    aprBps: bps(d.aprBps),
    minimumPayment: agorot(Number(d.minimumPayment)),
  }));

  let extraBudgetAgorot = agorot(0);
  try {
    if (extraBudgetInput) extraBudgetAgorot = parseShekelsToAgorot(extraBudgetInput);
  } catch {
    // Malformed input just falls back to no extra budget.
  }

  const comparison = debtInputs.length > 1 ? compareAvalancheVsSnowball(debtInputs, extraBudgetAgorot) : null;
  const debtNameById = new Map(debts.map((d) => [d.id, d.name]));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
      <h1 className="font-display text-2xl font-semibold text-fg">Debts</h1>

      <section className="rounded-lg border border-border bg-surface p-4">
        <CreateDebtForm />
      </section>

      {debts.length === 0 && <p className="text-sm text-muted">No debts tracked yet — add one above.</p>}

      <ul className="flex flex-col gap-4">
        {debts.map((debt) => {
          const balance = agorot(Number(debt.currentBalance));
          const minimumPayment = agorot(Number(debt.minimumPayment));
          const aprBps = bps(debt.aprBps);
          const negativeAmortization = isNegativeAmortization(minimumPayment, balance, aprBps);
          const schedule = buildAmortizationSchedule(balance, aprBps, minimumPayment, { maxMonths: 600 });
          const summary = summarizePayoff(schedule);

          return (
            <li key={debt.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
                    {debt.name} <span className="text-xs text-muted">({DEBT_TYPE_LABEL[debt.debtType]})</span>
                    {negativeAmortization && (
                      <Badge variant="critical" pulse>
                        Negative amortization
                      </Badge>
                    )}
                  </p>
                  <p className="font-tabular-figures text-sm text-muted">
                    {formatAgorot(balance)} at {formatBpsAsPercent(aprBps)} APR — min. payment {formatAgorot(minimumPayment)}
                  </p>
                </div>
                <RecordPaymentForm debtId={debt.id} />
              </div>

              {negativeAmortization && (
                <p className="mt-2 rounded-md bg-negative/10 px-3 py-2 text-xs font-medium text-negative">
                  Warning: the minimum payment doesn&apos;t cover this month&apos;s interest — the balance will grow, not
                  shrink, at this payment level.
                </p>
              )}

              <p className="mt-2 text-xs text-muted">
                {summary.payoffAchieved
                  ? `At the minimum payment, payoff in ~${summary.monthsSimulated} months, paying ${formatAgorot(summary.totalInterestPaid)} in interest.`
                  : "At the minimum payment, this debt won't pay off within 50 years."}
              </p>

              {debt.payments.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-medium text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Payment history ({debt.payments.length})
                  </summary>
                  <ul className="mt-2 flex flex-col gap-1">
                    {debt.payments.map((payment) => (
                      <li key={payment.id} className="flex justify-between text-xs text-muted">
                        <span>{payment.paidAt.toISOString().slice(0, 10)}</span>
                        <span className="font-tabular-figures">{formatAgorot(agorot(Number(payment.amount)))}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>

      {comparison && (
        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Avalanche vs. snowball</h2>
          <form method="GET" className="mb-4 flex items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="extra-budget" className="text-xs font-medium text-muted">
                Extra monthly budget (₪)
              </label>
              <input
                id="extra-budget"
                name="extra"
                inputMode="decimal"
                defaultValue={extraBudgetInput}
                placeholder="0.00"
                className="w-32 rounded-md border border-border bg-bg px-3 py-2 font-tabular-figures text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <button
              type="submit"
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Recalculate
            </button>
          </form>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-medium text-fg">Avalanche (highest APR first)</h3>
              <p className="mt-1 text-xs text-muted">
                Order: {comparison.avalanche.order.map((id) => debtNameById.get(id)).join(" → ")}
              </p>
              <p className="mt-1 font-tabular-figures text-sm text-fg">
                Payoff in {comparison.avalanche.monthsToPayoff} months, {formatAgorot(comparison.avalanche.totalInterestPaid)}{" "}
                interest
              </p>
            </div>
            <div>
              <h3 className="text-sm font-medium text-fg">Snowball (smallest balance first)</h3>
              <p className="mt-1 text-xs text-muted">
                Order: {comparison.snowball.order.map((id) => debtNameById.get(id)).join(" → ")}
              </p>
              <p className="mt-1 font-tabular-figures text-sm text-fg">
                Payoff in {comparison.snowball.monthsToPayoff} months, {formatAgorot(comparison.snowball.totalInterestPaid)}{" "}
                interest
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
