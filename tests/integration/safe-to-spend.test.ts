import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSafeToSpendData, serializeSafeToSpend } from "../../src/server/analytics/build-safe-to-spend-data";
import { createAdminClient } from "../../src/server/db/admin-client";
import { reconcileBankAccount } from "../../src/server/dal/bank-accounts";

/**
 * Safe to Spend against real Postgres (formula and edge cases:
 * `src/lib/safe-to-spend.ts`, which has the pure unit coverage). This suite
 * proves the DAL half: balances rolled forward by their transactions,
 * transfers and deleted rows handled as documented, envelopes and recurring
 * bills read from real rows, and the whole thing scoped to one user.
 *
 * Everything is dated against a fixed `asOf` (mid-October 2026) and the
 * accounts are back-dated to the 1st of September, so the result does not
 * depend on when the suite runs.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("Safe to Spend", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let userC: { id: string };
  let userD: { id: string };
  let checkingId: string;
  let savingsId: string;
  let cardId: string;
  const categories: Record<"groceries" | "rent" | "dining" | "misc", string> = { groceries: "", rent: "", dining: "", misc: "" };

  const asOf = () => new Date("2026-10-16T09:00:00Z");
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

  async function transaction(
    accountId: string,
    category: keyof typeof categories,
    iso: string,
    amount: bigint,
    name: string,
    flags: { isTransfer?: boolean; deletedAt?: Date } = {},
  ) {
    return admin.notableTransaction.create({
      data: {
        userId: userA.id,
        bankAccountId: accountId,
        categoryId: categories[category],
        occurredAt: at(iso),
        currency: "ILS",
        nativeAmount: amount,
        amount,
        description: name,
        merchantName: name,
        ...flags,
      },
    });
  }

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    userA = await admin.user.create({ data: { email: `safe-to-spend-a-${stamp}@pfw.local`, displayName: "Safe A" } });
    userB = await admin.user.create({ data: { email: `safe-to-spend-b-${stamp}@pfw.local`, displayName: "Safe B" } });
    userC = await admin.user.create({ data: { email: `safe-to-spend-c-${stamp}@pfw.local`, displayName: "Safe C" } });
    userD = await admin.user.create({ data: { email: `safe-to-spend-d-${stamp}@pfw.local`, displayName: "Safe D" } });

    const created = at("2026-09-01");
    const account = (last4: string, accountType: "CHECKING" | "SAVINGS" | "CREDIT_CARD", nativeBalance: bigint) =>
      admin.bankAccount.create({
        data: { userId: userA.id, institutionName: "Test Bank", last4, accountType, nativeBalance, createdAt: created },
      });
    checkingId = (await account("1111", "CHECKING", 1_000_000n)).id;
    savingsId = (await account("2222", "SAVINGS", 500_000n)).id;
    cardId = (await account("3333", "CREDIT_CARD", 100_000n)).id;

    for (const [slug, name] of [
      ["groceries", "Groceries"],
      ["rent", "Rent"],
      ["dining", "Dining"],
      ["misc", "Misc"],
    ] as const) {
      categories[slug] = (await admin.category.create({ data: { userId: userA.id, slug, name } })).id;
    }

    // Rent: three monthly charges (so the radar sees a recurring bill), the
    // last on Sep 25, so October's is still to come. Jul/Aug are before the
    // account existed: part of its opening balance, not of the flow.
    await transaction(checkingId, "rent", "2026-07-25", -400_000n, "Landlord");
    await transaction(checkingId, "rent", "2026-08-25", -400_000n, "Landlord");
    await transaction(checkingId, "rent", "2026-09-25", -400_000n, "Landlord");
    // A streaming subscription already charged in October: paid, not pending.
    await transaction(checkingId, "misc", "2026-08-03", -3_990n, "Streamflix");
    await transaction(checkingId, "misc", "2026-09-03", -3_990n, "Streamflix");
    await transaction(checkingId, "misc", "2026-10-03", -3_990n, "Streamflix");

    await transaction(checkingId, "misc", "2026-10-02", 800_000n, "Employer");
    await transaction(checkingId, "groceries", "2026-10-05", -150_000n, "Supermarket");
    await transaction(checkingId, "dining", "2026-10-08", -130_000n, "Restaurant");
    // A move between the user's own accounts, filed under groceries on
    // purpose: if it counted as spending, the groceries envelope would drop.
    await transaction(checkingId, "groceries", "2026-10-10", -200_000n, "To savings", { isTransfer: true });
    await transaction(savingsId, "misc", "2026-10-10", 200_000n, "From checking", { isTransfer: true });
    // A charge on the card, and a row that was deleted.
    await transaction(cardId, "misc", "2026-10-12", -50_000n, "Card purchase");
    await transaction(checkingId, "misc", "2026-10-06", -999_999n, "Mistake", { deletedAt: at("2026-10-07") });

    const allocate = (category: keyof typeof categories, month: string, amount: bigint) =>
      admin.envelopeAllocation.create({ data: { userId: userA.id, categoryId: categories[category], month, amountAgorot: amount } });
    for (const month of ["2026-07", "2026-08", "2026-09", "2026-10"]) await allocate("rent", month, 400_000n);
    await allocate("groceries", "2026-10", 400_000n);
    await allocate("dining", "2026-10", 100_000n);

    const goal = await admin.goal.create({
      data: { userId: userA.id, name: "Trip", targetAmount: 300_000n, targetDate: at("2026-12-20") },
    });
    await admin.goalContribution.create({
      data: { userId: userA.id, goalId: goal.id, amount: 50_000n, contributedAt: at("2026-10-01") },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id, userC.id, userD.id] } } });
    await admin.$disconnect();
  });

  it("assembles the figure from real accounts, envelopes, bills and goals", async () => {
    const data = await buildSafeToSpendData(userA.id, asOf());

    // Checking: 1,000,000 + (−400,000 rent −3,990 ×2 +800,000 −150,000 −130,000 −200,000 transfer), the
    // deleted row excluded. Savings: 500,000 + 200,000 transfer in. Rent Jul/Aug and the Aug stream predate the account.
    expect(data.cashAgorot).toBe(912_020 + 700_000);
    // The card: 100,000 owed + the 50,000 charge.
    expect(data.cardOwedAgorot).toBe(150_000);
    // Groceries 400,000 − 150,000 (the transfer filed under it does not count); rent 1,600,000 − 1,200,000; dining overspent adds nothing.
    expect(data.envelopeReserveAgorot).toBe(250_000 + 400_000);
    // Rent is still to come (400,000), and its envelope holds exactly that.
    expect(data.bills.map((b) => [b.displayName.toLowerCase(), b.totalAgorot, b.coveredByEnvelopeAgorot])).toEqual([["landlord", 400_000, 400_000]]);
    expect(data.billsNotCoveredAgorot).toBe(0);
    // Trip: 300,000 over Oct–Dec = 100,000 a month, 50,000 already saved.
    expect(data.goalDueAgorot).toBe(50_000);
    expect(data.safeToSpendAgorot).toBe(1_612_020 - 150_000 - 650_000 - 50_000);
    expect(data.isOverCommitted).toBe(false);
  });

  it("lists every overspent envelope, largest first, and still adds nothing back for them", async () => {
    const data = await buildSafeToSpendData(userA.id, asOf());
    // Dining: 130,000 spent against 100,000. Misc was never given an envelope, so spending in it (the
    // streaming charges, the card purchase) is spending without a budget, not an overdraft.
    expect(data.overspentEnvelopes).toEqual([{ categoryId: categories.dining, categoryName: "Dining", overspentAgorot: 30_000 }]);
  });

  it("does not count the streaming subscription charged this month as a pending bill", async () => {
    const data = await buildSafeToSpendData(userA.id, asOf());
    expect(data.bills.some((b) => b.displayName === "Streamflix")).toBe(false);
  });

  it("leaves the figure unchanged when a bill its envelope covered is paid", async () => {
    const before = await buildSafeToSpendData(userA.id, asOf());
    await transaction(checkingId, "rent", "2026-10-14", -400_000n, "Landlord");

    const after = await buildSafeToSpendData(userA.id, asOf());
    // Cash fell by the rent, the rent envelope emptied by the same amount, and the bill is no longer pending.
    expect(after.cashAgorot).toBe(before.cashAgorot - 400_000);
    expect(after.envelopeReserveAgorot).toBe(before.envelopeReserveAgorot - 400_000);
    expect(after.bills).toEqual([]);
    expect(after.safeToSpendAgorot).toBe(before.safeToSpendAgorot);
  });

  it("falls by exactly the amount when something outside any envelope is bought", async () => {
    const before = await buildSafeToSpendData(userA.id, asOf());
    await transaction(checkingId, "misc", "2026-10-15", -25_000n, "Gadget");
    const after = await buildSafeToSpendData(userA.id, asOf());
    expect(after.safeToSpendAgorot).toBe(before.safeToSpendAgorot - 25_000);
  });

  it("counts a transfer in from an account the app doesn't track as cash, but not as income or spending", async () => {
    const before = await buildSafeToSpendData(userA.id, asOf());
    // The other leg (e.g. the user's own USD account) is not in the ledger, so this really does add cash.
    await transaction(checkingId, "groceries", "2026-10-15", 100_000n, "Converted from USD", { isTransfer: true });
    const after = await buildSafeToSpendData(userA.id, asOf());
    expect(after.cashAgorot).toBe(before.cashAgorot + 100_000);
    // Filed under groceries, yet the groceries envelope is untouched: a transfer is not a refund.
    expect(after.envelopeReserveAgorot).toBe(before.envelopeReserveAgorot);
    expect(after.safeToSpendAgorot).toBe(before.safeToSpendAgorot + 100_000);
  });

  it("leaves savings out of cash, and still reports them, when the user keeps savings as a reserve", async () => {
    // Earlier tests in this file add rows, so compare the two settings with each other.
    const counted = await buildSafeToSpendData(userA.id, asOf());
    expect(counted.savingsCounted).toBe(true);
    expect(counted.savingsAgorot).toBe(700_000);

    await admin.userSettings.upsert({
      where: { userId: userA.id },
      create: { userId: userA.id, safeToSpendCountSavings: false },
      update: { safeToSpendCountSavings: false },
    });
    try {
      const reserve = await buildSafeToSpendData(userA.id, asOf());
      expect(reserve.savingsCounted).toBe(false);
      expect(reserve.savingsAgorot).toBe(700_000);
      expect(reserve.cashAgorot).toBe(counted.cashAgorot - 700_000);
      expect(reserve.safeToSpendAgorot).toBe(counted.safeToSpendAgorot - 700_000);
    } finally {
      await admin.userSettings.update({ where: { userId: userA.id }, data: { safeToSpendCountSavings: true } });
    }
    expect((await buildSafeToSpendData(userA.id, asOf())).safeToSpendAgorot).toBe(counted.safeToSpendAgorot);
  });

  it("subtracts a debt's minimum, credits this month's payments on it, and does not count a debt twice", async () => {
    const before = await buildSafeToSpendData(userA.id, asOf());
    // One after the other: the list is read in creation order.
    const studentLoan = await admin.debt.create({
      data: { userId: userA.id, name: "Student loan", debtType: "STUDENT_LOAN", currentBalance: 2_000_000n, aprBps: 300, minimumPayment: 40_000n },
    });
    // Its repayment is the recurring "Landlord" charge the bill detection already counts.
    const landlordDebt = await admin.debt.create({
      data: { userId: userA.id, name: "Landlord", debtType: "OTHER", currentBalance: 9_000_000n, aprBps: 0, minimumPayment: 400_000n },
    });
    const created = [studentLoan, landlordDebt];
    try {
      await admin.debtPayment.create({ data: { userId: userA.id, debtId: created[0].id, amount: 15_000n, paidAt: at("2026-10-03") } });
      // Last month's payment is not this month's.
      await admin.debtPayment.create({ data: { userId: userA.id, debtId: created[0].id, amount: 40_000n, paidAt: at("2026-09-03") } });

      const after = await buildSafeToSpendData(userA.id, asOf());
      expect(after.debtDueAgorot).toBe(25_000);
      expect(after.safeToSpendAgorot).toBe(before.safeToSpendAgorot - 25_000);
      expect(after.debts.map((d) => [d.name, d.dueAgorot, d.handledByBill])).toEqual([
        ["Student loan", 25_000, null],
        ["Landlord", 0, "Landlord"],
      ]);
    } finally {
      await admin.debt.deleteMany({ where: { id: { in: created.map((d) => d.id) } } });
    }
    expect((await buildSafeToSpendData(userA.id, asOf())).safeToSpendAgorot).toBe(before.safeToSpendAgorot);
  });

  it("counts only transactions dated after the day a balance is true for", async () => {
    const account = await admin.bankAccount.create({
      data: {
        userId: userC.id, institutionName: "Test Bank", last4: "4444", accountType: "CHECKING",
        nativeBalance: 1_000_000n, createdAt: at("2026-09-01"), balanceAsOf: new Date("2026-10-10T00:00:00Z"),
      },
    });
    const category = await admin.category.create({ data: { userId: userC.id, slug: "misc", name: "Misc" } });
    const spend = (iso: string, amount: bigint, name: string) =>
      admin.notableTransaction.create({
        data: {
          userId: userC.id, bankAccountId: account.id, categoryId: category.id, occurredAt: at(iso),
          currency: "ILS", nativeAmount: -amount, amount: -amount, description: name, merchantName: name,
        },
      });
    // The typed balance, as of Oct 10, already holds the first two.
    await spend("2026-10-09", 100_000n, "Before");
    await spend("2026-10-10", 50_000n, "On the day");
    await spend("2026-10-11", 30_000n, "After");

    const data = await buildSafeToSpendData(userC.id, asOf());
    expect(data.cashAgorot).toBe(970_000);

    // The same account with no day given counts everything after it was created: the double count this fixes.
    await admin.bankAccount.update({ where: { id: account.id }, data: { balanceAsOf: null } });
    const legacy = await buildSafeToSpendData(userC.id, new Date("2026-10-16T09:00:00.001Z"));
    expect(legacy.cashAgorot).toBe(1_000_000 - 100_000 - 50_000 - 30_000);

    // Re-stating the balance moves the starting point.
    const result = await reconcileBankAccount(userC.id, account.id, { nativeBalance: 800_000n, balanceAsOf: new Date("2026-10-11T00:00:00Z") });
    expect(result.ok).toBe(true);
    const restated = await buildSafeToSpendData(userC.id, new Date("2026-10-16T09:00:00.002Z"));
    expect(restated.cashAgorot).toBe(800_000);
  });

  it("cannot re-state another user's account", async () => {
    const account = await admin.bankAccount.findFirstOrThrow({ where: { userId: userC.id } });
    const result = await reconcileBankAccount(userB.id, account.id, { nativeBalance: 1n, balanceAsOf: new Date("2026-10-01T00:00:00Z") });
    expect(result).toEqual({ ok: false, error: "not_found" });
    const unchanged = await admin.bankAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(unchanged.nativeBalance).toBe(800_000n);
  });

  it("reports recurring income still to arrive beside the figure, not inside it, and ignores transfers", async () => {
    const account = await admin.bankAccount.create({
      data: { userId: userD.id, institutionName: "Test Bank", last4: "5555", accountType: "CHECKING", nativeBalance: 500_000n, createdAt: at("2026-06-01") },
    });
    const category = await admin.category.create({ data: { userId: userD.id, slug: "income", name: "Income" } });
    const credit = (iso: string, amount: bigint, name: string, isTransfer = false) =>
      admin.notableTransaction.create({
        data: {
          userId: userD.id, bankAccountId: account.id, categoryId: category.id, occurredAt: at(iso),
          currency: "ILS", nativeAmount: amount, amount, description: name, merchantName: name, isTransfer,
        },
      });
    // A salary paid on the 28th: July, August, September arrived, October's has not.
    for (const month of ["2026-07", "2026-08", "2026-09"]) await credit(`${month}-28`, 900_000n, "Employer Ltd");
    // The user's own USD conversions look just as regular, but they are transfers, not income.
    for (const month of ["2026-07", "2026-08", "2026-09"]) await credit(`${month}-05`, 300_000n, "USD conversion", true);

    const data = await buildSafeToSpendData(userD.id, asOf());
    expect(data.expectedIncome.map((i) => [i.displayName, i.totalAgorot])).toEqual([["Employer Ltd", 900_000]]);
    expect(data.expectedIncomeAgorot).toBe(900_000);
    // Cash: 500,000 opening + the three salaries and three transfers that arrived after the account was made.
    expect(data.safeToSpendAgorot).toBe(500_000 + 3 * 900_000 + 3 * 300_000);
    expect(data.safeToSpendWithExpectedIncomeAgorot).toBe(data.safeToSpendAgorot + 900_000);

    // Once the October salary arrives it is received, not expected.
    await credit("2026-10-14", 900_000n, "Employer Ltd");
    const after = await buildSafeToSpendData(userD.id, new Date("2026-10-16T09:00:00.003Z"));
    expect(after.expectedIncome).toEqual([]);
    expect(after.safeToSpendAgorot).toBe(data.safeToSpendAgorot + 900_000);
  });

  it("serializes to plain JSON with no bigint or Date left in it", async () => {
    const data = await buildSafeToSpendData(userA.id, asOf());
    const json = JSON.parse(JSON.stringify(serializeSafeToSpend(data)));
    expect(json.safeToSpendAgorot).toBe(data.safeToSpendAgorot);
    expect(json.month).toBe("2026-10");
    expect(json.debtDueAgorot).toBe(0);
    expect(json.expectedIncome).toEqual([]);
    expect(json.savingsCounted).toBe(true);
    expect(typeof json.asOf).toBe("string");
  });

  it("is scoped to one user: another user sees none of it", async () => {
    const data = await buildSafeToSpendData(userB.id, asOf());
    expect(data).toMatchObject({
      cashAgorot: 0,
      cardOwedAgorot: 0,
      envelopeReserveAgorot: 0,
      billsNotCoveredAgorot: 0,
      goalDueAgorot: 0,
      debtDueAgorot: 0,
      expectedIncomeAgorot: 0,
      safeToSpendAgorot: 0,
      isOverCommitted: false,
    });
    expect(data.bills).toEqual([]);
  });
});
