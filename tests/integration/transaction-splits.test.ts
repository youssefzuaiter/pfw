import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertNativeToAgorotExact, rateMicrosFromDecimal } from "../../src/lib/fx-history";
import { incomeExpenseByMonthInReporting, spendByCategoryInReporting, type ReportingContext } from "../../src/lib/reporting-currency";
import { createAdminClient } from "../../src/server/db/admin-client";
import { deleteCategoryWithReassignment, renameCategory } from "../../src/server/dal/categories";
import { getEnvelopeBalances } from "../../src/server/dal/envelopes";
import { getLedgerHistory, verifyLedgerChain } from "../../src/server/dal/ledger-commits";
import { setTransactionSplits } from "../../src/server/dal/transaction-splits";
import {
  createTransaction,
  getSpendByCategoryInRange,
  listRealMoneyFlowsInRange,
  listTransactions,
  restoreTransaction,
  setTransactionTransfer,
  softDeleteTransaction,
  TransactionIsSplitError,
  updateTransactionCategory,
} from "../../src/server/dal/transactions";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * Split transactions (AGENTS.md §3xxx) against real Postgres: the sum rule
 * holds at the DAL and in the database itself, every change leaves a
 * verifying commit trail that catches a direct edit, and category totals
 * equal the transactions' own amounts to the agorah.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("split transactions", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let user: { id: string };
  let stranger: { id: string };
  let shekelAccount: { id: string };
  let liraAccount: { id: string };
  let groceries: { id: string };
  let household: { id: string };
  let dining: { id: string };
  let uncategorized: { id: string };
  let strangerCategory: { id: string };

  const SEPT = (day: number) => new Date(Date.UTC(2026, 8, day, 12));
  const TRY_RATE = "0.062267";

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    user = await admin.user.create({ data: { email: `splits-${stamp}@pfw.local`, displayName: "Splits" } });
    stranger = await admin.user.create({ data: { email: `splits-other-${stamp}@pfw.local`, displayName: "Other" } });
    shekelAccount = await admin.bankAccount.create({
      data: { userId: user.id, institutionName: "Leumi", last4: "1111", accountType: "CHECKING", currency: "ILS", nativeBalance: 500_000n },
    });
    liraAccount = await admin.bankAccount.create({
      data: { userId: user.id, institutionName: "QNB", last4: "2222", accountType: "CHECKING", currency: "TRY", nativeBalance: 1_000_000n },
    });
    uncategorized = await admin.category.create({ data: { userId: user.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true } });
    groceries = await admin.category.create({ data: { userId: user.id, slug: "groceries", name: "Groceries" } });
    household = await admin.category.create({ data: { userId: user.id, slug: "household", name: "Household" } });
    dining = await admin.category.create({ data: { userId: user.id, slug: "dining", name: "Dining" } });
    strangerCategory = await admin.category.create({ data: { userId: stranger.id, slug: "groceries", name: "Groceries" } });
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [user.id, stranger.id]);
    await admin.$disconnect();
  });

  function shekels(amount: bigint, description: string, day = 10) {
    return createTransaction(user.id, { bankAccountId: shekelAccount.id, amountAgorot: amount, occurredAt: SEPT(day), description, merchantName: description });
  }

  async function storedSplits(transactionId: string) {
    return admin.transactionSplit.findMany({ where: { transactionId }, orderBy: { categoryId: "asc" } });
  }

  describe("(a) the parts must add up exactly", () => {
    it("refuses parts one agorah short or over, writing nothing and appending no commit", async () => {
      const row = await shekels(-12_550n, "Migros short");
      const commitsBefore = (await getLedgerHistory(user.id, row.id)).length;
      for (const household_ of [2_549n, 2_551n]) {
        const result = await setTransactionSplits(user.id, row.id, [
          { categoryId: groceries.id, nativeAmount: 10_000n },
          { categoryId: household.id, nativeAmount: household_ },
        ]);
        expect(result).toMatchObject({ ok: false, error: "invalid_split", detail: { error: "sum_mismatch" } });
      }
      expect(await storedSplits(row.id)).toEqual([]);
      expect(await getLedgerHistory(user.id, row.id)).toHaveLength(commitsBefore);
    });

    it("is enforced by the database too: an unbalanced, single, or wrong-signed set of rows can't be committed", async () => {
      const row = await shekels(-10_000n, "Direct insert");
      const base = { userId: user.id, transactionId: row.id };
      const attempts = [
        // one agorah short
        [{ ...base, categoryId: groceries.id, amount: -6_000n, nativeAmount: -6_000n }, { ...base, categoryId: household.id, amount: -3_999n, nativeAmount: -3_999n }],
        // a single part
        [{ ...base, categoryId: groceries.id, amount: -10_000n, nativeAmount: -10_000n }],
        // balanced but with a part of the wrong sign
        [{ ...base, categoryId: groceries.id, amount: -11_000n, nativeAmount: -11_000n }, { ...base, categoryId: household.id, amount: 1_000n, nativeAmount: 1_000n }],
        // agorot balance, native amounts don't
        [{ ...base, categoryId: groceries.id, amount: -6_000n, nativeAmount: -6_001n }, { ...base, categoryId: household.id, amount: -4_000n, nativeAmount: -4_000n }],
      ];
      for (const rows of attempts) {
        await expect(admin.$transaction(async (tx) => tx.transactionSplit.createMany({ data: rows }))).rejects.toThrow(/TransactionSplit/);
      }
      expect(await storedSplits(row.id)).toEqual([]);
    });

    it("refuses a split that puts part of one user's transaction in another user's name", async () => {
      const row = await shekels(-10_000n, "Cross-tenant");
      const rows = [
        { userId: user.id, transactionId: row.id, categoryId: groceries.id, amount: -5_000n, nativeAmount: -5_000n },
        { userId: stranger.id, transactionId: row.id, categoryId: strangerCategory.id, amount: -5_000n, nativeAmount: -5_000n },
      ];
      await expect(admin.$transaction(async (tx) => tx.transactionSplit.createMany({ data: rows }))).rejects.toThrow(/wrong owner/);
    });
  });

  describe("(b) every change is a verifying commit, and a direct edit is caught", () => {
    it("records the split, a change to it, and its removal as commits that verify", async () => {
      const row = await shekels(-12_550n, "Migros");
      const first = await setTransactionSplits(user.id, row.id, [
        { categoryId: groceries.id, nativeAmount: 10_000n },
        { categoryId: household.id, nativeAmount: 2_550n },
      ]);
      expect(first).toMatchObject({ ok: true, changed: true, categoryId: groceries.id });

      let history = await getLedgerHistory(user.id, row.id);
      expect(history.map((commit) => commit.action)).toEqual(["CREATE", "UPDATE"]);
      expect(history[1].patchData.splits?.map((split) => [split.categoryName, split.amountAgorot])).toEqual(
        [groceries, household]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((category) => [category === groceries ? "Groceries" : "Household", category === groceries ? "-10000" : "-2550"]),
      );
      expect(history[1].previousHash).toBe(history[0].currentHash);
      expect(await verifyLedgerChain(user.id, row.id)).toEqual({ valid: true, brokenAtCommitId: null, mismatchedFields: [] });

      // The same split again changes nothing and appends nothing.
      expect(
        await setTransactionSplits(user.id, row.id, [
          { categoryId: household.id, nativeAmount: 2_550n },
          { categoryId: groceries.id, nativeAmount: 10_000n },
        ]),
      ).toMatchObject({ ok: true, changed: false });
      expect(await getLedgerHistory(user.id, row.id)).toHaveLength(2);

      // A three-way change, then removal.
      await setTransactionSplits(user.id, row.id, [
        { categoryId: groceries.id, nativeAmount: 8_000n },
        { categoryId: household.id, nativeAmount: 2_550n },
        { categoryId: dining.id, nativeAmount: 2_000n },
      ]);
      expect(await storedSplits(row.id)).toHaveLength(3);
      await setTransactionSplits(user.id, row.id, []);
      expect(await storedSplits(row.id)).toEqual([]);
      history = await getLedgerHistory(user.id, row.id);
      expect(history).toHaveLength(4);
      expect(history[3].patchData.splits).toBeUndefined();
      expect((await verifyLedgerChain(user.id, row.id)).valid).toBe(true);
    });

    it("keeps the splits through delete, restore and a category rename without reading as tampering", async () => {
      const row = await shekels(-5_000n, "Kept splits");
      await setTransactionSplits(user.id, row.id, [
        { categoryId: groceries.id, nativeAmount: 3_000n },
        { categoryId: household.id, nativeAmount: 2_000n },
      ]);
      await softDeleteTransaction(user.id, row.id);
      await restoreTransaction(user.id, row.id);
      await renameCategory(user.id, household.id, "Home");
      await renameCategory(user.id, household.id, "Household");
      const history = await getLedgerHistory(user.id, row.id);
      expect(history.map((commit) => commit.action)).toEqual(["CREATE", "UPDATE", "DELETE", "RESTORE"]);
      expect(history.every((commit) => commit.patchData.splits?.length === 2 || commit.action === "CREATE")).toBe(true);
      expect(await verifyLedgerChain(user.id, row.id)).toEqual({ valid: true, brokenAtCommitId: null, mismatchedFields: [] });
    });

    it("reports a split edited directly in the database, even when the parts still add up", async () => {
      const moved = await shekels(-5_000n, "Moved agorah");
      await setTransactionSplits(user.id, moved.id, [
        { categoryId: groceries.id, nativeAmount: 3_000n },
        { categoryId: household.id, nativeAmount: 2_000n },
      ]);
      // Moving one agorah between parts keeps the sum, so the database allows it.
      await admin.$transaction(async (tx) => {
        await tx.transactionSplit.updateMany({ where: { transactionId: moved.id, categoryId: groceries.id }, data: { amount: -2_999n, nativeAmount: -2_999n } });
        await tx.transactionSplit.updateMany({ where: { transactionId: moved.id, categoryId: household.id }, data: { amount: -2_001n, nativeAmount: -2_001n } });
      });
      const [, head] = await getLedgerHistory(user.id, moved.id);
      expect(await verifyLedgerChain(user.id, moved.id)).toEqual({ valid: false, brokenAtCommitId: head.id, mismatchedFields: ["splits"] });

      const recategorised = await shekels(-5_000n, "Moved category");
      await setTransactionSplits(user.id, recategorised.id, [
        { categoryId: groceries.id, nativeAmount: 3_000n },
        { categoryId: household.id, nativeAmount: 2_000n },
      ]);
      await admin.transactionSplit.updateMany({ where: { transactionId: recategorised.id, categoryId: household.id }, data: { categoryId: dining.id } });
      expect((await verifyLedgerChain(user.id, recategorised.id)).mismatchedFields).toEqual(["splits"]);
    });
  });

  describe("(c) category totals equal the transactions to the agorah", () => {
    it("counts every split row once, by its parts, in every total", async () => {
      // A separate month so the other tests' rows don't count here.
      const OCT = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
      const from = new Date(Date.UTC(2026, 9, 1));
      const to = new Date(Date.UTC(2026, 10, 1));
      const make = (amount: bigint, description: string, day: number) =>
        createTransaction(user.id, { bankAccountId: shekelAccount.id, amountAgorot: amount, occurredAt: OCT(day), description, merchantName: description });

      const balancesBefore = await admin.bankAccount.findMany({ where: { userId: user.id }, select: { id: true, nativeBalance: true }, orderBy: { id: "asc" } });

      const split = await make(-12_551n, "Migros odd agorah", 3);
      const plain = await make(-4_000n, "Zqxv shop", 4);
      await updateTransactionCategory(user.id, plain.id, uncategorized.id);
      await make(20_000n, "Salary", 5);
      const liraRow = await createTransaction(user.id, {
        bankAccountId: liraAccount.id,
        amountAgorot: BigInt(convertNativeToAgorotExact(-10_000n, rateMicrosFromDecimal(TRY_RATE))),
        occurredAt: OCT(6),
        description: "A101",
        merchantName: "A101",
        entered: { currency: "TRY", nativeAmount: -10_000n, exchangeRate: TRY_RATE },
      });
      await setTransactionSplits(user.id, split.id, [
        { categoryId: groceries.id, nativeAmount: 10_001n },
        { categoryId: household.id, nativeAmount: 2_550n },
      ]);
      await setTransactionSplits(user.id, liraRow.id, [
        { categoryId: groceries.id, nativeAmount: 3_334n },
        { categoryId: household.id, nativeAmount: 3_333n },
        { categoryId: dining.id, nativeAmount: 3_333n },
      ]);

      // The lira row's stored splits add up to its own stored figures exactly.
      const liraSplits = await storedSplits(liraRow.id);
      expect(liraSplits.reduce((sum, s) => sum + s.amount, 0n)).toBe(liraRow.amount);
      expect(liraSplits.reduce((sum, s) => sum + s.nativeAmount, 0n)).toBe(-10_000n);

      const spend = new Map((await getSpendByCategoryInRange(user.id, from, to)).map((row) => [row.categoryId, row.totalAgorot]));
      const liraBy = new Map(liraSplits.map((s) => [s.categoryId, -s.amount]));
      expect(spend.get(groceries.id)).toBe(10_001n + liraBy.get(groceries.id)!);
      expect(spend.get(household.id)).toBe(2_550n + liraBy.get(household.id)!);
      expect(spend.get(dining.id)).toBe(liraBy.get(dining.id)!);
      expect(spend.get(uncategorized.id)).toBe(4_000n);

      // Category totals add up to the month's spending, which is the sum of the transactions themselves.
      const transactions = await admin.notableTransaction.findMany({ where: { userId: user.id, occurredAt: { gte: from, lt: to }, deletedAt: null } });
      const spent = transactions.filter((t) => t.amount < 0n).reduce((sum, t) => sum - t.amount, 0n);
      expect([...spend.values()].reduce((sum, value) => sum + value, 0n)).toBe(spent);

      // The same holds in another reporting currency, part by part.
      const usd: ReportingContext = { currency: "USD", ilsPerUnit: 3.037667, latestMicros: 3_037_667, rateDay: "2026-10-09", history: [{ day: "2026-09-01", micros: 3_037_667 }] };
      const flows = await listRealMoneyFlowsInRange(user.id, from, to);
      const byCategory = spendByCategoryInReporting(flows, usd);
      const month = incomeExpenseByMonthInReporting(flows, usd).get("2026-10")!;
      expect([...byCategory.values()].reduce((sum, value) => sum + value, 0)).toBe(month.expense);
      // Dining holds money only through a split part, so it shows up only if flows are read part by part.
      expect(byCategory.get(dining.id)).toBeGreaterThan(0);
      expect(byCategory.get(household.id)).toBeGreaterThan(byCategory.get(dining.id)!);

      // Envelopes spend from each part's category.
      const envelopes = new Map((await getEnvelopeBalances(user.id, "2026-10")).map((e) => [e.categoryId, e]));
      expect(envelopes.get(household.id)?.spentThisMonthAgorot).toBe(Number(spend.get(household.id)));

      // A split row is listed under each of its categories.
      const underDining = await listTransactions(user.id, { categoryId: dining.id });
      expect(underDining.map((row) => row.id)).toContain(liraRow.id);

      // Splitting moves no money: account balances are untouched.
      expect(await admin.bankAccount.findMany({ where: { userId: user.id }, select: { id: true, nativeBalance: true }, orderBy: { id: "asc" } })).toEqual(balancesBefore);
    });
  });

  describe("what a split row refuses", () => {
    it("won't take a single category, a transfer, an archived or Uncategorized part, or a stranger's category", async () => {
      const row = await shekels(-6_000n, "Refusals");
      await setTransactionSplits(user.id, row.id, [
        { categoryId: groceries.id, nativeAmount: 3_000n },
        { categoryId: household.id, nativeAmount: 3_000n },
      ]);
      await expect(updateTransactionCategory(user.id, row.id, dining.id)).rejects.toThrow(TransactionIsSplitError);
      expect(await setTransactionSplits(user.id, row.id, [
        { categoryId: groceries.id, nativeAmount: 3_000n },
        { categoryId: uncategorized.id, nativeAmount: 3_000n },
      ])).toMatchObject({ ok: false, error: "category_not_allowed" });
      expect(await setTransactionSplits(user.id, row.id, [
        { categoryId: groceries.id, nativeAmount: 3_000n },
        { categoryId: strangerCategory.id, nativeAmount: 3_000n },
      ])).toMatchObject({ ok: false, error: "category_not_found" });

      const transfer = await shekels(-2_000n, "Own transfer");
      await setTransactionTransfer(user.id, transfer.id, true);
      expect(await setTransactionSplits(user.id, transfer.id, [
        { categoryId: groceries.id, nativeAmount: 1_000n },
        { categoryId: household.id, nativeAmount: 1_000n },
      ])).toMatchObject({ ok: false, error: "is_transfer" });
    });

    it("keeps a category that holds part of a split from being deleted", async () => {
      expect(await deleteCategoryWithReassignment(user.id, dining.id)).toMatchObject({ ok: false, error: "in_split" });
    });

    it("can't be split by another user", async () => {
      const row = await shekels(-6_000n, "Not yours");
      expect(await setTransactionSplits(stranger.id, row.id, [
        { categoryId: strangerCategory.id, nativeAmount: 3_000n },
        { categoryId: strangerCategory.id, nativeAmount: 3_000n },
      ])).toEqual({ ok: false, error: "not_found" });
    });
  });
});
