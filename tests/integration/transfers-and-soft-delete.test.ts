import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import {
  getMonthlyIncomeExpenseHistory,
  getSpendByCategoryInRange,
  listTransactions,
  restoreTransaction,
  setTransactionTransfer,
  softDeleteImportBatch,
  softDeleteTransaction,
} from "../../src/server/dal/transactions";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * Transfers and soft delete, against real Postgres.
 *
 * Both exist because of one real import: a Turkish account funded by
 * converting USD carried ~100,000 TRY of the user's OWN money inbound in
 * a single month, which the app counted as income; and 211 rows had
 * landed with no way to undo them.
 */
const hasDb = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);

describe.skipIf(!hasDb)("transfers and soft delete", () => {
  const admin = createAdminClient();
  const email = `transfers-${Date.now()}@example.com`;
  let userId = "";
  let otherUserId = "";
  let bankAccountId = "";
  let categoryId = "";

  const AUG = new Date("2026-08-01T00:00:00.000Z");
  const SEP = new Date("2026-09-01T00:00:00.000Z");

  async function addRow(opts: {
    amount: bigint;
    description: string;
    isTransfer?: boolean;
    providerTransactionId?: string;
    importBatchId?: string;
  }) {
    return admin.notableTransaction.create({
      data: {
        user: { connect: { id: userId } },
        bankAccount: { connect: { id: bankAccountId } },
        category: { connect: { id: categoryId } },
        occurredAt: new Date("2026-08-10T00:00:00.000Z"),
        amount: opts.amount,
        nativeAmount: opts.amount,
        currency: "ILS",
        description: opts.description,
        isTransfer: opts.isTransfer ?? false,
        providerTransactionId: opts.providerTransactionId,
        importBatchId: opts.importBatchId,
      },
      select: { id: true },
    });
  }

  beforeAll(async () => {
    const user = await admin.user.create({ data: { email, displayName: "Transfers" } });
    userId = user.id;
    const other = await admin.user.create({ data: { email: `other-${email}`, displayName: "Other" } });
    otherUserId = other.id;
    const account = await admin.bankAccount.create({
      data: { userId, institutionName: "QNB", last4: "9669", accountType: "CHECKING", currency: "ILS", nativeBalance: 0n },
    });
    bankAccountId = account.id;
    const category = await admin.category.create({
      data: { userId, name: "Uncategorized", slug: `uncat-${Date.now()}`, isUncategorized: true },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [userId, otherUserId]);
    await admin.$disconnect();
  });

  it("leaves a transfer out of income and spending, but keeps it in the ledger", async () => {
    const income = await addRow({ amount: 100_00n, description: "Salary" });
    const conversion = await addRow({ amount: 500_00n, description: "Yatırım İşlemleri - USD alış" });
    await addRow({ amount: -40_00n, description: "Groceries" });

    const before = await getMonthlyIncomeExpenseHistory(userId, AUG, SEP);
    expect(Number(before[0].incomeAgorot)).toBe(600_00);

    await setTransactionTransfer(userId, conversion.id, true);

    const after = await getMonthlyIncomeExpenseHistory(userId, AUG, SEP);
    expect(Number(after[0].incomeAgorot)).toBe(100_00);
    // Spending is untouched — the transfer was inbound.
    expect(Number(after[0].expenseAgorot)).toBe(40_00);

    // Still visible to the user: it happened, and the balance moved.
    const listed = await listTransactions(userId, {});
    expect(listed.map((r) => r.id)).toContain(conversion.id);
    expect(listed.find((r) => r.id === income.id)).toBeTruthy();
  });

  it("leaves an OUTBOUND transfer out of spend by category", async () => {
    const outbound = await addRow({ amount: -250_00n, description: "Transfer to my own USD account" });

    const before = await getSpendByCategoryInRange(userId, AUG, SEP);
    const spentBefore = Number(before.find((c) => c.categoryId === categoryId)?.totalAgorot ?? 0);

    await setTransactionTransfer(userId, outbound.id, true);

    const after = await getSpendByCategoryInRange(userId, AUG, SEP);
    const spentAfter = Number(after.find((c) => c.categoryId === categoryId)?.totalAgorot ?? 0);

    expect(spentBefore - spentAfter).toBe(250_00);
  });

  it("hides a soft-deleted row everywhere, and restores it intact", async () => {
    const row = await addRow({ amount: -77_00n, description: "Mistake" });

    const withRow = await getMonthlyIncomeExpenseHistory(userId, AUG, SEP);
    await softDeleteTransaction(userId, row.id);
    const without = await getMonthlyIncomeExpenseHistory(userId, AUG, SEP);

    expect(Number(withRow[0].expenseAgorot) - Number(without[0].expenseAgorot)).toBe(77_00);
    expect((await listTransactions(userId, {})).map((r) => r.id)).not.toContain(row.id);

    await restoreTransaction(userId, row.id);
    expect((await listTransactions(userId, {})).map((r) => r.id)).toContain(row.id);
  });

  it("releases the dedupe key on delete and recovers it on restore", async () => {
    // Without this, undoing a bad import would leave its rows still
    // holding the keys, so re-importing the corrected file would find
    // nothing new — an undo that cannot be redone.
    const key = `csv:test:hash:${Date.now()}`;
    const row = await addRow({ amount: -10_00n, description: "Keyed", providerTransactionId: key });

    await softDeleteTransaction(userId, row.id);
    const afterDelete = await admin.notableTransaction.findUnique({
      where: { id: row.id },
      select: { providerTransactionId: true },
    });
    expect(afterDelete?.providerTransactionId).toBeNull();

    await restoreTransaction(userId, row.id);
    const afterRestore = await admin.notableTransaction.findUnique({
      where: { id: row.id },
      select: { providerTransactionId: true },
    });
    expect(afterRestore?.providerTransactionId).toBe(key);
  });

  it("undoes a whole import batch at once", async () => {
    const batch = `batch-${Date.now()}`;
    for (let n = 0; n < 5; n += 1) {
      await addRow({ amount: -5_00n, description: `Batch row ${n}`, importBatchId: batch });
    }

    const result = await softDeleteImportBatch(userId, batch);
    expect(result).toEqual({ ok: true, deletedCount: 5 });

    const remaining = await admin.notableTransaction.count({
      where: { userId, importBatchId: batch, deletedAt: null },
    });
    expect(remaining).toBe(0);
  });

  it("records the delete on the tamper-evident ledger rather than losing it", async () => {
    const row = await addRow({ amount: -3_00n, description: "Audited" });
    await softDeleteTransaction(userId, row.id);

    const commits = await admin.ledgerCommit.findMany({
      where: { transactionId: row.id },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    });
    expect(commits.map((c) => c.action)).toContain("DELETE");
  });

  it("never deletes another user's transaction", async () => {
    const row = await addRow({ amount: -1_00n, description: "Mine" });
    expect(await softDeleteTransaction(otherUserId, row.id)).toEqual({ ok: false, error: "not_found" });

    const still = await admin.notableTransaction.findUnique({
      where: { id: row.id },
      select: { deletedAt: true },
    });
    expect(still?.deletedAt).toBeNull();
  });
});
