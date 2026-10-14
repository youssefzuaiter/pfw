import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { deleteAccount } from "../../src/server/account/delete-account";
import { gatherMonthlyReport } from "../../src/server/reports/monthly-report";
import { buildMonthlyReview } from "../../src/server/reports/monthly-review";
import { buildDashboardData } from "../../src/server/dashboard/build-dashboard-data";
import { executeAdvisorTool } from "../../src/server/advisor/tools";
import { getReportingContext } from "../../src/server/reporting/reporting-context";
import { convertAgorotExact, rateMicrosFromDecimal } from "../../src/lib/fx-history";
import { formatReportingMinorUnits } from "../../src/lib/reporting-currency";

/**
 * Date-aware conversion against real Postgres and the real stored rate
 * history (AGENTS.md §3vvv). A user reporting in US dollars has
 * transactions on a Friday and the Saturday after it, on either side of
 * midnight UTC at a month's end, one recorded in dollars, a transfer and an
 * income. Every expected figure is computed here from an independent SQL
 * lookup of the rate for each day — not through the code under test — and
 * the dashboard, the review page, the email's data and the advisor must all
 * report the same totals. A shekel user over the same rows must see exactly
 * the stored agorot.
 *
 * Needs the rate history for August–September 2026 (`npm run
 * sync:rates:history`, or the nightly cron); skipped without it.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("historical exchange rates", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let usdUser = "";
  let ilsUser = "";
  let haveHistory = false;

  /** Independent oracle: the newest stored USD rate on or before a UTC day, straight from SQL. */
  async function usdMicrosOn(day: string): Promise<{ micros: number; rateDay: string }> {
    const [row] = await admin.$queryRaw<{ rate: string; day: string }[]>`
      SELECT "rate"::text AS rate, to_char("asOfDate", 'YYYY-MM-DD') AS day FROM "ExchangeRate"
      WHERE "currency" = 'USD' AND "asOfDate" <= ${day}::date ORDER BY "asOfDate" DESC LIMIT 1
    `;
    return { micros: rateMicrosFromDecimal(row.rate), rateDay: row.day };
  }

  const ROWS = [
    { key: "friday", occurredAt: "2026-08-28T12:00:00Z", amount: -30_000n, category: "groceries" },
    { key: "saturday", occurredAt: "2026-08-29T15:00:00Z", amount: -30_000n, category: "groceries" },
    { key: "lastMinuteAugust", occurredAt: "2026-08-31T23:59:59Z", amount: -10_001n, category: "dining" },
    { key: "firstMinuteSeptember", occurredAt: "2026-09-01T00:00:01Z", amount: -10_001n, category: "dining" },
    { key: "salary", occurredAt: "2026-09-02T09:00:00Z", amount: 500_000n, category: "groceries" },
  ] as const;
  // Recorded in dollars: -$10.00, frozen at ₪37.13 when it was entered.
  const DOLLAR_ROW = { occurredAt: "2026-09-03T10:00:00Z", amount: -3_713n, nativeAmount: -1_000n, category: "dining" };

  async function seedUser(label: string, currency: "USD" | "ILS"): Promise<string> {
    const user = await admin.user.create({ data: { email: `fx-${label}-${stamp}@pfw.local`, displayName: `FX ${label}` } });
    await admin.userSettings.create({ data: { userId: user.id, reportingCurrency: currency } });
    const account = await admin.bankAccount.create({
      data: { userId: user.id, institutionName: "FX Bank", last4: "4321", accountType: "CHECKING", nativeBalance: 0n },
    });
    const categoryIds: Record<string, string> = {};
    for (const slug of ["groceries", "dining"]) {
      categoryIds[slug] = (await admin.category.create({ data: { userId: user.id, slug, name: slug } })).id;
    }
    const base = { userId: user.id, bankAccountId: account.id, isManual: true, needsReview: false };
    for (const row of ROWS) {
      await admin.notableTransaction.create({
        data: { ...base, categoryId: categoryIds[row.category], occurredAt: new Date(row.occurredAt), amount: row.amount, nativeAmount: row.amount, description: row.key },
      });
    }
    await admin.notableTransaction.create({
      data: {
        ...base,
        categoryId: categoryIds[DOLLAR_ROW.category],
        occurredAt: new Date(DOLLAR_ROW.occurredAt),
        amount: DOLLAR_ROW.amount,
        nativeAmount: DOLLAR_ROW.nativeAmount,
        currency: "USD",
        exchangeRateAtEntry: "3.713000",
        description: "dollar purchase",
      },
    });
    await admin.notableTransaction.create({
      data: { ...base, categoryId: categoryIds.groceries, occurredAt: new Date("2026-08-28T13:00:00Z"), amount: -999_999n, nativeAmount: -999_999n, isTransfer: true, description: "own transfer" },
    });
    return user.id;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    const covered = await admin.exchangeRate.count({ where: { currency: "USD", asOfDate: { gte: new Date("2026-08-20"), lte: new Date("2026-09-03") } } });
    haveHistory = covered >= 8;
    usdUser = await seedUser("usd", "USD");
    ilsUser = await seedUser("ils", "ILS");
  });

  afterAll(async () => {
    for (const id of [usdUser, ilsUser]) if (id) await deleteAccount(id);
    await admin.accountDeletionRecord.deleteMany({ where: { deletedUserId: { in: [usdUser, ilsUser] } } });
    await admin.$disconnect();
  });

  async function expectedUsd(amount: bigint, occurredAt: string): Promise<number> {
    const { micros } = await usdMicrosOn(occurredAt.slice(0, 10));
    return convertAgorotExact(amount, micros);
  }

  it("has the stored rate history this test relies on", () => {
    if (!haveHistory) console.warn("historical-rates: no rate history for Aug–Sep 2026; run `npm run sync:rates:history`");
    expect(haveHistory).toBe(true);
  });

  it("gives the Saturday transaction the Friday rate (there is no weekend row)", async () => {
    expect((await usdMicrosOn("2026-08-29")).rateDay).toBe("2026-08-28");
    const august = await gatherMonthlyReport(usdUser, "2026-08", { categoryLimit: 100 });
    const groceries = august.topCategories.find((category) => category.name === "groceries")!;
    const friday = await expectedUsd(-30_000n, ROWS[0].occurredAt);
    expect(groceries.spentShown).toBe(-2 * friday);
  });

  it("puts 23:59:59 and 00:00:01 into different months, each at its own day's rate", async () => {
    const [august, september] = await Promise.all([gatherMonthlyReport(usdUser, "2026-08", { categoryLimit: 100 }), gatherMonthlyReport(usdUser, "2026-09", { categoryLimit: 100 })]);
    const expectedAugust = -(2 * (await expectedUsd(-30_000n, ROWS[0].occurredAt)) + (await expectedUsd(-10_001n, ROWS[2].occurredAt)));
    const expectedSeptemberExpense = -((await expectedUsd(-10_001n, ROWS[3].occurredAt)) + Number(DOLLAR_ROW.nativeAmount));
    expect(august.expenseShown).toBe(expectedAugust);
    expect(september.expenseShown).toBe(expectedSeptemberExpense);
    expect(september.incomeShown).toBe(await expectedUsd(500_000n, ROWS[4].occurredAt));
    // The month's categories add up to its total, to the cent.
    for (const month of [august, september]) expect(month.topCategories.reduce((sum, c) => sum + c.spentShown, 0)).toBe(month.expenseShown);
  });

  it("keeps a dollar transaction's own amount exactly, and leaves transfers out", async () => {
    const september = await gatherMonthlyReport(usdUser, "2026-09", { categoryLimit: 100 });
    const dining = september.topCategories.find((category) => category.name === "dining")!;
    expect(dining.spentShown).toBe(1_000 - (await expectedUsd(-10_001n, ROWS[3].occurredAt)));
  });

  it("reports the same totals on the dashboard, the review page and in the advisor", async () => {
    const [august, september, review, dashboard] = await Promise.all([
      gatherMonthlyReport(usdUser, "2026-08", { categoryLimit: 100 }),
      gatherMonthlyReport(usdUser, "2026-09", { categoryLimit: 100 }),
      buildMonthlyReview(usdUser, "2026-09"),
      buildDashboardData(usdUser, new Date("2026-09-20T12:00:00Z")),
    ]);
    expect(review.previous).toMatchObject({ incomeShown: august.incomeShown, expenseShown: august.expenseShown });
    expect(dashboard.incomeExpenseHistory.find((m) => m.monthKey === "2026-08")).toEqual({ monthKey: "2026-08", income: august.incomeShown, expense: august.expenseShown });
    expect(dashboard.incomeExpenseHistory.find((m) => m.monthKey === "2026-09")).toEqual({ monthKey: "2026-09", income: september.incomeShown, expense: september.expenseShown });
    const donutDining = dashboard.categorySpendBreakdown.find((c) => c.categoryName === "dining")!;
    expect(donutDining.amountReporting).toBe(september.topCategories.find((c) => c.name === "dining")!.spentShown);

    const reporting = await getReportingContext(usdUser);
    const tool = await executeAdvisorTool(usdUser, "get_spending_by_category", { daysBack: 365 });
    expect(tool.ok).toBe(true);
    const groceriesAllTime = august.topCategories.find((c) => c.name === "groceries")!.spentShown;
    expect((tool as { result: Array<{ categoryName: string; totalSpent: string }> }).result).toContainEqual({
      categoryName: "groceries",
      totalSpent: formatReportingMinorUnits(groceriesAllTime, reporting),
    });
  });

  it("shows a shekel user exactly the stored agorot", async () => {
    const [august, september] = await Promise.all([gatherMonthlyReport(ilsUser, "2026-08"), gatherMonthlyReport(ilsUser, "2026-09")]);
    expect(august.expenseShown).toBe(Number(august.expenseAgorot));
    expect(august.expenseShown).toBe(30_000 + 30_000 + 10_001);
    expect(september.expenseShown).toBe(Number(september.expenseAgorot));
    expect(september.incomeShown).toBe(500_000);
  });
});
