import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAccount } from "../../src/server/account/delete-account";
import { createAdminClient } from "../../src/server/db/admin-client";
import { createRecurringBill } from "../../src/server/dal/recurring-bills";
import { buildDashboardData } from "../../src/server/dashboard/build-dashboard-data";

/**
 * The 60-day cash-flow forecast with the bills typed in (AGENTS.md §3llll),
 * against real Postgres: each bill's charges land on their due dates, what is
 * already paid or cancelled is left out, nothing is counted twice (a bill the
 * recurring detection already projects, or a bill's own past charges inside
 * the flat daily rate), and a bill billed by use is at its expected amount.
 *
 * Fixed date (mid-October 2026). Each case uses a fresh user so no row from
 * another case can change a total.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("forecast with bills", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const users: string[] = [];
  const NOW = new Date("2026-10-16T09:00:00Z");
  const START = 1_000_000;
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

  async function seedUser(label: string) {
    const user = await admin.user.create({ data: { email: `forecast-${label}-${stamp}@pfw.local`, displayName: `Forecast ${label}` } });
    users.push(user.id);
    const category = await admin.category.create({ data: { userId: user.id, slug: "misc", name: "Misc" } });
    const account = await admin.bankAccount.create({
      data: { userId: user.id, institutionName: "Test Bank", last4: "1111", accountType: "CHECKING", nativeBalance: BigInt(START), balanceAsOf: day("2026-10-16") },
    });
    const charge = (name: string, iso: string, amount: number) =>
      admin.notableTransaction.create({
        data: {
          userId: user.id,
          bankAccountId: account.id,
          categoryId: category.id,
          occurredAt: new Date(`${iso}T12:00:00Z`),
          amount: BigInt(-amount),
          nativeAmount: BigInt(-amount),
          description: name,
          merchantName: name,
          isManual: true,
          needsReview: false,
        },
      });
    const bill = async (name: string, amount: number, anchor: string, extra: { amountVaries?: boolean } = {}) => {
      const result = await createRecurringBill(user.id, {
        kind: "bill",
        amountVaries: extra.amountVaries ?? false,
        name,
        nativeAmount: amount,
        currency: "ILS",
        cadence: "monthly",
        anchorDate: day(anchor),
        categoryId: null,
      });
      if (!result.ok) throw new Error("setup failed");
      return result.bill;
    };
    return { id: user.id, charge, bill };
  }

  const eventsOf = (data: Awaited<ReturnType<typeof buildDashboardData>>) =>
    data.cashFlowForecast.days.flatMap((d) => d.events.map((e) => ({ date: d.date.toISOString().slice(0, 10), key: e.merchantKey, amount: Number(e.amount) })));

  beforeAll(() => {
    admin = createAdminClient();
  });

  afterAll(async () => {
    for (const id of users) await deleteAccount(id);
    await admin.accountDeletionRecord.deleteMany({ where: { deletedUserId: { in: users } } });
  });

  it("puts a bill's charges on their due dates and takes them off the balance", async () => {
    const u = await seedUser("fixed");
    const gym = await u.bill("Gym", 20_000, "2026-07-25");
    const data = await buildDashboardData(u.id, NOW);

    expect(eventsOf(data)).toEqual([
      { date: "2026-10-25", key: `manual:${gym.id}`, amount: -20_000 },
      { date: "2026-11-25", key: `manual:${gym.id}`, amount: -20_000 },
    ]);
    expect(data.forecastBills).toEqual({ count: 2, totalAgorot: 40_000 });
    expect(data.cashFlowForecast.endingBalance).toBe(START - 40_000);
    const before = data.cashFlowForecast.days.find((d) => d.date.toISOString().startsWith("2026-10-24"))!;
    expect(Number(before.projectedBalance)).toBe(START);
  });

  it("leaves out a due date already paid, and a bill that is cancelled", async () => {
    const paid = await seedUser("paid");
    await paid.bill("Gym", 20_000, "2026-07-20");
    await paid.charge("GYM", "2026-10-12", 20_000); // settles October 20 (a charge counts from ten days before)
    const paidData = await buildDashboardData(paid.id, NOW);
    expect(eventsOf(paidData).map((e) => e.date)).toEqual(["2026-11-20"]);

    const cancelled = await seedUser("cancelled");
    const bill = await cancelled.bill("Gym", 20_000, "2026-07-25");
    await admin.subscriptionTracking.create({ data: { userId: cancelled.id, merchantKey: `manual:${bill.id}`, status: "CANCELLED" } });
    const cancelledData = await buildDashboardData(cancelled.id, NOW);
    expect(eventsOf(cancelledData)).toEqual([]);
    expect(cancelledData.forecastBills.count).toBe(0);
  });

  it("does not count a bill's own past charges a second time in the daily rate", async () => {
    const u = await seedUser("rate");
    await u.bill("Gym", 20_000, "2026-07-25");
    await u.charge("GYM", "2026-08-25", 20_000);
    await u.charge("GYM", "2026-09-25", 20_000);
    await u.charge("Coffee", "2026-09-20", 9_000);
    const data = await buildDashboardData(u.id, NOW);
    // Two bill charges to come (-40,000), plus only the coffee in the flat rate: 9,000 over 90 days is 100 a day.
    expect(data.cashFlowForecast.endingBalance).toBe(START - 40_000 - 60 * 100);
  });

  it("leaves a bill to the recurring detection when it already projects the same charges", async () => {
    const u = await seedUser("detected");
    await u.bill("Netflix", 5_000, "2026-07-20");
    await u.charge("Netflix", "2026-07-18", 5_000);
    await u.charge("Netflix", "2026-08-17", 5_000);
    await u.charge("Netflix", "2026-09-16", 5_000);
    const data = await buildDashboardData(u.id, NOW);
    expect(eventsOf(data).some((e) => e.key.startsWith("manual:"))).toBe(false);
    expect(data.forecastBills.count).toBe(0);
    // The detection's own projection is still there.
    expect(eventsOf(data).some((e) => e.key === "netflix")).toBe(true);
  });

  it("uses the expected amount for a bill billed by use", async () => {
    const u = await seedUser("varies");
    await u.bill("Electricity", 99_999, "2026-07-25", { amountVaries: true });
    await u.charge("ELECTRICITY", "2026-08-05", 40_000);
    await u.charge("ELECTRICITY", "2026-09-05", 20_000);
    const data = await buildDashboardData(u.id, NOW);
    expect(eventsOf(data).map((e) => e.amount)).toEqual([-30_000, -30_000]);
  });

  it("does not include another user's bills", async () => {
    const owner = await seedUser("owner");
    await owner.bill("Gym", 20_000, "2026-07-25");
    const stranger = await seedUser("stranger");
    const data = await buildDashboardData(stranger.id, NOW);
    expect(eventsOf(data)).toEqual([]);
    expect(data.forecastBills.count).toBe(0);
  });
});
