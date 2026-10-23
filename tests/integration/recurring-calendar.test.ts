import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { createRecurringBill } from "../../src/server/dal/recurring-bills";
import { buildRecurringCalendar, resolveCalendarMonth } from "../../src/server/subscriptions/build-recurring-calendar";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * The calendar on the Subscriptions page and on the Bills page (AGENTS.md
 * §3gggg), against real Postgres: each page draws only its own items, a charge
 * that really happened shows as paid on its own day, a subscription found in the
 * statements is projected forward, and another user sees none of it.
 *
 * Dates are fixed (mid-October 2026) so the result does not depend on when the
 * suite runs.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("recurring calendar", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let owner: { id: string };
  let stranger: { id: string };
  let accountId: string;
  let categoryId: string;

  const asOf = new Date("2026-10-16T09:00:00Z");
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

  async function addBill(kind: "bill" | "subscription", name: string, nativeAmount: number, anchorDate: string) {
    const result = await createRecurringBill(owner.id, { kind, name, nativeAmount, currency: "ILS", cadence: "monthly", anchorDate: day(anchorDate), categoryId: null });
    if (!result.ok) throw new Error("setup failed");
    return result.bill;
  }

  async function charge(name: string, iso: string, amountAgorot: bigint) {
    return admin.notableTransaction.create({
      data: { userId: owner.id, bankAccountId: accountId, categoryId, occurredAt: at(iso), currency: "ILS", nativeAmount: amountAgorot, amount: amountAgorot, description: name, merchantName: name },
    });
  }

  const entries = (calendar: Awaited<ReturnType<typeof buildRecurringCalendar>>) => calendar.days.flatMap((d) => d.entries.map((e) => ({ date: d.date, name: e.name, state: e.state })));

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    owner = await admin.user.create({ data: { email: `calendar-owner-${stamp}@pfw.local`, displayName: "Calendar Owner" } });
    stranger = await admin.user.create({ data: { email: `calendar-stranger-${stamp}@pfw.local`, displayName: "Calendar Stranger" } });
    categoryId = (await admin.category.create({ data: { userId: owner.id, slug: "subscriptions", name: "Subscriptions" } })).id;
    accountId = (
      await admin.bankAccount.create({
        data: { userId: owner.id, institutionName: "Test Bank", last4: "1111", accountType: "CHECKING", nativeBalance: 1_000_000n, balanceAsOf: day("2026-10-01") },
      })
    ).id;
  });

  afterEach(async () => {
    await admin.recurringBill.deleteMany({ where: { userId: owner.id } });
    await admin.subscriptionTracking.deleteMany({ where: { userId: owner.id } });
    await admin.notableTransaction.deleteMany({ where: { userId: owner.id } });
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [owner.id, stranger.id]);
  });

  it("each page draws only its own items", async () => {
    await addBill("bill", "Electricity Company", 30_000, "2026-07-25");
    await addBill("subscription", "Fitness Club", 20_000, "2026-07-12");

    const bills = entries(await buildRecurringCalendar(owner.id, "bill", "2026-10", asOf));
    const subscriptions = entries(await buildRecurringCalendar(owner.id, "subscription", "2026-10", asOf));

    expect(bills).toEqual([{ date: "2026-10-25", name: "Electricity Company", state: "due" }]);
    expect(subscriptions).toEqual([{ date: "2026-10-12", name: "Fitness Club", state: "not-charged" }]);
  });

  it("a charge that happened shows as paid on its own day, and replaces the expected one", async () => {
    await addBill("bill", "Electricity Company", 30_000, "2026-07-25");
    await charge("ELECTRICITY COMPANY", "2026-10-05", -30_000n);

    expect(entries(await buildRecurringCalendar(owner.id, "bill", "2026-10", asOf))).toEqual([
      { date: "2026-10-05", name: "ELECTRICITY COMPANY", state: "paid" },
    ]);
  });

  it("a subscription found in the statements is drawn on the Subscriptions page, projected forward, and not on the Bills page", async () => {
    await charge("Streamflix", "2026-07-20", -3_990n);
    await charge("Streamflix", "2026-08-20", -3_990n);
    await charge("Streamflix", "2026-09-20", -3_990n);

    expect(entries(await buildRecurringCalendar(owner.id, "subscription", "2026-10", asOf))).toEqual([{ date: "2026-10-20", name: "Streamflix", state: "due" }]);
    expect(entries(await buildRecurringCalendar(owner.id, "subscription", "2026-11", asOf))).toEqual([{ date: "2026-11-20", name: "Streamflix", state: "due" }]);
    // September's charge really happened: shown as paid, not projected.
    expect(entries(await buildRecurringCalendar(owner.id, "subscription", "2026-09", asOf))).toEqual([{ date: "2026-09-20", name: "Streamflix", state: "paid" }]);
    expect(entries(await buildRecurringCalendar(owner.id, "bill", "2026-10", asOf))).toEqual([]);
  });

  it("another user's items and charges never appear", async () => {
    await addBill("bill", "Electricity Company", 30_000, "2026-07-25");
    await charge("Streamflix", "2026-10-02", -3_990n);
    const calendar = await buildRecurringCalendar(stranger.id, "bill", "2026-10", asOf);
    expect(entries(calendar)).toEqual([]);
    expect(entries(await buildRecurringCalendar(stranger.id, "subscription", "2026-10", asOf))).toEqual([]);
  });

  it("a month asked for in the address is used only when it is a real month", () => {
    expect(resolveCalendarMonth("2026-12", asOf)).toBe("2026-12");
    expect(resolveCalendarMonth("2026-13", asOf)).toBe("2026-10");
    expect(resolveCalendarMonth("garbage", asOf)).toBe("2026-10");
    expect(resolveCalendarMonth(undefined, asOf)).toBe("2026-10");
    expect(resolveCalendarMonth("2026-1; DROP TABLE", asOf)).toBe("2026-10");
  });
});
