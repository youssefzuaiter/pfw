import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAccount } from "../../src/server/account/delete-account";
import { buildSafeToSpendData } from "../../src/server/analytics/build-safe-to-spend-data";
import { createAdminClient } from "../../src/server/db/admin-client";
import { applyDebtPaymentMatches, listDebtPaymentMatches, MAX_DEBT_PAYMENTS_PER_APPLY } from "../../src/server/dal/debt-payment-matches";

/**
 * Repayments of debts that are already in the ledger (AGENTS.md §3nnnn), against
 * real Postgres: what is matched (and what is not), recording one as a payment
 * that lowers the balance and can never be recorded twice, another user's rows
 * never touched, and Safe to Spend crediting a repayment made as an ordinary
 * transaction. Dates are fixed (mid-October 2026).
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("debt payment matches", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const users: string[] = [];
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
  const ASOF = new Date("2026-10-16T09:00:00Z");

  async function seedUser(label: string) {
    const user = await admin.user.create({ data: { email: `debtmatch-${label}-${stamp}@pfw.local`, displayName: `Debt ${label}` } });
    users.push(user.id);
    const category = await admin.category.create({ data: { userId: user.id, slug: "misc", name: "Misc" } });
    const account = await admin.bankAccount.create({
      data: { userId: user.id, institutionName: "Test Bank", last4: "1111", accountType: "CHECKING", nativeBalance: 1_000_000n, balanceAsOf: at("2026-10-01") },
    });
    const tx = (name: string, iso: string, amount: number, extra: { isTransfer?: boolean; deleted?: boolean } = {}) =>
      admin.notableTransaction.create({
        data: {
          userId: user.id,
          bankAccountId: account.id,
          categoryId: category.id,
          occurredAt: at(iso),
          amount: BigInt(amount),
          nativeAmount: BigInt(amount),
          description: name,
          merchantName: name,
          isManual: true,
          needsReview: false,
          isTransfer: extra.isTransfer ?? false,
          deletedAt: extra.deleted ? new Date() : null,
        },
      });
    const debt = (name: string, balance: number, extra: { minimum?: number; createdIso?: string } = {}) =>
      admin.debt.create({
        data: {
          userId: user.id,
          name,
          debtType: "AUTO_LOAN",
          currentBalance: BigInt(balance),
          aprBps: 0,
          minimumPayment: BigInt(extra.minimum ?? 5_000),
          createdAt: at(extra.createdIso ?? "2026-09-01"),
        },
      });
    return { id: user.id, tx, debt };
  }

  beforeAll(() => {
    admin = createAdminClient();
  });

  afterAll(async () => {
    for (const id of users) await deleteAccount(id);
    await admin.accountDeletionRecord.deleteMany({ where: { deletedUserId: { in: users } } });
  });

  const balanceOf = async (debtId: string) => Number((await admin.debt.findUniqueOrThrow({ where: { id: debtId } })).currentBalance);

  it("matches repayments made after the debt was added, and not other rows", async () => {
    const u = await seedUser("list");
    const d = await u.debt("Volkswagen loan", 1_000_000);
    const after = await u.tx("VOLKSWAGEN LOAN", "2026-10-05", -50_000);
    await u.tx("VOLKSWAGEN LOAN", "2026-08-05", -50_000); // before the debt was added
    await u.tx("VOLKSWAGEN LOAN", "2026-10-06", 50_000); // money in
    await u.tx("VOLKSWAGEN LOAN", "2026-10-07", -50_000, { isTransfer: true });
    await u.tx("VOLKSWAGEN LOAN", "2026-10-08", -50_000, { deleted: true });
    await u.tx("Supermarket", "2026-10-09", -50_000);
    const matches = await listDebtPaymentMatches(u.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ debtId: d.id, transactionId: after.id, amountAgorot: 50_000, debtName: "Volkswagen loan", recorded: false });
  });

  it("skips a row that fits two debts, and shows another user none of it", async () => {
    const u = await seedUser("ambiguous");
    await u.debt("Leumi car loan", 1_000_000);
    await u.debt("Leumi mortgage", 1_000_000);
    await u.tx("Leumi payment", "2026-10-05", -50_000);
    expect(await listDebtPaymentMatches(u.id)).toEqual([]);

    const owner = await seedUser("owner");
    await owner.debt("Volkswagen loan", 1_000_000);
    await owner.tx("VOLKSWAGEN LOAN", "2026-10-05", -50_000);
    const stranger = await seedUser("stranger");
    expect(await listDebtPaymentMatches(stranger.id)).toEqual([]);
  });

  it("records a match as a payment that lowers the balance, linked to its transaction", async () => {
    const u = await seedUser("apply");
    const d = await u.debt("Volkswagen loan", 1_000_000);
    const t1 = await u.tx("VOLKSWAGEN LOAN", "2026-10-05", -50_000);
    const t2 = await u.tx("VOLKSWAGEN LOAN", "2026-10-12", -30_000);

    const result = await applyDebtPaymentMatches(u.id, [
      { debtId: d.id, transactionId: t2.id },
      { debtId: d.id, transactionId: t1.id },
    ]);
    expect(result).toEqual({ applied: 2, skipped: 0 });
    expect(await balanceOf(d.id)).toBe(1_000_000 - 80_000);

    const payments = await admin.debtPayment.findMany({ where: { debtId: d.id }, orderBy: { paidAt: "asc" } });
    expect(payments.map((p) => [Number(p.amount), p.transactionId])).toEqual([[50_000, t1.id], [30_000, t2.id]]);
    expect(payments[0].paidAt).toEqual(t1.occurredAt);

    // Now flagged as recorded, and never offered or applied again.
    expect((await listDebtPaymentMatches(u.id)).every((m) => m.recorded)).toBe(true);
    expect(await applyDebtPaymentMatches(u.id, [{ debtId: d.id, transactionId: t1.id }])).toEqual({ applied: 0, skipped: 1 });
    expect(await balanceOf(d.id)).toBe(1_000_000 - 80_000);
  });

  it("applies only what the matcher still proposes: a made-up pair, another user's and a repeated one change nothing", async () => {
    const u = await seedUser("scope");
    const d = await u.debt("Volkswagen loan", 1_000_000);
    const unrelated = await u.tx("Supermarket", "2026-10-05", -50_000);
    const good = await u.tx("VOLKSWAGEN LOAN", "2026-10-06", -10_000);
    const other = await seedUser("scope-other");
    const od = await other.debt("Volkswagen loan", 1_000_000);
    const ot = await other.tx("VOLKSWAGEN LOAN", "2026-10-05", -50_000);

    const result = await applyDebtPaymentMatches(u.id, [
      { debtId: d.id, transactionId: unrelated.id },
      { debtId: od.id, transactionId: ot.id },
      { debtId: d.id, transactionId: good.id },
      { debtId: d.id, transactionId: good.id },
    ]);
    expect(result).toEqual({ applied: 1, skipped: 3 });
    expect(await balanceOf(d.id)).toBe(990_000);
    expect(await balanceOf(od.id)).toBe(1_000_000);
    expect(await admin.debtPayment.count({ where: { debtId: od.id } })).toBe(0);
  });

  it("refuses an empty or oversized request", async () => {
    const u = await seedUser("limits");
    await expect(applyDebtPaymentMatches(u.id, [])).rejects.toThrow(RangeError);
    const many = Array.from({ length: MAX_DEBT_PAYMENTS_PER_APPLY + 1 }, (_, i) => ({ debtId: `d${i}`, transactionId: `t${i}` }));
    await expect(applyDebtPaymentMatches(u.id, many)).rejects.toThrow(RangeError);
  });

  describe("in Safe to Spend", () => {
    const dueOf = async (userId: string, name: string) => (await buildSafeToSpendData(userId, ASOF)).debts.find((d) => d.name === name)!;

    it("credits a repayment made as an ordinary transaction this month", async () => {
      const u = await seedUser("sts");
      await u.debt("Volkswagen loan", 1_000_000, { minimum: 5_000 });
      expect(await dueOf(u.id, "Volkswagen loan")).toMatchObject({ dueAgorot: 5_000, paidThisMonthAgorot: 0 });
      await u.tx("VOLKSWAGEN LOAN", "2026-10-05", -5_000);
      expect(await dueOf(u.id, "Volkswagen loan")).toMatchObject({ dueAgorot: 0, paidThisMonthAgorot: 5_000 });
    });

    it("counts a repayment made this month before the debt was added: it is cash that already left", async () => {
      const u = await seedUser("before");
      await u.debt("Volkswagen loan", 1_000_000, { minimum: 5_000, createdIso: "2026-10-10" });
      await u.tx("VOLKSWAGEN LOAN", "2026-10-05", -5_000);
      expect(await dueOf(u.id, "Volkswagen loan")).toMatchObject({ dueAgorot: 0 });
      // But it is not offered for recording: the balance already holds it.
      expect(await listDebtPaymentMatches(u.id)).toEqual([]);
    });

    it("does not count a payment twice when it is recorded and in the ledger, and ignores last month's", async () => {
      const u = await seedUser("twice");
      const d = await u.debt("Volkswagen loan", 1_000_000, { minimum: 5_000 });
      const t = await u.tx("VOLKSWAGEN LOAN", "2026-10-05", -2_000);
      await u.tx("VOLKSWAGEN LOAN", "2026-09-05", -9_000);
      await applyDebtPaymentMatches(u.id, [{ debtId: d.id, transactionId: t.id }]);
      // 2,000 recorded and the same 2,000 in the ledger: still 2,000 paid, so 3,000 is due (not 1,000).
      expect(await dueOf(u.id, "Volkswagen loan")).toMatchObject({ paidThisMonthAgorot: 2_000, dueAgorot: 3_000 });
    });

    it("keeps a payment typed in by hand when the ledger has no match", async () => {
      const u = await seedUser("manual");
      const d = await u.debt("Volkswagen loan", 1_000_000, { minimum: 5_000 });
      await admin.debtPayment.create({ data: { userId: u.id, debtId: d.id, amount: 4_000n, paidAt: at("2026-10-03") } });
      expect(await dueOf(u.id, "Volkswagen loan")).toMatchObject({ paidThisMonthAgorot: 4_000, dueAgorot: 1_000 });
    });
  });
});
