import { Tickbar, type TickbarStatus } from "../../components/tickbar/tickbar";
import { TiltCard } from "../../components/tilt/tilt-card";
import { AcceptInviteForm } from "../../components/household/accept-invite-form";
import { CreateHouseholdForm } from "../../components/household/create-household-form";
import { HouseholdAdminPanel } from "../../components/household/household-admin-panel";
import { HouseholdNav } from "../../components/household/household-nav";
import { ShareResourceControl } from "../../components/household/share-resource-control";
import { computeMonthProgress, computeProrationStatus, type ProrationStatus } from "../../lib/budget-proration";
import { nativeAmount } from "../../lib/currency";
import { convertNativeAmountToAgorot } from "../../lib/exchange-rate";
import { agorot, formatAgorot } from "../../lib/money";
import { getCurrentUser } from "../../server/auth/current-user";
import { listBudgets } from "../../server/dal/budgets";
import { listCategories } from "../../server/dal/categories";
import { getLatestRateTable } from "../../server/dal/exchange-rates";
import {
  getSharedGroupData,
  listGroupInvites,
  listGroupMembers,
  listMyGroups,
} from "../../server/dal/shared-groups";
import { getSpendByCategoryInRange } from "../../server/dal/transactions";
import { BudgetForm } from "./_components/budget-form";
import { DeleteBudgetButton } from "./_components/delete-budget-button";
import { HouseholdSharedView } from "./_components/household-shared-view";

export const instant = false;

function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfNextMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function statusFromUtilization(utilization: number): TickbarStatus {
  if (utilization >= 1) return "critical";
  if (utilization >= 0.8) return "warning";
  return "good";
}

const PACE_LABEL: Record<ProrationStatus, string> = {
  under_pace: "Under pace — spending less than expected for this point in the month.",
  on_pace: "On pace with the month so far.",
  over_pace: "Over pace — spending faster than expected for this point in the month.",
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();

  const myGroups = await listMyGroups(user.id);
  const groupOptions = myGroups.map((g) => ({ id: g.group.id, name: g.group.name }));

  const requestedGroupId = firstParam(params.group);
  const activeMembership =
    firstParam(params.view) === "household" && requestedGroupId
      ? myGroups.find((g) => g.group.id === requestedGroupId)
      : undefined;

  if (activeMembership) {
    const [sharedData, members, invites, rateTable] = await Promise.all([
      getSharedGroupData(user.id, activeMembership.group.id),
      listGroupMembers(user.id, activeMembership.group.id),
      activeMembership.membership.role === "OWNER"
        ? listGroupInvites(user.id, activeMembership.group.id)
        : Promise.resolve([]),
      getLatestRateTable(),
    ]);

    // The Currency UI Toggle (Punch List Phase 3, item 2) needs BOTH
    // figures available client-side to switch between them — computed
    // here, at the latest synced rate, the same live-conversion
    // treatment every other foreign-currency balance in this app gets
    // (never stored, per law #5 — a live balance's ₪ equivalent moves
    // with the rate, so persisting one would go stale immediately).
    const bankAccountsWithIls = sharedData.bankAccounts.map((account) => ({
      ...account,
      agorotValue: Number(
        convertNativeAmountToAgorot(
          nativeAmount(Number(account.nativeBalance)),
          account.currency,
          rateTable[account.currency],
        ),
      ),
    }));

    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold text-fg">{activeMembership.group.name}</h1>
          <HouseholdNav basePath="/budgets" groups={groupOptions} activeGroupId={activeMembership.group.id} />
        </div>

        <HouseholdSharedView
          myUserId={user.id}
          budgets={sharedData.budgets}
          bankAccounts={bankAccountsWithIls}
          categories={sharedData.categories}
        />

        <HouseholdAdminPanel
          sharedGroupId={activeMembership.group.id}
          groupName={activeMembership.group.name}
          myUserId={user.id}
          myRole={activeMembership.membership.role}
          members={members.map((m) => ({
            userId: m.userId,
            displayName: m.user.displayName,
            role: m.role,
            permission: m.permission,
          }))}
          pendingInvites={invites.map((i) => ({
            id: i.id,
            invitedEmail: i.invitedEmail,
            permission: i.permission,
            status: i.status,
            expiresAt: i.expiresAt.toISOString(),
          }))}
        />
      </div>
    );
  }

  const now = new Date();
  const monthStart = startOfMonthUtc(now);
  const nextMonthStart = startOfNextMonthUtc(now);
  const monthProgress = computeMonthProgress(now);

  const [budgets, categories, spendRows] = await Promise.all([
    listBudgets(user.id),
    listCategories(user.id),
    getSpendByCategoryInRange(user.id, monthStart, nextMonthStart),
  ]);

  const spendByCategory = new Map(spendRows.map((row) => [row.categoryId, agorot(Number(row.totalAgorot))]));
  const budgetedCategoryIds = new Set(budgets.map((budget) => budget.categoryId));
  const unbudgetedCategories = categories.filter((c) => !c.isUncategorized && !budgetedCategoryIds.has(c.id));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-fg">Budgets</h1>
        <HouseholdNav basePath="/budgets" groups={groupOptions} activeGroupId={null} />
      </div>

      {budgets.length === 0 && (
        <p className="text-sm text-muted">No budgets set yet — pick a category below to get started.</p>
      )}

      <ul className="flex flex-col gap-4">
        {budgets.map((budget) => {
          const spent = spendByCategory.get(budget.categoryId) ?? agorot(0);
          const limit = agorot(Number(budget.monthlyLimit));
          const utilization = limit > 0 ? spent / limit : 0;
          const status = statusFromUtilization(utilization);
          const proration = computeProrationStatus(spent, limit, monthProgress);

          return (
            <li key={budget.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-fg">{budget.category.name}</p>
                  <p className="font-tabular-figures text-sm text-muted">
                    {formatAgorot(spent)} of {formatAgorot(limit)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <BudgetForm categoryId={budget.categoryId} initialLimit={(limit / 100).toFixed(2)} compact />
                  <DeleteBudgetButton budgetId={budget.id} />
                  <ShareResourceControl
                    resourceType="budget"
                    resourceId={budget.id}
                    groups={groupOptions}
                    currentSharedGroupId={budget.sharedGroupId}
                  />
                </div>
              </div>
              <div className="mt-3">
                <Tickbar label={`${budget.category.name} utilization`} percent={utilization * 100} status={status} />
              </div>
              <p className="mt-2 text-xs text-muted">{PACE_LABEL[proration]}</p>
            </li>
          );
        })}
      </ul>

      {unbudgetedCategories.length > 0 && (
        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Set a budget</h2>
          {/*
            These cards carry no financial figures — they're a pure
            call-to-action per unbudgeted category — so a 3D tilt is safe
            here per Section 5's "never apply tilt to cards containing
            active figures being read".
          */}
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {unbudgetedCategories.map((category) => (
              <li key={category.id}>
                <TiltCard className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-bg p-3">
                  <span className="text-sm text-fg">{category.name}</span>
                  <BudgetForm categoryId={category.id} compact />
                </TiltCard>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Household Spaces</h2>
        <p className="mb-3 text-sm text-muted">
          Create a household to share specific budgets, accounts, or categories with other people — your other
          personal data (transactions, goals, debts, and everything else) always stays strictly yours.
        </p>
        <div className="flex flex-col gap-3">
          <CreateHouseholdForm />
          <AcceptInviteForm />
        </div>
      </section>
    </div>
  );
}
