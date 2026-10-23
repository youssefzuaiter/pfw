import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { applyTransferMatches, listTransferMatches, MAX_TRANSFER_PAIRS } from "../../src/server/dal/transfer-matches";
import { getMonthlyIncomeExpenseHistory } from "../../src/server/dal/transactions";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * Finding and marking the two halves of a transfer between the user's own
 * accounts (AGENTS.md §3kkkk), against real Postgres: what is proposed and what
 * is not, that applying re-checks every pair on the server, that another user's
 * rows can never be marked, and that a marked pair leaves the income and
 * spending totals.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("transfer matches", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let owner: { id: string };
  let stranger: { id: string };
  let checking: string;
  let savings: string;
  let dollars: string;
  let categoryId: string;
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

  async function row(
    accountId: string,
    iso: string,
    agorot: bigint,
    options: { currency?: "ILS" | "USD" | "TRY"; native?: bigint; isTransfer?: boolean; deleted?: boolean; userId?: string; categoryId?: string; name?: string } = {},
  ) {
    return admin.notableTransaction.create({
      data: {
        userId: options.userId ?? owner.id,
        bankAccountId: accountId,
        categoryId: options.categoryId ?? categoryId,
        occurredAt: at(iso),
        currency: options.currency ?? "ILS",
        nativeAmount: options.native ?? agorot,
        amount: agorot,
        description: options.name ?? "row",
        merchantName: options.name ?? "row",
        isTransfer: options.isTransfer ?? false,
        deletedAt: options.deleted ? at("2026-10-14") : null,
      },
    });
  }

  const pairKey = (m: { out: { id: string }; in: { id: string } }) => `${m.out.id}|${m.in.id}`;

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    owner = await admin.user.create({ data: { email: `transfers-owner-${stamp}@pfw.local`, displayName: "Transfers Owner" } });
    stranger = await admin.user.create({ data: { email: `transfers-stranger-${stamp}@pfw.local`, displayName: "Transfers Stranger" } });
    categoryId = (await admin.category.create({ data: { userId: owner.id, slug: "misc", name: "Misc" } })).id;
    const account = async (last4: string, nickname: string, currency: "ILS" | "USD") =>
      (
        await admin.bankAccount.create({
          data: { userId: owner.id, institutionName: "Test Bank", nickname, last4, accountType: "CHECKING", currency, nativeBalance: 0n },
        })
      ).id;
    checking = await account("1111", "Checking", "ILS");
    savings = await account("2222", "Savings", "ILS");
    dollars = await account("3333", "Dollars", "USD");
  });

  afterEach(async () => {
    // Soft-delete rather than delete: a row with ledger history cannot be hard-deleted.
    await admin.notableTransaction.updateMany({ where: { userId: owner.id }, data: { deletedAt: new Date() } }).catch(async () => {
      const rows = await admin.notableTransaction.findMany({ where: { userId: owner.id, deletedAt: null }, select: { id: true } });
      for (const { id } of rows) await admin.notableTransaction.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [owner.id, stranger.id]);
  });

  it("proposes the two halves of a transfer, with the accounts' names", async () => {
    const out = await row(checking, "2026-10-03", -50_000n, { name: "Moved to savings" });
    const incoming = await row(savings, "2026-10-04", 50_000n, { name: "From checking" });
    const matches = await listTransferMatches(owner.id);
    expect(matches).toHaveLength(1);
    expect(pairKey(matches[0])).toBe(`${out.id}|${incoming.id}`);
    expect(matches[0]).toMatchObject({ dayGap: 1, crossCurrency: false, ambiguous: false });
    expect(matches[0].out.accountLabel).toBe("Checking");
    expect(matches[0].in.accountLabel).toBe("Savings");
  });

  it("leaves out rows in the same account, already marked, deleted, or of a different amount", async () => {
    await row(checking, "2026-10-03", -50_000n);
    await row(checking, "2026-10-03", 50_000n);
    await row(savings, "2026-10-03", 50_000n, { isTransfer: true });
    await row(savings, "2026-10-03", 50_000n, { deleted: true });
    await row(savings, "2026-10-03", 50_001n);
    expect(await listTransferMatches(owner.id)).toEqual([]);
  });

  it("pairs lira out with dollars in across currencies and says so", async () => {
    await row(checking, "2026-10-03", -28_000n, { currency: "TRY", native: -450_000n });
    await row(dollars, "2026-10-04", 27_500n, { currency: "USD", native: 8_700n });
    const matches = await listTransferMatches(owner.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].crossCurrency).toBe(true);
  });

  it("marks both rows of a pair, and they leave the income and spending totals", async () => {
    const out = await row(checking, "2026-10-03", -50_000n);
    const incoming = await row(savings, "2026-10-04", 50_000n);
    const range = [new Date("2026-10-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z")] as const;
    const before = await getMonthlyIncomeExpenseHistory(owner.id, ...range);
    expect(before[0]).toMatchObject({ incomeAgorot: 50_000n, expenseAgorot: 50_000n });

    const result = await applyTransferMatches(owner.id, [{ outId: out.id, inId: incoming.id }]);
    expect(result).toMatchObject({ applied: 1, skipped: 0 });
    expect(new Set(result.changedIds)).toEqual(new Set([out.id, incoming.id]));

    const rows = await admin.notableTransaction.findMany({ where: { id: { in: [out.id, incoming.id] } } });
    expect(rows.every((r) => r.isTransfer)).toBe(true);
    const after = await getMonthlyIncomeExpenseHistory(owner.id, ...range);
    expect(after.reduce((sum, month) => sum + Number(month.incomeAgorot) + Number(month.expenseAgorot), 0)).toBe(0);
    // And nothing more is proposed for them.
    expect(await listTransferMatches(owner.id)).toEqual([]);
  });

  it("applies only pairs the matcher still proposes: a made-up pair changes nothing", async () => {
    const a = await row(checking, "2026-10-03", -50_000n);
    const b = await row(savings, "2026-10-04", 70_000n);
    const result = await applyTransferMatches(owner.id, [{ outId: a.id, inId: b.id }]);
    expect(result).toMatchObject({ applied: 0, skipped: 1, changedIds: [] });
    const rows = await admin.notableTransaction.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.some((r) => r.isTransfer)).toBe(false);
  });

  it("skips a pair whose rows changed since it was shown, and the same pair sent twice", async () => {
    const out = await row(checking, "2026-10-03", -50_000n);
    const incoming = await row(savings, "2026-10-04", 50_000n);
    const twice = await applyTransferMatches(owner.id, [
      { outId: out.id, inId: incoming.id },
      { outId: out.id, inId: incoming.id },
    ]);
    expect(twice).toMatchObject({ applied: 1, skipped: 1 });

    const out2 = await row(checking, "2026-10-10", -9_000n);
    const in2 = await row(savings, "2026-10-10", 9_000n);
    await admin.notableTransaction.update({ where: { id: in2.id }, data: { deletedAt: new Date() } });
    expect(await applyTransferMatches(owner.id, [{ outId: out2.id, inId: in2.id }])).toMatchObject({ applied: 0, skipped: 1 });
  });

  it("never marks another user's rows, and shows them none of the owner's", async () => {
    const out = await row(checking, "2026-10-03", -50_000n);
    const incoming = await row(savings, "2026-10-04", 50_000n);
    expect(await listTransferMatches(stranger.id)).toEqual([]);
    expect(await applyTransferMatches(stranger.id, [{ outId: out.id, inId: incoming.id }])).toMatchObject({ applied: 0, skipped: 1, changedIds: [] });
    const rows = await admin.notableTransaction.findMany({ where: { id: { in: [out.id, incoming.id] } } });
    expect(rows.some((r) => r.isTransfer)).toBe(false);
  });

  it("leaves out a row divided across categories", async () => {
    const out = await row(checking, "2026-10-03", -50_000n);
    await row(savings, "2026-10-03", 50_000n);
    const other = await admin.category.create({ data: { userId: owner.id, slug: `other-${Date.now()}`, name: "Other" } });
    await admin.$transaction([
      admin.transactionSplit.create({ data: { userId: owner.id, transactionId: out.id, categoryId, amount: -20_000n, nativeAmount: -20_000n } }),
      admin.transactionSplit.create({ data: { userId: owner.id, transactionId: out.id, categoryId: other.id, amount: -30_000n, nativeAmount: -30_000n } }),
    ]);
    expect(await listTransferMatches(owner.id)).toEqual([]);
    await admin.transactionSplit.deleteMany({ where: { transactionId: out.id } });
  });

  it("refuses an empty or oversized request", async () => {
    await expect(applyTransferMatches(owner.id, [])).rejects.toThrow(RangeError);
    const many = Array.from({ length: MAX_TRANSFER_PAIRS + 1 }, (_, i) => ({ outId: `o${i}`, inId: `i${i}` }));
    await expect(applyTransferMatches(owner.id, many)).rejects.toThrow(RangeError);
  });
});
