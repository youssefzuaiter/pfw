import { AcceptInviteForm } from "../../components/household/accept-invite-form";
import { CreateHouseholdForm } from "../../components/household/create-household-form";
import { HouseholdAdminPanel } from "../../components/household/household-admin-panel";
import { HouseholdNav } from "../../components/household/household-nav";
import { currentMonthKey } from "../../lib/date-month";
import { nativeAmount } from "../../lib/currency";
import { convertNativeAmountToAgorot } from "../../lib/exchange-rate";
import { formatAgorot } from "../../lib/money";
import { getCurrentUser } from "../../server/auth/current-user";
import { getAvailableToBudget, getEnvelopeBalances } from "../../server/dal/envelopes";
import { getLatestRateTable } from "../../server/dal/exchange-rates";
import {
  getSharedGroupData,
  listGroupInvites,
  listGroupMembers,
  listMyGroups,
} from "../../server/dal/shared-groups";
import { EnvelopeRow, type EnvelopeRowData } from "./_components/envelope-row";
import { HouseholdSharedView } from "./_components/household-shared-view";

export const instant = false;

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
          envelopeAllocations={sharedData.envelopeAllocations}
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

  const month = currentMonthKey();
  const [availableAgorot, envelopeBalances] = await Promise.all([
    getAvailableToBudget(user.id, month),
    getEnvelopeBalances(user.id, month),
  ]);

  const envelopeRows: EnvelopeRowData[] = envelopeBalances
    .slice()
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName))
    .map((envelope) => {
      const utilization =
        envelope.allocatedThisMonthAgorot > 0 ? envelope.spentThisMonthAgorot / envelope.allocatedThisMonthAgorot : 0;
      return {
        categoryId: envelope.categoryId,
        categoryName: envelope.categoryName,
        balanceFormatted: formatAgorot(envelope.balanceAgorot, { showPositiveSign: true }),
        balanceIsNegative: envelope.balanceAgorot < 0,
        allocatedThisMonthValue: (envelope.allocatedThisMonthAgorot / 100).toFixed(2),
        spentThisMonthFormatted: formatAgorot(envelope.spentThisMonthAgorot),
        utilization,
        sharedGroupId: envelope.sharedGroupId,
      };
    });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-fg">Budgets</h1>
        <HouseholdNav basePath="/budgets" groups={groupOptions} activeGroupId={null} />
      </div>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Available to budget</h2>
        <p
          className={`mt-1 font-tabular-figures text-3xl font-semibold ${availableAgorot < 0 ? "text-negative" : "text-positive"}`}
        >
          {formatAgorot(availableAgorot)}
        </p>
        <p className="mt-1 text-xs text-muted">
          Real income received through {month}, minus everything allocated so far — every ₪ should eventually be
          assigned somewhere.
        </p>
      </section>

      <ul className="flex flex-col gap-4">
        {envelopeRows.map((envelope) => (
          <EnvelopeRow key={envelope.categoryId} envelope={envelope} month={month} groups={groupOptions} />
        ))}
      </ul>

      {envelopeRows.length === 0 && (
        <p className="text-sm text-muted">No categories to budget yet — create one under Categories first.</p>
      )}

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Household Spaces</h2>
        <p className="mb-3 text-sm text-muted">
          Create a household to share specific envelopes, accounts, or categories with other people — your other
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
