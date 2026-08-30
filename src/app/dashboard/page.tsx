import Link from "next/link";
import { getCurrentUser } from "../../server/auth/current-user";
import { buildDashboardData } from "../../server/dashboard/build-dashboard-data";
import { getVaultStatus } from "../../server/dal/dead-mans-switch";
import { getSharedGroupData, listMyGroups } from "../../server/dal/shared-groups";
import { AttentionFeed } from "./_components/attention-feed";
import { CashFlowChart } from "./_components/cash-flow-chart";
import { CategoryDonut } from "./_components/category-donut";
import { DeadMansSwitchSummary } from "./_components/dead-mans-switch-summary";
import { HouseholdSummary } from "./_components/household-summary";
import { IncomeExpenseChart } from "./_components/income-expense-chart";
import { NetWorthHero } from "./_components/net-worth-hero";

// This screen is entirely live, per-user financial data — never a
// candidate for static prerendering or cross-request caching (see
// build-dashboard-data.ts's doc comment on why it uses React's
// request-scoped `cache()` instead of Next's `'use cache'`).
export const instant = false;

export default async function DashboardPage() {
  const user = await getCurrentUser();
  const [data, myGroups, vaultStatus] = await Promise.all([
    buildDashboardData(user.id),
    listMyGroups(user.id),
    getVaultStatus(user.id),
  ]);

  const households = await Promise.all(
    myGroups.map(async ({ group, membership }) => {
      const shared = await getSharedGroupData(user.id, group.id);
      return {
        id: group.id,
        name: group.name,
        role: membership.role,
        permission: membership.permission,
        sharedBudgetCount: shared.budgets.length,
        sharedAccountCount: shared.bankAccounts.length,
      };
    }),
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-fg">Dashboard</h1>
        <Link
          href="/analytics"
          className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Retirement analytics →
        </Link>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <NetWorthHero netWorth={data.netWorth} history={data.netWorthHistory} />
        <AttentionFeed insights={data.insights} />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <HouseholdSummary households={households} />
        <DeadMansSwitchSummary isSetUp={vaultStatus.isSetUp} status={vaultStatus.status} />
      </div>

      <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="cash-flow-heading">
        <h2 id="cash-flow-heading" className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
          60-day cash-flow forecast
        </h2>
        <CashFlowChart
          days={data.cashFlowForecast.days.map((d) => ({ date: d.date, balance: d.projectedBalance }))}
          minimum={data.cashFlowForecast.minimum}
        />
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="category-spend-heading">
          <h2 id="category-spend-heading" className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
            Category spending — this month
          </h2>
          <CategoryDonut breakdown={data.categorySpendBreakdown.map((c) => ({ categoryName: c.categoryName, amount: c.amount }))} />
        </section>

        <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="income-expense-heading">
          <h2 id="income-expense-heading" className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
            Income vs. expense
          </h2>
          <IncomeExpenseChart
            history={data.incomeExpenseHistory.map((m) => ({ monthKey: m.monthKey, income: m.income, expense: m.expense }))}
          />
        </section>
      </div>
    </div>
  );
}
