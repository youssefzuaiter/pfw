import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildSafeToSpendData } from "../../src/server/analytics/build-safe-to-spend-data";
import { createAdminClient } from "../../src/server/db/admin-client";
import { createRecurringBill, deleteRecurringBill, listRecurringBills, updateRecurringBill } from "../../src/server/dal/recurring-bills";
import { gatherPhoneAlertFacts } from "../../src/server/dal/phone-alerts";
import { setSubscriptionStatus } from "../../src/server/dal/subscriptions";
import { parseRecurringBillBody } from "../../src/server/api/recurring-bill-validation";
import { buildSubscriptionRadarData } from "../../src/server/subscriptions/build-subscription-radar-data";
import { listBillsDueSoon } from "../../src/server/subscriptions/bills-due-soon";
import { manualBillKey } from "../../src/lib/recurring-bills";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * Subscriptions and bills typed in by hand (AGENTS.md §3cccc), against real
 * Postgres: the data layer and its isolation, how a bill reaches the radar's
 * list, Safe to Spend and the cost totals, the two ways it must not be counted
 * twice (paid this cycle, detected from statements), cancelling, and the
 * reminder window across a month boundary.
 *
 * Dates are fixed (mid-October 2026) so the result does not depend on when the
 * suite runs.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("recurring bills", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let owner: { id: string };
  let stranger: { id: string };
  let accountId: string;
  let categoryId: string;
  let strangerCategoryId: string;
  const created: string[] = [];

  const asOf = () => new Date("2026-10-16T09:00:00Z");
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

  async function addBill(input: Partial<Parameters<typeof createRecurringBill>[1]> = {}) {
    const result = await createRecurringBill(owner.id, {
      kind: "bill",
      amountVaries: false,
      name: "Gym",
      nativeAmount: 20_000,
      currency: "ILS",
      cadence: "monthly",
      anchorDate: day("2026-07-25"),
      categoryId: null,
      ...input,
    });
    if (!result.ok) throw new Error("setup failed");
    created.push(result.bill.id);
    return result.bill;
  }

  async function removeAllBills() {
    for (const id of created.splice(0)) await deleteRecurringBill(owner.id, id);
  }

  async function charge(name: string, iso: string, amountAgorot: bigint) {
    return admin.notableTransaction.create({
      data: {
        userId: owner.id,
        bankAccountId: accountId,
        categoryId,
        occurredAt: at(iso),
        currency: "ILS",
        nativeAmount: amountAgorot,
        amount: amountAgorot,
        description: name,
        merchantName: name,
      },
    });
  }

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    owner = await admin.user.create({ data: { email: `bills-owner-${stamp}@pfw.local`, displayName: "Bills Owner" } });
    stranger = await admin.user.create({ data: { email: `bills-stranger-${stamp}@pfw.local`, displayName: "Bills Stranger" } });
    categoryId = (await admin.category.create({ data: { userId: owner.id, slug: "subscriptions", name: "Subscriptions" } })).id;
    strangerCategoryId = (await admin.category.create({ data: { userId: stranger.id, slug: "subscriptions", name: "Subscriptions" } })).id;
    accountId = (
      await admin.bankAccount.create({
        data: {
          userId: owner.id,
          institutionName: "Test Bank",
          last4: "1111",
          accountType: "CHECKING",
          nativeBalance: 1_000_000n,
          balanceAsOf: day("2026-10-01"),
        },
      })
    ).id;
  });

  afterEach(async () => {
    // A failed assertion must not leave rows behind for the next case.
    await admin.recurringBill.deleteMany({ where: { userId: owner.id } });
    await admin.subscriptionTracking.deleteMany({ where: { userId: owner.id } });
    await admin.notableTransaction.deleteMany({ where: { userId: owner.id } });
    created.length = 0;
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [owner.id, stranger.id]);
  });

  describe("the data layer", () => {
    it("creates, lists, edits and deletes a bill", async () => {
      const bill = await addBill({ name: "Netflix", nativeAmount: 4_990, categoryId });
      expect(await listRecurringBills(owner.id)).toEqual([expect.objectContaining({ id: bill.id, name: "Netflix", nativeAmount: 4_990, cadence: "monthly", categoryId })]);

      const updated = await updateRecurringBill(owner.id, bill.id, {
        amountVaries: false,
        name: "Netflix Premium",
        nativeAmount: 6_990,
        currency: "USD",
        cadence: "annual",
        anchorDate: day("2026-12-01"),
        categoryId: null,
      });
      expect(updated).toMatchObject({ ok: true, bill: { name: "Netflix Premium", nativeAmount: 6_990, currency: "USD", cadence: "annual", categoryId: null } });

      expect(await deleteRecurringBill(owner.id, bill.id)).toBe(true);
      expect(await listRecurringBills(owner.id)).toEqual([]);
      created.length = 0;
    });

    it("keeps another user's bills invisible and untouchable", async () => {
      const bill = await addBill({ name: "Private" });
      expect(await listRecurringBills(stranger.id)).toEqual([]);
      expect(
        await updateRecurringBill(stranger.id, bill.id, { name: "Hijacked", amountVaries: false, nativeAmount: 1, currency: "ILS", cadence: "monthly", anchorDate: day("2026-10-01"), categoryId: null }),
      ).toBeNull();
      expect(await deleteRecurringBill(stranger.id, bill.id)).toBe(false);
      expect((await listRecurringBills(owner.id))[0].name).toBe("Private");
      await removeAllBills();
    });

    it("refuses a category that is not the caller's, on create and on edit", async () => {
      const input = { kind: "bill" as const, amountVaries: false, name: "Gym", nativeAmount: 20_000, currency: "ILS" as const, cadence: "monthly" as const, anchorDate: day("2026-07-25") };
      expect(await createRecurringBill(owner.id, { ...input, categoryId: strangerCategoryId })).toEqual({ ok: false, error: "category_not_found" });
      const bill = await addBill();
      expect(await updateRecurringBill(owner.id, bill.id, { ...input, categoryId: strangerCategoryId })).toEqual({ ok: false, error: "category_not_found" });
      await removeAllBills();
    });

    it("deleting a bill also removes the cancel state kept for it", async () => {
      const bill = await addBill();
      await setSubscriptionStatus(owner.id, { merchantKey: manualBillKey(bill.id), status: "CANCELLED" });
      expect(await admin.subscriptionTracking.count({ where: { userId: owner.id, merchantKey: manualBillKey(bill.id) } })).toBe(1);
      await deleteRecurringBill(owner.id, bill.id);
      created.length = 0;
      expect(await admin.subscriptionTracking.count({ where: { userId: owner.id, merchantKey: manualBillKey(bill.id) } })).toBe(0);
    });
  });

  describe("how a bill reaches the rest of the app", () => {
    it("appears in the radar's list and adds to the cost totals", async () => {
      const before = await buildSubscriptionRadarData(owner.id, asOf());
      const bill = await addBill({ name: "Gym", nativeAmount: 20_000 });
      const after = await buildSubscriptionRadarData(owner.id, asOf());

      expect(after.subscriptions.find((row) => row.manualBillId === bill.id)).toMatchObject({
        displayName: "Gym",
        isRecurring: true,
        cadence: "monthly",
        merchantKey: manualBillKey(bill.id),
        status: "ACTIVE",
      });
      expect(Number(after.cashDragMonthlyAgorot) - Number(before.cashDragMonthlyAgorot)).toBe(20_000);
      expect(after.manualBills).toEqual([expect.objectContaining({ id: bill.id, name: "Gym", detectedAs: null, nextDueDate: "2026-10-25" })]);
      await removeAllBills();
    });

    it("keeps bills and subscriptions apart: each is listed and totalled on its own page", async () => {
      const bill = await addBill({ kind: "bill", name: "Electricity", nativeAmount: 20_000 });
      const subscription = await addBill({ kind: "subscription", name: "Streamflix Plus", nativeAmount: 5_000 });
      const data = await buildSubscriptionRadarData(owner.id, asOf());

      expect(data.manualBills.find((item) => item.id === bill.id)?.kind).toBe("bill");
      expect(data.manualBills.find((item) => item.id === subscription.id)?.kind).toBe("subscription");
      expect(data.subscriptions.find((row) => row.manualBillId === bill.id)?.manualBillKind).toBe("bill");
      expect(data.subscriptions.find((row) => row.manualBillId === subscription.id)?.manualBillKind).toBe("subscription");

      // Each page's total counts only its own items; the combined figure (Safe to Spend, the runway) counts both.
      expect(data.billsCashDrag.monthly).toContain("200.00");
      expect(data.subscriptionsCashDrag.monthly).toContain("50.00");
      expect(data.subscriptionsCashDrag.monthly).not.toContain("200.00");
      expect(data.billsCashDrag.monthly).not.toContain("250.00");
      expect(Number(data.cashDragMonthlyAgorot)).toBe(25_000);
      await removeAllBills();
    });

    it("each page's total is what was actually charged this month for its own items", async () => {
      await addBill({ kind: "bill", name: "Electricity Company", nativeAmount: 30_000 });
      await addBill({ kind: "subscription", name: "Fitness Club", nativeAmount: 20_000 });
      await charge("ELECTRICITY COMPANY", "2026-10-05", -30_000n);
      await charge("FITNESS CLUB", "2026-10-13", -20_000n);
      // Charged last month: not part of October's total.
      await charge("FITNESS CLUB", "2026-09-13", -20_000n);
      const data = await buildSubscriptionRadarData(owner.id, asOf());

      expect(data.monthTotals.bills).toMatchObject({ monthLabel: "October 2026", spentCount: 1 });
      expect(data.monthTotals.bills.spent).toContain("300.00");
      expect(data.monthTotals.subscriptions).toMatchObject({ monthLabel: "October 2026", spentCount: 1 });
      expect(data.monthTotals.subscriptions.spent).toContain("200.00");
      expect(data.monthTotals.subscriptions.spent).not.toContain("400.00");
      await removeAllBills();
    });

    it("counts a detected subscription's charge this month, and what is still to come", async () => {
      await charge("Streamflix", "2026-07-20", -3_990n);
      await charge("Streamflix", "2026-08-20", -3_990n);
      await charge("Streamflix", "2026-09-20", -3_990n);
      await addBill({ kind: "bill", name: "Water Company", nativeAmount: 8_000, anchorDate: day("2026-10-28") });
      // Mid-October: the usual October Streamflix charge has not come yet, and the water bill is due on the 28th.
      const before = await buildSubscriptionRadarData(owner.id, new Date("2026-10-16T09:00:00Z"));
      expect(before.monthTotals.subscriptions.spentCount).toBe(0);
      expect(before.monthTotals.subscriptions.stillDue).toContain("39.90");
      expect(before.monthTotals.bills.stillDue).toContain("80.00");
      expect(before.monthTotals.bills.spentCount).toBe(0);

      await charge("Streamflix", "2026-10-20", -3_990n);
      const after = await buildSubscriptionRadarData(owner.id, new Date("2026-10-21T09:00:00Z"));
      expect(after.monthTotals.subscriptions.spentCount).toBe(1);
      expect(after.monthTotals.subscriptions.spent).toContain("39.90");
      expect(after.monthTotals.subscriptions.stillDue).toContain("0.00");
      await removeAllBills();
    });

    it("an item keeps its kind when edited, and a new one defaults to a bill", async () => {
      const subscription = await addBill({ kind: "subscription", name: "Streamflix Plus" });
      const updated = await updateRecurringBill(owner.id, subscription.id, {
        amountVaries: false,
        name: "Streamflix Max",
        nativeAmount: 6_000,
        currency: "ILS",
        cadence: "monthly",
        anchorDate: day("2026-07-25"),
        categoryId: null,
      });
      expect(updated).toMatchObject({ ok: true, bill: { kind: "subscription", name: "Streamflix Max" } });
      expect(parseRecurringBillBody({ name: "Water", amount: "30.00", currency: "ILS", cadence: "monthly", anchorDate: "2026-10-01" })).toMatchObject({
        ok: true,
        data: { kind: "bill" },
      });
      expect(parseRecurringBillBody({ name: "Water", amount: "30.00", currency: "ILS", cadence: "monthly", anchorDate: "2026-10-01", kind: "nonsense" }).ok).toBe(false);
      await removeAllBills();
    });

    it("lowers Safe to Spend by exactly the bill while it is still to come this month", async () => {
      const before = await buildSafeToSpendData(owner.id, asOf());
      await addBill({ name: "Gym", nativeAmount: 20_000, anchorDate: day("2026-07-25") });
      const after = await buildSafeToSpendData(owner.id, asOf());

      expect(Number(before.safeToSpendAgorot) - Number(after.safeToSpendAgorot)).toBe(20_000);
      expect(after.bills).toEqual([expect.objectContaining({ displayName: "Gym" })]);
      await removeAllBills();
    });

    it("stops lowering it once this month's charge has appeared: counted by the ledger, not twice", async () => {
      const bill = await addBill({ name: "Fitness", nativeAmount: 20_000, anchorDate: day("2026-07-12") });
      const unpaid = await buildSafeToSpendData(owner.id, asOf());
      expect(unpaid.bills).toHaveLength(1);
      expect(unpaid.bills[0]).toMatchObject({ overdue: true });

      const payment = await charge("FITNESS CLUB", "2026-10-13", -20_000n);
      const paid = await buildSafeToSpendData(owner.id, asOf());
      expect(paid.bills).toEqual([]);
      // The money is now out of cash through the transaction itself: 20,000 less than before, no more.
      expect(Number(unpaid.cashAgorot) - Number(paid.cashAgorot)).toBe(20_000);
      expect(Number(paid.billsNotCoveredAgorot)).toBe(0);

      await admin.notableTransaction.delete({ where: { id: payment.id } });
      await deleteRecurringBill(owner.id, bill.id);
      created.length = 0;
    });

    it("is left to the detected subscription once statements show it, so it is never counted twice", async () => {
      await addBill({ name: "Streamflix", nativeAmount: 3_990, anchorDate: day("2026-07-20") });
      const rows = [
        await charge("Streamflix", "2026-07-20", -3_990n),
        await charge("Streamflix", "2026-08-20", -3_990n),
        await charge("Streamflix", "2026-09-20", -3_990n),
      ];
      const radar = await buildSubscriptionRadarData(owner.id, asOf());
      const detected = radar.subscriptions.filter((row) => row.displayName.toLowerCase().includes("streamflix"));
      expect(detected).toHaveLength(1);
      expect(detected[0].manualBillId).toBeUndefined();
      expect(radar.manualBills[0]).toMatchObject({ name: "Streamflix", detectedAs: "Streamflix", nextDueDate: null });

      for (const row of rows) await admin.notableTransaction.delete({ where: { id: row.id } });
      await removeAllBills();
    });

    it("stops counting once cancelled, and counts again when reactivated", async () => {
      const bill = await addBill({ name: "Gym", nativeAmount: 20_000, anchorDate: day("2026-07-25") });
      const counted = await buildSafeToSpendData(owner.id, asOf());
      expect(counted.bills).toHaveLength(1);

      await setSubscriptionStatus(owner.id, { merchantKey: manualBillKey(bill.id), status: "CANCELLED" });
      const cancelled = await buildSafeToSpendData(owner.id, asOf());
      expect(cancelled.bills).toEqual([]);
      expect(Number(cancelled.safeToSpendAgorot) - Number(counted.safeToSpendAgorot)).toBe(20_000);
      const radar = await buildSubscriptionRadarData(owner.id, asOf());
      expect(radar.manualBills[0].status).toBe("CANCELLED");

      await setSubscriptionStatus(owner.id, { merchantKey: manualBillKey(bill.id), status: "ACTIVE" });
      expect((await buildSafeToSpendData(owner.id, asOf())).bills).toHaveLength(1);
      await removeAllBills();
    });

    it("a quarterly bill counts only in the months it is due", async () => {
      // Feb, May, Aug, Nov: October is not one of them. Jan, Apr, Jul, Oct: it is.
      await addBill({ name: "Insurance", nativeAmount: 90_000, cadence: "quarterly", anchorDate: day("2026-02-20") });
      expect((await buildSafeToSpendData(owner.id, asOf())).bills).toEqual([]);
      await removeAllBills();
      await addBill({ name: "Insurance", nativeAmount: 90_000, cadence: "quarterly", anchorDate: day("2026-01-20") });
      expect((await buildSafeToSpendData(owner.id, asOf())).bills).toEqual([expect.objectContaining({ displayName: "Insurance" })]);
      await removeAllBills();
    });
  });

  describe("a bill whose amount varies", () => {
    it("is stored as varying, and an edit can switch it back", async () => {
      const bill = await addBill({ name: "Electricity", nativeAmount: 30_000, amountVaries: true });
      expect((await listRecurringBills(owner.id))[0]).toMatchObject({ id: bill.id, amountVaries: true });
      const updated = await updateRecurringBill(owner.id, bill.id, {
        amountVaries: false,
        name: "Electricity",
        nativeAmount: 30_000,
        currency: "ILS",
        cadence: "monthly",
        anchorDate: day("2026-07-25"),
        categoryId: null,
      });
      expect(updated).toMatchObject({ ok: true, bill: { amountVaries: false } });
    });

    it("is off unless asked for, and only a real boolean turns it on", () => {
      const body = { name: "Water", amount: "30.00", currency: "ILS", cadence: "monthly", anchorDate: "2026-10-01" };
      expect(parseRecurringBillBody(body)).toMatchObject({ ok: true, data: { amountVaries: false } });
      expect(parseRecurringBillBody({ ...body, amountVaries: true })).toMatchObject({ ok: true, data: { amountVaries: true } });
      expect(parseRecurringBillBody({ ...body, amountVaries: "yes" }).ok).toBe(false);
    });

    it("is listed and counted at the average of its last payments, not the typed amount", async () => {
      await addBill({ name: "Electricity Company", nativeAmount: 30_000, amountVaries: true, anchorDate: day("2026-07-25") });
      await charge("ELECTRICITY COMPANY", "2026-08-05", -20_000n);
      await charge("ELECTRICITY COMPANY", "2026-09-05", -40_000n);
      const data = await buildSubscriptionRadarData(owner.id, asOf());

      expect(data.manualBills[0]).toMatchObject({ amountVaries: true, expectedNativeAmount: 30_000, estimateBasedOnPayments: 2 });
      expect(data.manualBills[0].formattedAmount).toContain("300.00");
      expect(data.billsCashDrag.monthly).toContain("300.00");
      await removeAllBills();
    });

    it("falls back to the typed amount while it has no payments", async () => {
      await addBill({ name: "Electricity Company", nativeAmount: 45_000, amountVaries: true, anchorDate: day("2026-07-25") });
      const data = await buildSubscriptionRadarData(owner.id, asOf());
      expect(data.manualBills[0]).toMatchObject({ expectedNativeAmount: 45_000, estimateBasedOnPayments: 0 });
      await removeAllBills();
    });

    it("lowers Safe to Spend by the estimate while still to come, and not at all once paid, however big the payment", async () => {
      await charge("ELECTRICITY COMPANY", "2026-09-05", -20_000n);
      await charge("ELECTRICITY COMPANY", "2026-08-05", -40_000n);
      const before = await buildSafeToSpendData(owner.id, asOf());
      await addBill({ name: "Electricity Company", nativeAmount: 99_999, amountVaries: true, anchorDate: day("2026-07-25") });
      const pending = await buildSafeToSpendData(owner.id, asOf());
      expect(Number(before.safeToSpendAgorot) - Number(pending.safeToSpendAgorot)).toBe(30_000);

      // This month's bill arrives at three times the estimate: still recognised as the payment, so not deducted again.
      await charge("ELECTRICITY COMPANY", "2026-10-10", -90_000n);
      const paid = await buildSafeToSpendData(owner.id, asOf());
      expect(paid.bills).toEqual([]);
      // Cash fell by the 900.00 paid; the 300.00 estimate is no longer deducted on top of it.
      expect(Number(pending.safeToSpendAgorot) - Number(paid.safeToSpendAgorot)).toBe(60_000);
      await removeAllBills();
    });

    it("counts a far-off charge in this month's total only for a varying bill, not a fixed one", async () => {
      await addBill({ name: "Electricity Company", nativeAmount: 30_000, amountVaries: true });
      await addBill({ name: "Water Company", nativeAmount: 30_000, amountVaries: false });
      await charge("ELECTRICITY COMPANY", "2026-10-05", -90_000n);
      await charge("WATER COMPANY", "2026-10-06", -90_000n);
      const data = await buildSubscriptionRadarData(owner.id, asOf());
      expect(data.monthTotals.bills.spentCount).toBe(1);
      expect(data.monthTotals.bills.spent).toContain("900.00");
      await removeAllBills();
    });
  });

  describe("reminders", () => {
    it("finds a bill due inside the window, including one in next month, and not one outside it", async () => {
      // Today is the 30th; the window runs to Nov 2.
      const now = new Date("2026-10-30T09:00:00Z");
      const rent = await addBill({ name: "Rent", nativeAmount: 400_000, anchorDate: day("2026-07-01") }); // due Nov 1
      await addBill({ name: "Phone", nativeAmount: 8_000, anchorDate: day("2026-07-02") }); // due Nov 2
      await addBill({ name: "Water", nativeAmount: 5_000, anchorDate: day("2026-07-10") }); // due Nov 10: outside

      const due = await listBillsDueSoon(owner.id, now);
      expect(due.map((bill) => bill.name)).toEqual(["Rent", "Phone"]);
      expect(due[0]).toMatchObject({ key: `${manualBillKey(rent.id)}|2026-11-01`, due: "2026-11-01", daysAway: 2 });
      await removeAllBills();
    });

    it("leaves out a bill whose date has passed and one already paid", async () => {
      const now = new Date("2026-10-30T09:00:00Z");
      await addBill({ name: "Passed", anchorDate: day("2026-07-28") }); // due Oct 28: passed
      await addBill({ name: "Paid Club", nativeAmount: 15_000, anchorDate: day("2026-07-31") }); // due Oct 31
      const payment = await charge("PAID CLUB", "2026-10-29", -15_000n);
      expect(await listBillsDueSoon(owner.id, now)).toEqual([]);
      await admin.notableTransaction.delete({ where: { id: payment.id } });
      await removeAllBills();
    });

    it("reaches the phone alert's facts, formatted, with a key per due date", async () => {
      const now = new Date("2026-10-16T09:00:00Z");
      await addBill({ name: "Netflix", nativeAmount: 4_990, anchorDate: day("2026-07-18") }); // due Oct 18
      const facts = await gatherPhoneAlertFacts(owner.id, { since: null, now, largeExpenseAgorot: 100_000 });
      expect(facts.billsDue).toEqual([expect.objectContaining({ name: "Netflix", amount: "₪49.90", due: "2026-10-18" })]);
      expect(facts.billsDue[0].key).toMatch(/^manual:.+\|2026-10-18$/);
      await removeAllBills();
    });
  });
});
