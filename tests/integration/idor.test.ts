import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { getBankAccountById } from "../../src/server/dal/bank-accounts";
import { getDebtById } from "../../src/server/dal/debts";
import { getGoalById } from "../../src/server/dal/goals";
import { getTransactionById } from "../../src/server/dal/transactions";

/**
 * Negative IDOR/BOLA suite (Section 2.2): User B requesting User A's
 * resource must come back indistinguishable from "doesn't exist" — never
 * a 403, which would leak that the resource exists. There's no HTTP layer
 * yet (routes land in Phase 4), so this operates at the DAL boundary: the
 * DAL returning `null` is exactly what a Phase 4 route handler translates
 * into a 404. Phase 7 re-verifies this again at the full HTTP-integration
 * level once routes exist.
 *
 * Two independent layers are exercised together here, deliberately: the
 * DAL's own `where: { userId }` clause, and the RLS policies underneath
 * it (see with-user-scope.ts) — either one failing alone would still
 * leave the other to catch a cross-tenant read, which is the point.
 *
 * Skipped when APP_DATABASE_URL/DATABASE_URL aren't set (no DB available),
 * same convention as tests/integration/db.test.ts.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)(
  "negative IDOR: cross-user access returns null (-> 404, never 403)",
  () => {
    // Created in beforeAll, not here: `skipIf` only skips the resulting
    // tests, it does not prevent this describe callback itself from
    // running, so any eager side-effecting call at this level would still
    // execute (and throw on a missing env var) even on a "skipped" run.
    let admin: ReturnType<typeof createAdminClient>;

    let userA: { id: string };
    let userB: { id: string };
    let accountA: { id: string };
    let transactionA: { id: string };
    let debtA: { id: string };
    let goalA: { id: string };

    beforeAll(async () => {
      admin = createAdminClient();
      userA = await admin.user.create({
        data: { email: `idor-test-a-${Date.now()}@pfw.local`, displayName: "IDOR Test A" },
      });
      userB = await admin.user.create({
        data: { email: `idor-test-b-${Date.now()}@pfw.local`, displayName: "IDOR Test B" },
      });

      const categoryA = await admin.category.create({
        data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
      });

      accountA = await admin.bankAccount.create({
        data: {
          userId: userA.id,
          institutionName: "Test Bank",
          last4: "1234",
          accountType: "CHECKING",
          currentBalance: 10_000n,
        },
      });

      transactionA = await admin.notableTransaction.create({
        data: {
          userId: userA.id,
          bankAccountId: accountA.id,
          categoryId: categoryA.id,
          occurredAt: new Date(),
          amount: -5_000n,
          description: "Test transaction",
        },
      });

      debtA = await admin.debt.create({
        data: {
          userId: userA.id,
          name: "Test debt",
          debtType: "OTHER",
          currentBalance: 100_000n,
          aprBps: 500,
          minimumPayment: 1_000n,
        },
      });

      goalA = await admin.goal.create({
        data: { userId: userA.id, name: "Test goal", targetAmount: 50_000n },
      });
    });

    afterAll(async () => {
      await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
      await admin.$disconnect();
    });

    it("User B cannot read User A's bank account by ID", async () => {
      await expect(getBankAccountById(userB.id, accountA.id)).resolves.toBeNull();
    });

    it("User A CAN read their own bank account (positive control)", async () => {
      await expect(getBankAccountById(userA.id, accountA.id)).resolves.toMatchObject({ id: accountA.id });
    });

    it("User B cannot read User A's transaction by ID", async () => {
      await expect(getTransactionById(userB.id, transactionA.id)).resolves.toBeNull();
    });

    it("User A CAN read their own transaction (positive control)", async () => {
      await expect(getTransactionById(userA.id, transactionA.id)).resolves.toMatchObject({ id: transactionA.id });
    });

    it("User B cannot read User A's debt by ID", async () => {
      await expect(getDebtById(userB.id, debtA.id)).resolves.toBeNull();
    });

    it("User A CAN read their own debt (positive control)", async () => {
      await expect(getDebtById(userA.id, debtA.id)).resolves.toMatchObject({ id: debtA.id });
    });

    it("User B cannot read User A's goal by ID", async () => {
      await expect(getGoalById(userB.id, goalA.id)).resolves.toBeNull();
    });

    it("User A CAN read their own goal (positive control)", async () => {
      await expect(getGoalById(userA.id, goalA.id)).resolves.toMatchObject({ id: goalA.id });
    });

    it("a nonexistent ID under the correct user is also null (not a crash)", async () => {
      await expect(getBankAccountById(userA.id, "does-not-exist")).resolves.toBeNull();
    });
  },
);
