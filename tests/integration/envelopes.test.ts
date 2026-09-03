import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agorot } from "../../src/lib/money";
import { createAdminClient } from "../../src/server/db/admin-client";
import { allocateToEnvelope, getAvailableToBudget, getEnvelopeBalances } from "../../src/server/dal/envelopes";

/**
 * Integration coverage for the envelope-budgeting DAL's real SQL
 * aggregation — the pure rolling-balance MATH is already thoroughly
 * unit-tested (src/lib/envelope-math.test.ts); what this suite proves is
 * that the DAL fetches and buckets real Postgres rows correctly (income
 * cumulative-to-month, allocations cumulative-to-month, expenses bucketed
 * by month), that `withUserScope`/RLS actually scope every query, and
 * that `allocateToEnvelope`'s create-vs-update and sharedGroupId-
 * inheritance behavior are real, not just intended.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("envelopes DAL", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let accountA: { id: string };
  let groceriesA: { id: string };
  let diningA: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({ data: { email: `envelopes-test-a-${Date.now()}@pfw.local`, displayName: "Envelopes Test A" } });
    userB = await admin.user.create({ data: { email: `envelopes-test-b-${Date.now()}@pfw.local`, displayName: "Envelopes Test B" } });

    accountA = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "1234", accountType: "CHECKING", nativeBalance: 0n },
    });
    groceriesA = await admin.category.create({ data: { userId: userA.id, slug: "groceries", name: "Groceries" } });
    diningA = await admin.category.create({ data: { userId: userA.id, slug: "dining", name: "Dining" } });
    await admin.category.create({ data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true } });

    // Income: ₪10,000 in January, ₪5,000 in February.
    await admin.notableTransaction.create({
      data: {
        userId: userA.id, bankAccountId: accountA.id, categoryId: groceriesA.id,
        occurredAt: new Date("2026-01-05T00:00:00.000Z"), amount: 1_000_000n, nativeAmount: 1_000_000n,
        description: "Salary", isManual: true,
      },
    });
    await admin.notableTransaction.create({
      data: {
        userId: userA.id, bankAccountId: accountA.id, categoryId: groceriesA.id,
        occurredAt: new Date("2026-02-05T00:00:00.000Z"), amount: 500_000n, nativeAmount: 500_000n,
        description: "Salary", isManual: true,
      },
    });

    // Groceries: allocate ₪2,000 in January, spend ₪800.
    await admin.envelopeAllocation.create({
      data: { userId: userA.id, categoryId: groceriesA.id, amountAgorot: 200_000n, month: "2026-01" },
    });
    await admin.notableTransaction.create({
      data: {
        userId: userA.id, bankAccountId: accountA.id, categoryId: groceriesA.id,
        occurredAt: new Date("2026-01-10T00:00:00.000Z"), amount: -80_000n, nativeAmount: -80_000n,
        description: "Groceries run", isManual: true,
      },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  describe("getAvailableToBudget", () => {
    it("sums income up to and including the target month, minus allocations", async () => {
      // As of January: ₪10,000 income - ₪2,000 allocated = ₪8,000 available.
      expect(await getAvailableToBudget(userA.id, "2026-01")).toBe(800_000);
    });

    it("accumulates further income in a later month", async () => {
      // As of February: ₪15,000 income - ₪2,000 allocated = ₪13,000 available.
      expect(await getAvailableToBudget(userA.id, "2026-02")).toBe(1_300_000);
    });

    it("a user with no data at all gets zero, not an error", async () => {
      expect(await getAvailableToBudget(userB.id, "2026-01")).toBe(0);
    });
  });

  describe("getEnvelopeBalances", () => {
    it("computes the correct rolling balance and this-month figures for an allocated category", async () => {
      const balances = await getEnvelopeBalances(userA.id, "2026-01");
      const groceries = balances.find((b) => b.categoryId === groceriesA.id);
      expect(groceries).toBeDefined();
      expect(groceries?.allocatedThisMonthAgorot).toBe(200_000);
      expect(groceries?.spentThisMonthAgorot).toBe(80_000);
      expect(groceries?.balanceAgorot).toBe(120_000);
    });

    it("includes an active category that has never been allocated to, at zero", async () => {
      const balances = await getEnvelopeBalances(userA.id, "2026-01");
      const dining = balances.find((b) => b.categoryId === diningA.id);
      expect(dining).toEqual({
        categoryId: diningA.id,
        categoryName: "Dining",
        balanceAgorot: 0,
        allocatedThisMonthAgorot: 0,
        spentThisMonthAgorot: 0,
        sharedGroupId: null,
      });
    });

    it("excludes the permanent Uncategorized category", async () => {
      const balances = await getEnvelopeBalances(userA.id, "2026-01");
      expect(balances.some((b) => b.categoryName === "Uncategorized")).toBe(false);
    });

    it("carries the January balance forward into February with no new activity", async () => {
      const balances = await getEnvelopeBalances(userA.id, "2026-02");
      const groceries = balances.find((b) => b.categoryId === groceriesA.id);
      expect(groceries?.allocatedThisMonthAgorot).toBe(0);
      expect(groceries?.spentThisMonthAgorot).toBe(0);
      expect(groceries?.balanceAgorot).toBe(120_000);
    });

    it("cross-user IDOR: userB's query never returns userA's categories", async () => {
      const balances = await getEnvelopeBalances(userB.id, "2026-01");
      expect(balances).toEqual([]);
    });
  });

  describe("allocateToEnvelope", () => {
    it("creates a new allocation row for a not-yet-allocated month", async () => {
      const result = await allocateToEnvelope(userA.id, diningA.id, agorot(50_000), "2026-03");
      expect(result).toEqual({ ok: true, categoryId: diningA.id, month: "2026-03", amountAgorot: 50_000 });

      const balances = await getEnvelopeBalances(userA.id, "2026-03");
      expect(balances.find((b) => b.categoryId === diningA.id)?.allocatedThisMonthAgorot).toBe(50_000);
    });

    it("updates (not duplicates) an existing month's allocation", async () => {
      await allocateToEnvelope(userA.id, diningA.id, agorot(60_000), "2026-03");
      const balances = await getEnvelopeBalances(userA.id, "2026-03");
      expect(balances.find((b) => b.categoryId === diningA.id)?.allocatedThisMonthAgorot).toBe(60_000);

      const rows = await admin.envelopeAllocation.findMany({ where: { userId: userA.id, categoryId: diningA.id, month: "2026-03" } });
      expect(rows).toHaveLength(1);
    });

    it("returns category_not_found for a category owned by another user (IDOR-safe)", async () => {
      const result = await allocateToEnvelope(userB.id, groceriesA.id, agorot(10_000), "2026-01");
      expect(result).toEqual({ ok: false, error: "category_not_found" });
    });

    it("a new month's allocation inherits sharedGroupId from the category's most recent prior allocation", async () => {
      const group = await admin.sharedGroup.create({ data: { name: "Test Household", createdById: userA.id } });
      await admin.groupMember.create({ data: { sharedGroupId: group.id, userId: userA.id, role: "OWNER", permission: "WRITE" } });
      await admin.envelopeAllocation.update({
        where: { userId_categoryId_month: { userId: userA.id, categoryId: groceriesA.id, month: "2026-01" } },
        data: { sharedGroupId: group.id },
      });

      await allocateToEnvelope(userA.id, groceriesA.id, agorot(210_000), "2026-04");
      const newRow = await admin.envelopeAllocation.findUniqueOrThrow({
        where: { userId_categoryId_month: { userId: userA.id, categoryId: groceriesA.id, month: "2026-04" } },
      });
      expect(newRow.sharedGroupId).toBe(group.id);

      const balances = await getEnvelopeBalances(userA.id, "2026-04");
      expect(balances.find((b) => b.categoryId === groceriesA.id)?.sharedGroupId).toBe(group.id);
    });
  });
});
