import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { buildMonthlyReview, LARGEST_EXPENSES_SHOWN } from "../../src/server/reports/monthly-review";

/**
 * The monthly review page's data against real Postgres with RLS (AGENTS.md
 * §3ppp): every category (the email stops at five), the month before for
 * comparison, and the largest real expenses — never a transfer, a deleted
 * row or income — for this user only.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("monthly review", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    userA = await admin.user.create({ data: { email: `review-a-${stamp}@pfw.local`, displayName: "Review A" } });
    userB = await admin.user.create({ data: { email: `review-b-${stamp}@pfw.local`, displayName: "Review B" } });

    const account = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "4321", accountType: "CHECKING", nativeBalance: 0n },
    });
    const uncategorized = await admin.category.create({
      data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    const categoryIds: string[] = [];
    for (const name of ["Groceries", "Dining", "Transport", "Utilities", "Health", "Gifts"]) {
      const category = await admin.category.create({ data: { userId: userA.id, slug: name.toLowerCase(), name } });
      categoryIds.push(category.id);
    }

    async function tx(day: string, amount: bigint, categoryId: string, description: string, extra = {}) {
      await admin.notableTransaction.create({
        data: {
          userId: userA.id, bankAccountId: account.id, categoryId, occurredAt: new Date(`${day}T12:00:00Z`),
          amount, nativeAmount: amount, description, isManual: true, needsReview: false, ...extra,
        },
      });
    }
    // September: one income, six categories of spending (one more than the email lists).
    await tx("2026-09-01", 800_000n, uncategorized.id, "salary");
    const amounts = [-90_000n, -60_000n, -50_000n, -40_000n, -30_000n, -10_000n];
    for (const [index, categoryId] of categoryIds.entries()) {
      await tx(`2026-09-${String(10 + index).padStart(2, "0")}`, amounts[index], categoryId, `spend ${index}`);
    }
    await tx("2026-09-20", -999_000n, uncategorized.id, "own transfer", { isTransfer: true }); // not spending
    await tx("2026-09-21", -888_000n, categoryIds[0], "deleted", { deletedAt: new Date() }); // gone
    // August: the month before, for comparison.
    await tx("2026-08-05", 600_000n, uncategorized.id, "august salary");
    await tx("2026-08-06", -200_000n, categoryIds[0], "august groceries");
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  it("lists every category, compares with the month before, and leaves transfers and deleted rows out", async () => {
    const review = await buildMonthlyReview(userA.id, "2026-09");

    expect(review.report.incomeAgorot).toBe(800_000n);
    expect(review.report.expenseAgorot).toBe(280_000n);
    expect(review.report.topCategories.map((c) => c.name)).toEqual([
      "Groceries", "Dining", "Transport", "Utilities", "Health", "Gifts",
    ]);
    expect(review.previous).toEqual({ incomeAgorot: 600_000n, expenseAgorot: 200_000n });
  });

  it("lists the largest real expenses, biggest first, capped", async () => {
    const review = await buildMonthlyReview(userA.id, "2026-09");
    expect(review.largestExpenses).toHaveLength(LARGEST_EXPENSES_SHOWN);
    expect(review.largestExpenses.map((e) => [e.description, e.amount, e.category.name])).toEqual([
      ["spend 0", -90_000n, "Groceries"],
      ["spend 1", -60_000n, "Dining"],
      ["spend 2", -50_000n, "Transport"],
      ["spend 3", -40_000n, "Utilities"],
      ["spend 4", -30_000n, "Health"],
    ]);
  });

  it("shows another user nothing of this user's month (RLS), and an empty month as empty", async () => {
    const stranger = await buildMonthlyReview(userB.id, "2026-09");
    expect(stranger.report.incomeAgorot).toBe(0n);
    expect(stranger.report.topCategories).toEqual([]);
    expect(stranger.largestExpenses).toEqual([]);
    expect(stranger.previous).toEqual({ incomeAgorot: 0n, expenseAgorot: 0n });

    const empty = await buildMonthlyReview(userA.id, "2026-07");
    expect(empty.largestExpenses).toEqual([]);
    expect(empty.report.expenseAgorot).toBe(0n);
    expect(empty.coreBenchmark).toBeNull();
  });
});
