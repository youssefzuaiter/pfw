import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { getLedgerHistory, verifyLedgerChain } from "../../src/server/dal/ledger-commits";
import { setTransactionSplits } from "../../src/server/dal/transaction-splits";
import { bulkEditTransactions, createTransaction, getSpendByCategoryInRange, MAX_BULK_TRANSACTIONS } from "../../src/server/dal/transactions";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * Bulk edit (AGENTS.md §3hhhh) against real Postgres: one edit on many
 * transactions, all or nothing, with the same ledger trail as editing them one
 * at a time, and other people's rows never touched.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("bulk edit transactions", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let user: { id: string };
  let stranger: { id: string };
  let account: { id: string };
  let strangerAccount: { id: string };
  let groceries: { id: string };
  let dining: { id: string };
  let uncategorized: { id: string };
  let strangerCategory: { id: string };

  const OCT = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
  const row = (description: string, amount = -10_000n, day = 5) =>
    createTransaction(user.id, { bankAccountId: account.id, amountAgorot: amount, occurredAt: OCT(day), description, merchantName: description });
  const stored = (id: string) => admin.notableTransaction.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    user = await admin.user.create({ data: { email: `bulk-${stamp}@pfw.local`, displayName: "Bulk" } });
    stranger = await admin.user.create({ data: { email: `bulk-other-${stamp}@pfw.local`, displayName: "Other" } });
    account = await admin.bankAccount.create({ data: { userId: user.id, institutionName: "Leumi", last4: "1111", accountType: "CHECKING", currency: "ILS", nativeBalance: 500_000n } });
    strangerAccount = await admin.bankAccount.create({ data: { userId: stranger.id, institutionName: "Other", last4: "2222", accountType: "CHECKING", currency: "ILS", nativeBalance: 500_000n } });
    uncategorized = await admin.category.create({ data: { userId: user.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true } });
    groceries = await admin.category.create({ data: { userId: user.id, slug: "groceries", name: "Groceries" } });
    dining = await admin.category.create({ data: { userId: user.id, slug: "dining", name: "Dining" } });
    strangerCategory = await admin.category.create({ data: { userId: stranger.id, slug: "groceries", name: "Groceries" } });
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [user.id, stranger.id]);
    await admin.$disconnect();
  });

  it("sets one category on many rows, clears their review flag and keeps every ledger chain valid", async () => {
    const rows = [await row("Zeta Market One"), await row("Zeta Market Two"), await row("Zeta Market Three")];
    const result = await bulkEditTransactions(user.id, rows.map((r) => r.id), { type: "category", categoryId: groceries.id });

    expect(result).toMatchObject({ ok: true, skippedSplit: 0, unchanged: 0, notFound: 0 });
    if (!result.ok) throw new Error("unreachable");
    expect(result.changedIds.sort()).toEqual(rows.map((r) => r.id).sort());
    for (const r of rows) {
      expect(await stored(r.id)).toMatchObject({ categoryId: groceries.id, needsReview: false });
      // The change is on the ledger too: a CREATE, then an UPDATE saying Groceries.
      const history = await getLedgerHistory(user.id, r.id);
      expect(history.map((commit) => commit.action)).toEqual(["CREATE", "UPDATE"]);
      expect(history[1].patchData.categoryName).toBe("Groceries");
      expect(await verifyLedgerChain(user.id, r.id)).toEqual({ valid: true, brokenAtCommitId: null, mismatchedFields: [] });
    }
    // Totals by category follow the change.
    const spend = await getSpendByCategoryInRange(user.id, OCT(1), OCT(31));
    expect(spend.find((s) => s.categoryId === groceries.id)?.totalAgorot).toBe(30_000n);
  });

  it("leaves rows already in that category alone, and skips split rows", async () => {
    const same = await row("Already There");
    await bulkEditTransactions(user.id, [same.id], { type: "category", categoryId: groceries.id });
    const split = await row("Split Receipt", -20_000n);
    const splitResult = await setTransactionSplits(user.id, split.id, [
      { categoryId: groceries.id, nativeAmount: 12_000n },
      { categoryId: dining.id, nativeAmount: 8_000n },
    ]);
    expect(splitResult.ok).toBe(true);
    const plain = await row("Plain Row");

    const result = await bulkEditTransactions(user.id, [same.id, split.id, plain.id], { type: "category", categoryId: dining.id });
    expect(result).toMatchObject({ ok: true, skippedSplit: 1, unchanged: 0, notFound: 0 });
    if (!result.ok) throw new Error("unreachable");
    expect(result.changedIds.sort()).toEqual([same.id, plain.id].sort());

    const again = await bulkEditTransactions(user.id, [plain.id], { type: "category", categoryId: dining.id });
    expect(again).toMatchObject({ ok: true, unchanged: 1, changedIds: [] });
  });

  it("marks and unmarks transfers, and a transfer drops out of spending", async () => {
    const rows = [await row("Own Account A", -5_000n), await row("Own Account B", -7_000n)];
    await bulkEditTransactions(user.id, rows.map((r) => r.id), { type: "category", categoryId: groceries.id });
    const before = (await getSpendByCategoryInRange(user.id, OCT(1), OCT(31))).find((s) => s.categoryId === groceries.id)?.totalAgorot ?? 0n;

    const marked = await bulkEditTransactions(user.id, rows.map((r) => r.id), { type: "transfer", isTransfer: true });
    expect(marked).toMatchObject({ ok: true, unchanged: 0 });
    expect(await stored(rows[0].id)).toMatchObject({ isTransfer: true });
    const after = (await getSpendByCategoryInRange(user.id, OCT(1), OCT(31))).find((s) => s.categoryId === groceries.id)?.totalAgorot ?? 0n;
    expect(before - after).toBe(12_000n);

    expect(await bulkEditTransactions(user.id, rows.map((r) => r.id), { type: "transfer", isTransfer: true })).toMatchObject({ ok: true, unchanged: 2, changedIds: [] });
    await bulkEditTransactions(user.id, rows.map((r) => r.id), { type: "transfer", isTransfer: false });
    expect(await stored(rows[0].id)).toMatchObject({ isTransfer: false });
  });

  it("deletes softly with a ledger commit each, and the same ids can be restored", async () => {
    const rows = [await row("Bulk Delete One"), await row("Bulk Delete Two")];
    const deleted = await bulkEditTransactions(user.id, rows.map((r) => r.id), { type: "delete" });
    expect(deleted).toMatchObject({ ok: true, notFound: 0 });
    if (!deleted.ok) throw new Error("unreachable");
    for (const r of rows) {
      expect((await stored(r.id)).deletedAt).not.toBeNull();
      expect((await getLedgerHistory(user.id, r.id)).map((commit) => commit.action)).toEqual(["CREATE", "DELETE"]);
      expect((await verifyLedgerChain(user.id, r.id)).valid).toBe(true);
    }
    // Deleting them again finds nothing live.
    expect(await bulkEditTransactions(user.id, rows.map((r) => r.id), { type: "delete" })).toMatchObject({ ok: true, changedIds: [], notFound: 2 });

    const restored = await bulkEditTransactions(user.id, deleted.changedIds, { type: "restore" });
    expect(restored).toMatchObject({ ok: true, notFound: 0 });
    for (const r of rows) {
      expect((await stored(r.id)).deletedAt).toBeNull();
      expect((await getLedgerHistory(user.id, r.id)).map((commit) => commit.action)).toEqual(["CREATE", "DELETE", "RESTORE"]);
      expect((await verifyLedgerChain(user.id, r.id)).valid).toBe(true);
    }
  });

  it("never touches another user's rows, and cannot use another user's category", async () => {
    const mine = await row("Mine");
    const theirs = await admin.notableTransaction.create({
      data: { userId: stranger.id, bankAccountId: strangerAccount.id, categoryId: strangerCategory.id, occurredAt: OCT(6), currency: "ILS", nativeAmount: -9_000n, amount: -9_000n, description: "Theirs", merchantName: "Theirs" },
    });

    const result = await bulkEditTransactions(user.id, [mine.id, theirs.id], { type: "delete" });
    expect(result).toMatchObject({ ok: true, notFound: 1 });
    if (!result.ok) throw new Error("unreachable");
    expect(result.changedIds).toEqual([mine.id]);
    expect((await stored(theirs.id)).deletedAt).toBeNull();

    const theirCategory = await bulkEditTransactions(user.id, [mine.id], { type: "category", categoryId: strangerCategory.id });
    expect(theirCategory).toEqual({ ok: false, error: "category_not_found" });
  });

  it("is all or nothing: a refused category changes no row", async () => {
    const rows = [await row("Atomic One"), await row("Atomic Two")];
    const result = await bulkEditTransactions(user.id, rows.map((r) => r.id), { type: "category", categoryId: strangerCategory.id });
    expect(result).toEqual({ ok: false, error: "category_not_found" });
    for (const r of rows) expect(await stored(r.id)).toMatchObject({ categoryId: uncategorized.id });
  });

  it("refuses an empty list and one over the limit", async () => {
    await expect(bulkEditTransactions(user.id, [], { type: "delete" })).rejects.toThrow(RangeError);
    const tooMany = Array.from({ length: MAX_BULK_TRANSACTIONS + 1 }, (_, i) => `id-${i}`);
    await expect(bulkEditTransactions(user.id, tooMany, { type: "delete" })).rejects.toThrow(RangeError);
    // Repeated ids count once.
    const one = await row("Repeated");
    expect(await bulkEditTransactions(user.id, [one.id, one.id, one.id], { type: "transfer", isTransfer: true })).toMatchObject({ ok: true, changedIds: [one.id] });
  });
});
