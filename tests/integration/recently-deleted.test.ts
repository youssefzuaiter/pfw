import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { verifyLedgerChain } from "../../src/server/dal/ledger-commits";
import {
  listDeletedTransactions,
  listTransactions,
  restoreImportBatch,
  softDeleteImportBatch,
  softDeleteTransaction,
} from "../../src/server/dal/transactions";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * The Recently deleted screen's data layer, against real Postgres.
 *
 * Soft delete existed (AGENTS.md §3ccc) but its only way back was a button
 * shown in the row right after deleting it. These pin the list that
 * replaces that, and restoring a whole deleted import in one go.
 */
const hasDb = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);

describe.skipIf(!hasDb)("recently deleted", () => {
  const admin = createAdminClient();
  const stamp = Date.now();
  let userId = "";
  let otherUserId = "";
  let bankAccountId = "";
  let otherBankAccountId = "";
  let categoryId = "";
  let otherCategoryId = "";

  async function addRow(opts: {
    description: string;
    amount?: bigint;
    providerTransactionId?: string;
    importBatchId?: string;
    forUser?: "me" | "other";
  }) {
    const mine = (opts.forUser ?? "me") === "me";
    const amount = opts.amount ?? -10_00n;
    return admin.notableTransaction.create({
      data: {
        user: { connect: { id: mine ? userId : otherUserId } },
        bankAccount: { connect: { id: mine ? bankAccountId : otherBankAccountId } },
        category: { connect: { id: mine ? categoryId : otherCategoryId } },
        occurredAt: new Date("2026-08-10T00:00:00.000Z"),
        amount,
        nativeAmount: amount,
        currency: "ILS",
        description: opts.description,
        providerTransactionId: opts.providerTransactionId,
        importBatchId: opts.importBatchId,
      },
      select: { id: true },
    });
  }

  beforeAll(async () => {
    const user = await admin.user.create({ data: { email: `recently-deleted-${stamp}@example.com`, displayName: "Me" } });
    userId = user.id;
    const other = await admin.user.create({ data: { email: `recently-deleted-other-${stamp}@example.com`, displayName: "Other" } });
    otherUserId = other.id;
    const account = await admin.bankAccount.create({
      data: { userId, institutionName: "QNB", nickname: "Main", last4: "7669", accountType: "CHECKING", currency: "ILS", nativeBalance: 0n },
    });
    bankAccountId = account.id;
    const otherAccount = await admin.bankAccount.create({
      data: { userId: otherUserId, institutionName: "Elsewhere", last4: "1111", accountType: "CHECKING", currency: "ILS", nativeBalance: 0n },
    });
    otherBankAccountId = otherAccount.id;
    const category = await admin.category.create({
      data: { userId, name: "Uncategorized", slug: `uncat-${stamp}`, isUncategorized: true },
    });
    categoryId = category.id;
    const otherCategory = await admin.category.create({
      data: { userId: otherUserId, name: "Uncategorized", slug: `uncat-other-${stamp}`, isUncategorized: true },
    });
    otherCategoryId = otherCategory.id;
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [userId, otherUserId]);
    await admin.$disconnect();
  });

  it("lists only deleted rows, most recently deleted first, with the readable fields", async () => {
    const live = await addRow({ description: "Still here" });
    const first = await addRow({ description: "Deleted first" });
    const second = await addRow({ description: "Deleted second" });
    await softDeleteTransaction(userId, first.id);
    // Distinct deletion times, whatever the clock resolution.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await softDeleteTransaction(userId, second.id);

    const { rows, truncated } = await listDeletedTransactions(userId);
    const ids = rows.map((row) => row.id);

    expect(ids).not.toContain(live.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(truncated).toBe(false);

    const row = rows.find((candidate) => candidate.id === first.id);
    // description is encrypted at rest; it must come back readable.
    expect(row?.description).toBe("Deleted first");
    expect(row?.category.name).toBe("Uncategorized");
    expect(row?.bankAccount).toEqual({ nickname: "Main", institutionName: "QNB" });
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it("never lists another user's deleted rows", async () => {
    const theirs = await addRow({ description: "Their private row", forUser: "other" });
    await admin.notableTransaction.update({ where: { id: theirs.id }, data: { deletedAt: new Date() } });

    const { rows } = await listDeletedTransactions(userId);
    expect(rows.map((row) => row.id)).not.toContain(theirs.id);
  });

  it("counts every deleted row of an import, and nothing else, in its batch total", async () => {
    const batch = `rd-count-${stamp}`;
    const rows = [];
    for (let n = 0; n < 4; n += 1) rows.push(await addRow({ description: `Import row ${n}`, importBatchId: batch }));
    await addRow({ description: "Same import, still live", importBatchId: batch });
    await addRow({ description: "No import at all" });
    await softDeleteTransaction(userId, rows[0].id);
    await softDeleteTransaction(userId, rows[1].id);
    await softDeleteTransaction(userId, rows[2].id);

    const { batches } = await listDeletedTransactions(userId);
    expect(batches.find((candidate) => candidate.importBatchId === batch)?.count).toBe(3);
    // A deleted row with no import never forms a batch of its own.
    expect(batches.every((candidate) => candidate.importBatchId.length > 0)).toBe(true);
  });

  it("restores every deleted row of an import, leaving live ones alone and the chain valid", async () => {
    const batch = `rd-restore-${stamp}`;
    const ids: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      const key = `csv:rd:${stamp}:${n}`;
      ids.push((await addRow({ description: `Restore me ${n}`, importBatchId: batch, providerTransactionId: key })).id);
    }
    const stillLive = await addRow({ description: "Never deleted", importBatchId: batch });

    await softDeleteImportBatch(userId, batch);
    expect(await admin.notableTransaction.count({ where: { userId, importBatchId: batch, deletedAt: null } })).toBe(0);
    // Put one row back by hand, so the batch holds a live row that must be left alone.
    await admin.notableTransaction.update({ where: { id: stillLive.id }, data: { deletedAt: null } });

    const result = await restoreImportBatch(userId, batch);
    expect(result).toEqual({ ok: true, deletedCount: 5 });

    const restored = await admin.notableTransaction.findMany({ where: { id: { in: ids } } });
    expect(restored.every((row) => row.deletedAt === null)).toBe(true);
    // The dedupe keys the delete released are back, so a re-import still finds duplicates.
    expect(restored.map((row) => row.providerTransactionId).sort()).toEqual(
      ids.map((_, n) => `csv:rd:${stamp}:${n}`).sort(),
    );
    expect((await listTransactions(userId, {})).map((row) => row.id)).toEqual(expect.arrayContaining(ids));

    for (const id of ids) {
      const actions = (await admin.ledgerCommit.findMany({ where: { transactionId: id }, orderBy: { createdAt: "asc" }, select: { action: true } })).map((c) => c.action);
      expect(actions).toEqual(["DELETE", "RESTORE"]);
      expect(await verifyLedgerChain(userId, id)).toEqual({ valid: true, brokenAtCommitId: null, mismatchedFields: [] });
    }
    // The row that was already live got no commit from the restore.
    expect(await admin.ledgerCommit.count({ where: { transactionId: stillLive.id, action: "RESTORE" } })).toBe(0);
  });

  it("brings a row back without its key when a live row has taken it since", async () => {
    // Delete an import, re-import the same file, then restore the old one:
    // the live copy keeps the key, the restored row must not collide with it.
    const batch = `rd-key-${stamp}`;
    const key = `csv:rd-key:${stamp}`;
    const old = await addRow({ description: "Original", importBatchId: batch, providerTransactionId: key });
    await softDeleteImportBatch(userId, batch);
    const reimported = await addRow({ description: "Re-imported", providerTransactionId: key });

    const result = await restoreImportBatch(userId, batch);
    expect(result).toEqual({ ok: true, deletedCount: 1 });

    const restored = await admin.notableTransaction.findUnique({ where: { id: old.id }, select: { deletedAt: true, providerTransactionId: true } });
    expect(restored).toEqual({ deletedAt: null, providerTransactionId: null });
    const kept = await admin.notableTransaction.findUnique({ where: { id: reimported.id }, select: { providerTransactionId: true } });
    expect(kept?.providerTransactionId).toBe(key);
  });

  it("answers not_found for a batch that does not exist, is someone else's, or has nothing deleted", async () => {
    expect(await restoreImportBatch(userId, `no-such-batch-${stamp}`)).toEqual({ ok: false, error: "not_found" });

    const theirBatch = `rd-theirs-${stamp}`;
    const theirs = await addRow({ description: "Theirs", importBatchId: theirBatch, forUser: "other" });
    await admin.notableTransaction.update({ where: { id: theirs.id }, data: { deletedAt: new Date() } });
    expect(await restoreImportBatch(userId, theirBatch)).toEqual({ ok: false, error: "not_found" });
    // ...and it really was left deleted.
    expect((await admin.notableTransaction.findUnique({ where: { id: theirs.id }, select: { deletedAt: true } }))?.deletedAt).not.toBeNull();

    const liveBatch = `rd-live-${stamp}`;
    await addRow({ description: "Live only", importBatchId: liveBatch });
    expect(await restoreImportBatch(userId, liveBatch)).toEqual({ ok: false, error: "not_found" });
  });
});
