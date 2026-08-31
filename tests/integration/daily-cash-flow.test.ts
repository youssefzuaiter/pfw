import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { getDailyNetCashFlow } from "../../src/server/dal/transactions";

/**
 * Integration coverage for the stochastic cash-flow forecaster's data
 * source (AGENTS.md §3dd) — the one property that actually matters for
 * a day-by-day autoregressive model: the returned series is DENSE, one
 * row per calendar day with no gaps, zero-filled for a day with no
 * transactions, not merely "every day that had activity" the way
 * getMonthlyIncomeExpenseHistory's month buckets are.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("getDailyNetCashFlow", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let accountA: { id: string };
  let categoryA: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `daily-cashflow-test-a-${Date.now()}@pfw.local`, displayName: "Daily Cashflow Test A" },
    });
    userB = await admin.user.create({
      data: { email: `daily-cashflow-test-b-${Date.now()}@pfw.local`, displayName: "Daily Cashflow Test B" },
    });
    accountA = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "9001", accountType: "CHECKING", nativeBalance: 10_000n },
    });
    categoryA = await admin.category.create({ data: { userId: userA.id, slug: "misc", name: "Misc" } });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  it("returns a dense, zero-filled series with no gaps across a 10-day window", async () => {
    const from = new Date(Date.UTC(2026, 5, 1));
    const to = new Date(Date.UTC(2026, 5, 11)); // exclusive — 10 days: June 1..10

    // Only day 3 and day 7 get real transactions — every other day must
    // still appear in the result, at netAgorot: 0n.
    await admin.notableTransaction.create({
      data: {
        userId: userA.id,
        bankAccountId: accountA.id,
        categoryId: categoryA.id,
        occurredAt: new Date(Date.UTC(2026, 5, 3, 12)),
        currency: "ILS",
        amount: -5000n,
        nativeAmount: -5000n,
        description: "Day 3 expense",
      },
    });
    await admin.notableTransaction.create({
      data: {
        userId: userA.id,
        bankAccountId: accountA.id,
        categoryId: categoryA.id,
        occurredAt: new Date(Date.UTC(2026, 5, 7, 9)),
        currency: "ILS",
        amount: 20000n,
        nativeAmount: 20000n,
        description: "Day 7 income",
      },
    });

    const days = await getDailyNetCashFlow(userA.id, from, to);

    expect(days).toHaveLength(10);
    expect(days.map((d) => d.dateKey)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
      "2026-06-07",
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
    ]);
    expect(days.find((d) => d.dateKey === "2026-06-03")?.netAgorot).toBe(-5000n);
    expect(days.find((d) => d.dateKey === "2026-06-07")?.netAgorot).toBe(20000n);
    for (const d of days) {
      if (d.dateKey !== "2026-06-03" && d.dateKey !== "2026-06-07") {
        expect(d.netAgorot).toBe(0n);
      }
    }
  });

  it("sums multiple transactions on the same day into one net figure", async () => {
    const from = new Date(Date.UTC(2026, 6, 1));
    const to = new Date(Date.UTC(2026, 6, 2));

    // Two separate .create() calls, not createMany — the encrypted-fields
    // Prisma extension (AGENTS.md §3j/§3q) deliberately throws on
    // createMany, even via the admin client, since a batch write would
    // otherwise persist `description` as plaintext.
    await admin.notableTransaction.create({
      data: {
        userId: userA.id,
        bankAccountId: accountA.id,
        categoryId: categoryA.id,
        occurredAt: new Date(Date.UTC(2026, 6, 1, 8)),
        currency: "ILS",
        amount: -1000n,
        nativeAmount: -1000n,
        description: "same-day A",
      },
    });
    await admin.notableTransaction.create({
      data: {
        userId: userA.id,
        bankAccountId: accountA.id,
        categoryId: categoryA.id,
        occurredAt: new Date(Date.UTC(2026, 6, 1, 20)),
        currency: "ILS",
        amount: 4000n,
        nativeAmount: 4000n,
        description: "same-day B",
      },
    });

    const days = await getDailyNetCashFlow(userA.id, from, to);
    expect(days).toHaveLength(1);
    expect(days[0].netAgorot).toBe(3000n);
  });

  it("does not leak user A's transactions into user B's series (IDOR)", async () => {
    const from = new Date(Date.UTC(2026, 5, 1));
    const to = new Date(Date.UTC(2026, 5, 11));

    const daysForB = await getDailyNetCashFlow(userB.id, from, to);
    expect(daysForB.every((d) => d.netAgorot === 0n)).toBe(true);
  });
});
