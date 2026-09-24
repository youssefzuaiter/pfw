import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { createTransactionRule } from "../../src/server/dal/transaction-rules";
import { applyRulesToExistingTransactions } from "../../src/server/dal/transactions";
import { getLedgerHistory } from "../../src/server/dal/ledger-commits";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * `applyRulesToExistingTransactions` against real Postgres — the piece
 * that makes writing a rule actually useful once transactions already
 * exist. Rules otherwise only fire at import/manual-entry/sync, so a
 * rule written today did nothing for what was already stored — a real
 * first import left 209 of 211 rows in Uncategorized with no remedy but
 * 209 dropdowns.
 *
 * Rows are created directly via the admin client
 * (`admin.notableTransaction.create`), bypassing the DAL entirely, the
 * same convention `transfers-and-soft-delete.test.ts` uses — this is
 * what lets a test set up a row in a specific PRE-EXISTING state (e.g.
 * "categorized Uncategorized, needsReview true") without the Tier 0
 * cascade already having touched it at creation time, which is exactly
 * the situation this function exists to fix.
 */
const hasDb = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);

describe.skipIf(!hasDb)("applyRulesToExistingTransactions", () => {
  const admin = createAdminClient();
  const email = `apply-rules-existing-${Date.now()}@example.com`;
  let userId = "";
  let otherUserId = "";
  let bankAccountId = "";
  let uncategorizedId = "";
  let diningId = "";

  async function addRow(opts: {
    description: string;
    merchantName?: string | null;
    amount: bigint;
    categoryId: string;
    needsReview?: boolean;
    isTransfer?: boolean;
  }) {
    return admin.notableTransaction.create({
      data: {
        user: { connect: { id: userId } },
        bankAccount: { connect: { id: bankAccountId } },
        category: { connect: { id: opts.categoryId } },
        occurredAt: new Date("2026-09-10T00:00:00.000Z"),
        amount: opts.amount,
        nativeAmount: opts.amount,
        currency: "ILS",
        description: opts.description,
        merchantName: opts.merchantName ?? null,
        needsReview: opts.needsReview ?? false,
        isTransfer: opts.isTransfer ?? false,
      },
      select: { id: true, categoryId: true, merchantName: true, needsReview: true, isTransfer: true },
    });
  }

  beforeAll(async () => {
    const user = await admin.user.create({
      data: { email, displayName: "Apply Rules Existing Test" },
    });
    userId = user.id;
    const other = await admin.user.create({
      data: { email: `apply-rules-existing-other-${Date.now()}@example.com`, displayName: "Other" },
    });
    otherUserId = other.id;

    const account = await admin.bankAccount.create({
      data: { userId, institutionName: "Test Bank", last4: "4321", accountType: "CHECKING", nativeBalance: 10_000n },
    });
    bankAccountId = account.id;

    const uncategorized = await admin.category.create({
      data: { userId, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    uncategorizedId = uncategorized.id;
    const dining = await admin.category.create({ data: { userId, slug: "dining", name: "Dining" } });
    diningId = dining.id;
    await admin.category.create({ data: { userId, slug: "entertainment", name: "Entertainment" } });

    // A category + account for the OTHER user, so the IDOR test has
    // something real to prove the rule never reaches.
    const otherAccount = await admin.bankAccount.create({
      data: { userId: otherUserId, institutionName: "Other Bank", last4: "9999", accountType: "CHECKING", nativeBalance: 5_000n },
    });
    const otherUncategorized = await admin.category.create({
      data: { userId: otherUserId, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    await admin.notableTransaction.create({
      data: {
        user: { connect: { id: otherUserId } },
        bankAccount: { connect: { id: otherAccount.id } },
        category: { connect: { id: otherUncategorized.id } },
        occurredAt: new Date("2026-09-10T00:00:00.000Z"),
        amount: -1000n,
        nativeAmount: -1000n,
        currency: "ILS",
        description: "Cafe Aroma",
        merchantName: "Cafe Aroma",
        needsReview: true,
      },
    });
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [userId, otherUserId]);
    await admin.$disconnect();
  });

  it("returns the zero-value result immediately when the user has no rules", async () => {
    const result = await applyRulesToExistingTransactions(userId, { dryRun: true });
    expect(result).toEqual({ totalChanges: 0, changes: [], alreadyCorrect: 0, protectedByManualChoice: 0, updatedCount: 0 });
  });

  it("dryRun writes nothing — the row stays exactly as it was", async () => {
    const rule = await createTransactionRule(userId, {
      name: "Cafe -> Dining (dry run)",
      priority: 0,
      isActive: true,
      conditions: [{ field: "merchantName", operator: "contains", value: "Cafe" }],
      actions: [{ type: "categorize", categorySlug: "dining" }],
    });
    const row = await addRow({
      description: "Cafe Aroma",
      merchantName: "Cafe Aroma",
      amount: -1200n,
      categoryId: uncategorizedId,
      needsReview: true,
    });

    const result = await applyRulesToExistingTransactions(userId, { dryRun: true });

    expect(result.updatedCount).toBe(0);
    expect(result.totalChanges).toBe(1);
    expect(result.changes[0]).toMatchObject({
      transactionId: row.id,
      categoryFrom: "Uncategorized",
      categoryTo: "Dining",
    });

    const stillStored = await admin.notableTransaction.findUniqueOrThrow({ where: { id: row.id } });
    expect(stillStored.categoryId).toBe(uncategorizedId);
    expect(stillStored.needsReview).toBe(true);

    await admin.notableTransaction.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    await admin.transactionRule.delete({ where: { id: rule.id } });
  });

  it("a real run categorizes an Uncategorized row, clears needsReview, and appends a ledger commit", async () => {
    const rule = await createTransactionRule(userId, {
      name: "Cafe -> Dining (real)",
      priority: 0,
      isActive: true,
      conditions: [{ field: "merchantName", operator: "contains", value: "Cafe" }],
      actions: [{ type: "categorize", categorySlug: "dining" }],
    });
    const row = await addRow({
      description: "Cafe Aroma",
      merchantName: "Cafe Aroma",
      amount: -1200n,
      categoryId: uncategorizedId,
      needsReview: true,
    });

    const result = await applyRulesToExistingTransactions(userId, { dryRun: false });

    expect(result.updatedCount).toBe(1);
    expect(result.totalChanges).toBe(1);

    const stored = await admin.notableTransaction.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.categoryId).toBe(diningId);
    expect(stored.needsReview).toBe(false);

    const history = await getLedgerHistory(userId, row.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.action).toBe("UPDATE");

    await admin.notableTransaction.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    await admin.transactionRule.delete({ where: { id: rule.id } });
  });

  it("leaves a hand-categorized row's CATEGORY alone, but a rename/transfer on it still applies", async () => {
    const rule = await createTransactionRule(userId, {
      name: "Cafe -> Entertainment + rename + transfer (protection test)",
      priority: 0,
      isActive: true,
      conditions: [{ field: "merchantName", operator: "contains", value: "Cafe" }],
      actions: [
        { type: "categorize", categorySlug: "entertainment" },
        { type: "rename", value: "Cafe Aroma (cleaned)" },
        { type: "transfer", value: true },
      ],
    });
    // needsReview: false + a real (non-uncategorized) category is this
    // app's proxy for "a human picked this" (§3j) — the row must have
    // been categorized BY A PERSON, not left over from the cascade.
    const row = await addRow({
      description: "Cafe Aroma",
      merchantName: "Cafe Aroma",
      amount: -1200n,
      categoryId: diningId,
      needsReview: false,
    });

    const result = await applyRulesToExistingTransactions(userId, { dryRun: false });

    expect(result.protectedByManualChoice).toBe(1);
    expect(result.updatedCount).toBe(1);

    const stored = await admin.notableTransaction.findUniqueOrThrow({ where: { id: row.id } });
    // Category untouched — the human's choice wins.
    expect(stored.categoryId).toBe(diningId);
    // Rename and transfer are orthogonal to the category decision and
    // still apply.
    expect(stored.merchantName).toBe("Cafe Aroma (cleaned)");
    expect(stored.isTransfer).toBe(true);

    await admin.notableTransaction.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    await admin.transactionRule.delete({ where: { id: rule.id } });
  });

  it("counts a matched rule that would set nothing new as alreadyCorrect, and writes nothing", async () => {
    const rule = await createTransactionRule(userId, {
      name: "Cafe -> Dining (no-op)",
      priority: 0,
      isActive: true,
      conditions: [{ field: "merchantName", operator: "contains", value: "Cafe" }],
      actions: [{ type: "categorize", categorySlug: "dining" }],
    });
    // Already exactly what the rule would set.
    const row = await addRow({
      description: "Cafe Aroma",
      merchantName: "Cafe Aroma",
      amount: -1200n,
      categoryId: diningId,
      needsReview: false,
    });

    const result = await applyRulesToExistingTransactions(userId, { dryRun: false });

    expect(result.alreadyCorrect).toBe(1);
    expect(result.totalChanges).toBe(0);
    expect(result.updatedCount).toBe(0);
    expect(await getLedgerHistory(userId, row.id)).toHaveLength(0);

    await admin.notableTransaction.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    await admin.transactionRule.delete({ where: { id: rule.id } });
  });

  it("a non-matching row is untouched and never counted", async () => {
    const rule = await createTransactionRule(userId, {
      name: "Streamflix only (no match)",
      priority: 0,
      isActive: true,
      conditions: [{ field: "merchantName", operator: "equals", value: "Streamflix" }],
      actions: [{ type: "categorize", categorySlug: "entertainment" }],
    });
    const row = await addRow({
      description: "Unrelated grocery run",
      merchantName: "Some Random Grocer",
      amount: -3000n,
      categoryId: uncategorizedId,
      needsReview: true,
    });

    const result = await applyRulesToExistingTransactions(userId, { dryRun: false });

    expect(result.totalChanges).toBe(0);
    expect(result.updatedCount).toBe(0);
    expect(result.alreadyCorrect).toBe(0);
    expect(result.protectedByManualChoice).toBe(0);

    const stored = await admin.notableTransaction.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.categoryId).toBe(uncategorizedId);

    await admin.notableTransaction.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    await admin.transactionRule.delete({ where: { id: rule.id } });
  });

  it("only touches the calling user's own rows — never another user's, even with an identical rule and merchant", async () => {
    const rule = await createTransactionRule(userId, {
      name: "Cafe -> Dining (IDOR check)",
      priority: 0,
      isActive: true,
      conditions: [{ field: "merchantName", operator: "contains", value: "Cafe" }],
      actions: [{ type: "categorize", categorySlug: "dining" }],
    });

    const otherBefore = await admin.notableTransaction.findFirstOrThrow({
      where: { userId: otherUserId, merchantName: "Cafe Aroma" },
    });
    expect(otherBefore.categoryId).not.toBe(diningId);

    await applyRulesToExistingTransactions(userId, { dryRun: false });

    const otherAfter = await admin.notableTransaction.findUniqueOrThrow({ where: { id: otherBefore.id } });
    expect(otherAfter.categoryId).toBe(otherBefore.categoryId);

    await admin.transactionRule.delete({ where: { id: rule.id } });
  });
});
