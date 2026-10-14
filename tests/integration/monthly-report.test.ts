import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { gatherMonthlyReport } from "../../src/server/reports/monthly-report";
import { claimMonthlyReport, releaseMonthlyReport, updateUserSettings } from "../../src/server/dal/user-settings";
import { ILS_REPORTING } from "../../src/lib/reporting-currency";

/**
 * The monthly report's database halves against real Postgres with RLS
 * (AGENTS.md §3lll): the figures it gathers for one month, and the claim
 * that makes each month go out once. The all-users job and the email itself
 * are unit-tested; nothing here sends mail.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("monthly report", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    userA = await admin.user.create({ data: { email: `report-a-${stamp}@pfw.local`, displayName: "Report A" } });
    userB = await admin.user.create({ data: { email: `report-b-${stamp}@pfw.local`, displayName: "Report B" } });

    const account = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "9999", accountType: "CHECKING", nativeBalance: 0n },
    });
    const uncategorized = await admin.category.create({
      data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    const groceries = await admin.category.create({ data: { userId: userA.id, slug: "groceries", name: "Groceries" } });
    const dining = await admin.category.create({ data: { userId: userA.id, slug: "dining", name: "Dining" } });

    async function tx(day: string, amount: bigint, categoryId: string, extra = {}) {
      await admin.notableTransaction.create({
        data: {
          userId: userA.id, bankAccountId: account.id, categoryId, occurredAt: new Date(`${day}T12:00:00Z`),
          amount, nativeAmount: amount, description: "fixture", isManual: true, needsReview: false, ...extra,
        },
      });
    }
    await tx("2026-09-03", 500_000n, uncategorized.id); // income
    await tx("2026-09-05", -60_000n, groceries.id);
    await tx("2026-09-20", -40_000n, groceries.id);
    await tx("2026-09-21", -30_000n, dining.id);
    await tx("2026-09-22", -900_000n, uncategorized.id, { isTransfer: true }); // own-account transfer: not spending
    await tx("2026-10-02", -77_000n, dining.id); // next month: not counted

    for (const [day, value] of [["2026-09-01", 1_000_000n], ["2026-09-15", 1_100_000n], ["2026-09-30", 1_250_000n], ["2026-10-01", 9_999_999n]] as const) {
      await admin.netWorthSnapshot.create({
        data: { userId: userA.id, snapshotDate: new Date(`${day}T00:00:00Z`), totalAssetsAgorot: value, totalLiabilitiesAgorot: 0n, netWorthAgorot: value },
      });
    }
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  it("gathers the month's income, spending, top categories and net-worth change, and nothing outside the month", async () => {
    const data = await gatherMonthlyReport(userA.id, "2026-09");
    expect(data).toEqual({
      monthKey: "2026-09",
      incomeAgorot: 500_000n,
      expenseAgorot: 130_000n, // the transfer and October's row are left out
      // In shekels the figures shown are the stored agorot (AGENTS.md §3vvv).
      incomeShown: 500_000,
      expenseShown: 130_000,
      topCategories: [
        { name: "Groceries", spentAgorot: 100_000n, spentShown: 100_000 },
        { name: "Dining", spentAgorot: 30_000n, spentShown: 30_000 },
      ],
      // October 1st's snapshot is the next month's.
      netWorth: { startAgorot: 1_000_000n, endAgorot: 1_250_000n, startShown: 1_000_000, endShown: 1_250_000 },
      core: null,
      reporting: ILS_REPORTING, // no settings row: totals in shekels (AGENTS.md §3nnn)
    });
  });

  it("shows another user nothing of this user's month (RLS)", async () => {
    const data = await gatherMonthlyReport(userB.id, "2026-09");
    expect(data).toEqual({
      monthKey: "2026-09",
      incomeAgorot: 0n,
      expenseAgorot: 0n,
      incomeShown: 0,
      expenseShown: 0,
      topCategories: [],
      netWorth: null,
      core: null,
      reporting: ILS_REPORTING,
    });
  });

  it("claims a month only for an opted-in user, only once, and a release lets it be claimed again", async () => {
    expect(await claimMonthlyReport(userA.id, "2026-09")).toEqual({ claimed: false }); // not opted in (no settings row)

    await updateUserSettings(userA.id, { monthlyReportEnabled: true, monthlyReportLastSentMonth: "2026-08" });
    expect(await claimMonthlyReport(userA.id, "2026-09")).toEqual({ claimed: true, previous: "2026-08" });
    expect(await claimMonthlyReport(userA.id, "2026-09")).toEqual({ claimed: false }); // already claimed

    await releaseMonthlyReport(userA.id, "2026-09", "2026-08");
    const settings = await admin.userSettings.findUniqueOrThrow({ where: { userId: userA.id } });
    expect(settings.monthlyReportLastSentMonth).toBe("2026-08");
    expect(await claimMonthlyReport(userA.id, "2026-09")).toEqual({ claimed: true, previous: "2026-08" });
  });

  it("never claims another user's month (RLS)", async () => {
    await updateUserSettings(userB.id, { monthlyReportEnabled: true });
    await releaseMonthlyReport(userA.id, "2026-09", null); // A's release cannot reach B's row either
    const b = await admin.userSettings.findUniqueOrThrow({ where: { userId: userB.id } });
    expect(b.monthlyReportLastSentMonth).toBeNull();
    expect(await claimMonthlyReport(userB.id, "2026-09")).toEqual({ claimed: true, previous: null });
  });
});
