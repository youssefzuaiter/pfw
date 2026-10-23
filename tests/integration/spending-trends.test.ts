import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { setTransactionSplits } from "../../src/server/dal/transaction-splits";
import { createTransaction } from "../../src/server/dal/transactions";
import { buildSpendingTrendsView } from "../../src/server/reports/build-spending-trends";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * The spending-trends figures (AGENTS.md §3iiii) against real Postgres: a
 * category's spending this month so far against the same days of the earlier
 * months, with a split counted in each of its categories, transfers and
 * deleted rows left out, and another user's spending never shown.
 *
 * Dates are fixed (12 October 2026) so the result does not depend on when the
 * suite runs.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("spending trends", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let user: { id: string };
  let stranger: { id: string };
  let account: { id: string };
  let strangerAccount: { id: string };
  let dining: { id: string };
  let fuel: { id: string };
  let groceries: { id: string };

  const asOf = new Date("2026-10-12T09:00:00Z");
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

  async function spend(description: string, iso: string, agorot: bigint, categoryId: string) {
    const created = await createTransaction(user.id, { bankAccountId: account.id, amountAgorot: -agorot, occurredAt: at(iso), description, merchantName: description });
    await admin.notableTransaction.update({ where: { id: created.id }, data: { categoryId, needsReview: false } });
    return created;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    user = await admin.user.create({ data: { email: `trends-${stamp}@pfw.local`, displayName: "Trends" } });
    stranger = await admin.user.create({ data: { email: `trends-other-${stamp}@pfw.local`, displayName: "Other" } });
    account = await admin.bankAccount.create({ data: { userId: user.id, institutionName: "Leumi", last4: "1111", accountType: "CHECKING", currency: "ILS", nativeBalance: 5_000_000n } });
    strangerAccount = await admin.bankAccount.create({ data: { userId: stranger.id, institutionName: "Other", last4: "2222", accountType: "CHECKING", currency: "ILS", nativeBalance: 5_000_000n } });
    await admin.category.create({ data: { userId: user.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true } });
    dining = await admin.category.create({ data: { userId: user.id, slug: "dining", name: "Dining" } });
    fuel = await admin.category.create({ data: { userId: user.id, slug: "fuel", name: "Fuel" } });
    groceries = await admin.category.create({ data: { userId: user.id, slug: "groceries", name: "Groceries" } });
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [user.id, stranger.id]);
    await admin.$disconnect();
  });

  it("compares this month so far with the same days of the months before, by category", async () => {
    // Dining: 300.00 by the 12th this month; 200.00 by the 12th in each of the 3 months before, plus more later in those months.
    await spend("Dinner Oct", "2026-10-05", 30_000n, dining.id);
    for (const month of ["2026-09", "2026-08", "2026-07"]) {
      await spend(`Dinner ${month}`, `${month}-05`, 20_000n, dining.id);
      await spend(`Late dinner ${month}`, `${month}-25`, 80_000n, dining.id);
    }
    // Fuel: 50.00 this month, 100.00 in each earlier month by the 12th.
    await spend("Fuel Oct", "2026-10-03", 5_000n, fuel.id);
    for (const month of ["2026-09", "2026-08", "2026-07"]) await spend(`Fuel ${month}`, `${month}-03`, 10_000n, fuel.id);

    const view = await buildSpendingTrendsView(user.id, asOf);
    const row = (name: string) => view.categories.find((c) => c.name === name)!;

    expect(view).toMatchObject({ monthKey: "2026-10", dayOfMonth: 12, baselineMonthsUsed: 3 });
    expect(row("Dining")).toMatchObject({ thisMonth: 30_000, usualByNow: 20_000, difference: 10_000, differenceBps: 5_000, lastMonth: 100_000 });
    expect(row("Dining").thisMonthText).toContain("300.00");
    expect(row("Dining").usualByNowText).toContain("200.00");
    expect(row("Fuel")).toMatchObject({ thisMonth: 5_000, usualByNow: 10_000, difference: -5_000, differenceBps: -5_000 });
    expect(view.biggestRises.map((c) => c.name)).toEqual(["Dining"]);
    expect(view.biggestFalls.map((c) => c.name)).toEqual(["Fuel"]);
    expect(view.thisMonth).toBe(35_000);
    expect(view.categories.reduce((sum, c) => sum + c.thisMonth, 0)).toBe(view.thisMonth);
  });

  it("counts a split transaction in each of its categories, and leaves out transfers and deleted rows", async () => {
    // A hard delete is refused once a row has ledger commits, so the earlier case's rows are soft-deleted, as the app does.
    // (updateMany is not available on an encrypted model, so one by one.)
    for (const { id } of await admin.notableTransaction.findMany({ where: { userId: user.id }, select: { id: true } })) {
      await admin.notableTransaction.update({ where: { id }, data: { deletedAt: new Date() } });
    }
    const split = await spend("Big shop", "2026-10-04", 20_000n, groceries.id);
    const result = await setTransactionSplits(user.id, split.id, [
      { categoryId: groceries.id, nativeAmount: 12_000n },
      { categoryId: dining.id, nativeAmount: 8_000n },
    ]);
    expect(result.ok).toBe(true);
    const transfer = await spend("Own account", "2026-10-06", 99_000n, fuel.id);
    await admin.notableTransaction.update({ where: { id: transfer.id }, data: { isTransfer: true } });
    const deleted = await spend("Mistake", "2026-10-07", 77_000n, fuel.id);
    await admin.notableTransaction.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

    const view = await buildSpendingTrendsView(user.id, asOf);
    const names = view.categories.map((c) => c.name).sort();
    expect(names).toEqual(["Dining", "Groceries"]);
    expect(view.categories.find((c) => c.name === "Groceries")?.thisMonth).toBe(12_000);
    expect(view.categories.find((c) => c.name === "Dining")?.thisMonth).toBe(8_000);
    expect(view.thisMonth).toBe(20_000);
    // Nothing earlier to compare with: no percentage, not a made-up one.
    expect(view.baselineMonthsUsed).toBe(0);
    expect(view.categories.every((c) => c.differenceBps === null)).toBe(true);
  });

  it("never shows another user's spending, and never leaks yours to them", async () => {
    const theirCategory = await admin.category.create({ data: { userId: stranger.id, slug: "their-dining", name: "Their Dining" } });
    await admin.notableTransaction.create({
      data: { userId: stranger.id, bankAccountId: strangerAccount.id, categoryId: theirCategory.id, occurredAt: at("2026-10-03"), currency: "ILS", nativeAmount: -55_000n, amount: -55_000n, description: "Theirs", merchantName: "Theirs" },
    });

    const theirs = await buildSpendingTrendsView(stranger.id, asOf);
    expect(theirs.categories.map((c) => c.name)).toEqual(["Their Dining"]);
    expect(theirs.thisMonth).toBe(55_000);

    const mine = await buildSpendingTrendsView(user.id, asOf);
    expect(mine.categories.map((c) => c.name)).not.toContain("Their Dining");
    expect(mine.thisMonth).toBe(20_000);
  });
});
