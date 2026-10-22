import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentBalanceAgorot, settleBalance } from "../../src/lib/account-balance";
import { convertNativeAmountToAgorot } from "../../src/lib/exchange-rate";
import { nativeAmount } from "../../src/lib/currency";
import { buildSafeToSpendData } from "../../src/server/analytics/build-safe-to-spend-data";
import { createAdminClient } from "../../src/server/db/admin-client";
import { listAccountBalanceParts } from "../../src/server/dal/account-balances";
import { getLatestRateTable } from "../../src/server/dal/exchange-rates";
import { computeLiveNetWorth } from "../../src/server/dal/net-worth";

/**
 * One rule for what an account holds now (`src/lib/account-balance.ts`), read
 * by net worth, Safe to Spend and the Assets page. This suite proves the three
 * agree for the same rows, and that the roll-forward starts on the right day,
 * leaves out deleted rows, counts transfers, and keeps a foreign-currency
 * account in its own currency.
 *
 * Dollar figures are compared against the same stored rate table the code
 * reads, so the suite does not depend on what rate happens to be synced.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("consistent account balances", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let owner: { id: string };
  let stranger: { id: string };
  let checkingId: string;
  let savingsId: string;
  let cardId: string;
  let usdId: string;
  let categoryId: string;

  const asOf = () => new Date("2026-10-16T09:00:00Z");
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

  async function row(
    accountId: string,
    iso: string,
    amountAgorot: bigint,
    name: string,
    options: { currency?: "ILS" | "USD"; native?: bigint; isTransfer?: boolean; deleted?: boolean } = {},
  ) {
    const currency = options.currency ?? "ILS";
    return admin.notableTransaction.create({
      data: {
        userId: owner.id,
        bankAccountId: accountId,
        categoryId,
        occurredAt: at(iso),
        currency,
        nativeAmount: options.native ?? amountAgorot,
        amount: amountAgorot,
        description: name,
        merchantName: name,
        isTransfer: options.isTransfer ?? false,
        deletedAt: options.deleted ? at("2026-10-14") : null,
      },
    });
  }

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    owner = await admin.user.create({ data: { email: `balances-owner-${stamp}@pfw.local`, displayName: "Balances Owner" } });
    stranger = await admin.user.create({ data: { email: `balances-stranger-${stamp}@pfw.local`, displayName: "Balances Stranger" } });
    categoryId = (await admin.category.create({ data: { userId: owner.id, slug: "misc", name: "Misc" } })).id;

    const account = (
      last4: string,
      accountType: "CHECKING" | "SAVINGS" | "CREDIT_CARD",
      nativeBalance: bigint,
      extra: { currency?: "ILS" | "USD"; balanceAsOf?: Date } = {},
    ) =>
      admin.bankAccount.create({
        data: { userId: owner.id, institutionName: "Test Bank", last4, accountType, nativeBalance, createdAt: at("2026-09-01"), ...extra },
      });

    // Checking: 10,000.00 typed as of Sep 30. Sep 29 and Sep 30 are already in it.
    checkingId = (await account("1111", "CHECKING", 1_000_000n, { balanceAsOf: new Date("2026-09-30T00:00:00Z") })).id;
    await row(checkingId, "2026-09-29", -50_000n, "Before the balance day");
    await row(checkingId, "2026-09-30", -70_000n, "On the balance day");
    await row(checkingId, "2026-10-01", -25_000n, "First day after");
    await row(checkingId, "2026-10-05", 100_000n, "Salary");
    await row(checkingId, "2026-10-06", -999_999n, "Mistake", { deleted: true });
    await row(checkingId, "2026-10-10", -200_000n, "To savings", { isTransfer: true });

    // Savings: 5,000.00 typed when the account was added (Sep 1), no balance day.
    savingsId = (await account("2222", "SAVINGS", 500_000n)).id;
    await row(savingsId, "2026-08-15", 12_345n, "Before the account existed");
    await row(savingsId, "2026-10-10", 200_000n, "From checking", { isTransfer: true });

    // Card: 1,000.00 owed. A charge of 500.00 and a payment of 300.00.
    cardId = (await account("3333", "CREDIT_CARD", 100_000n)).id;
    await row(cardId, "2026-10-12", -50_000n, "Card purchase");
    await row(cardId, "2026-10-13", 30_000n, "Card payment");

    // A dollar account: $1,000.00 typed on Sep 30.
    usdId = (await account("4444", "CHECKING", 100_000n, { currency: "USD", balanceAsOf: new Date("2026-09-30T00:00:00Z") })).id;
    // $200.00 spent, entered in dollars (the shekel amount is what it was worth that day).
    await row(usdId, "2026-10-08", -70_000n, "Dollar purchase", { currency: "USD", native: -20_000n });
    // A row entered in SHEKELS on the dollar account: no dollar amount of its own.
    await row(usdId, "2026-10-09", -35_000n, "Shekel row on a dollar account");
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } });
  });

  async function balances() {
    const [rows, rateTable] = await Promise.all([listAccountBalanceParts(owner.id), getLatestRateTable(asOf())]);
    const byId = new Map(rows.map(({ account, parts }) => [account.id, { parts, settled: settleBalance(parts, rateTable[parts.currency]) }]));
    return { byId, rateTable };
  }

  it("rolls a deposit account forward from the day AFTER its balance day, skipping deleted rows and counting transfers", async () => {
    const { byId } = await balances();
    // 1,000,000 − 25,000 + 100,000 − 200,000 (transfer out). Sep 29 and Sep 30 are already inside the typed figure; the deleted row never counts.
    expect(byId.get(checkingId)!.settled.currentNative).toBe(875_000);
  });

  it("starts an account with no balance day from when it was created", async () => {
    const { byId } = await balances();
    // 500,000 + 200,000 (transfer in). The August row predates the account.
    expect(byId.get(savingsId)!.settled.currentNative).toBe(700_000);
  });

  it("raises a card's debt on a charge and lowers it on a payment", async () => {
    const { byId } = await balances();
    // 100,000 owed + 50,000 charged − 30,000 paid.
    expect(byId.get(cardId)!.settled.currentNative).toBe(120_000);
  });

  it("keeps a dollar account in dollars, converting shekel rows at the latest rate", async () => {
    const { byId, rateTable } = await balances();
    const parts = byId.get(usdId)!.parts;
    expect(parts.sameCurrencyFlowNative).toBe(-20_000);
    expect(parts.otherCurrencyFlowAgorot).toBe(-35_000);
    const shekelRowInDollars = Math.round(-35_000 / rateTable.USD);
    expect(Math.abs(Number(byId.get(usdId)!.settled.currentNative) - (100_000 - 20_000 + shekelRowInDollars))).toBeLessThanOrEqual(1);
  });

  it("net worth reads the same balances: bank assets and card debt both match", async () => {
    const { byId, rateTable } = await balances();
    const worth = await computeLiveNetWorth(owner.id, asOf());
    let assets = 0;
    let owed = 0;
    for (const { parts } of byId.values()) {
      const value = Number(currentBalanceAgorot(parts, rateTable[parts.currency]));
      if (parts.accountType === "CREDIT_CARD") owed += value;
      else assets += value;
    }
    expect(Number(worth.breakdown.bankAccounts)).toBe(assets);
    expect(Number(worth.breakdown.debts)).toBe(owed);
  });

  it("Safe to Spend's cash is the same figure net worth holds in bank accounts", async () => {
    const worth = await computeLiveNetWorth(owner.id, asOf());
    const safe = await buildSafeToSpendData(owner.id, asOf());
    // Savings are counted by default, so cash is every non-card account.
    expect(Number(safe.cashAgorot)).toBe(Number(worth.breakdown.bankAccounts));
    expect(Number(safe.cardOwedAgorot)).toBe(Number(worth.breakdown.debts));
  });

  it("an overpaid card is a credit in net worth but still owes zero to Safe to Spend", async () => {
    const overpaid = await admin.bankAccount.create({
      data: { userId: owner.id, institutionName: "Test Bank", last4: "5555", accountType: "CREDIT_CARD", nativeBalance: 10_000n, createdAt: at("2026-09-01") },
    });
    await row(overpaid.id, "2026-10-14", 60_000n, "Refund and overpayment");
    const before = await computeLiveNetWorth(owner.id, asOf());
    const safe = await buildSafeToSpendData(owner.id, asOf());
    // 10,000 owed − 60,000 paid = −50,000: a credit, so liabilities drop by 50,000 beyond the other card's 120,000.
    expect(Number(before.breakdown.debts)).toBe(120_000 - 50_000);
    // Safe to Spend never treats a credit as spendable cash.
    expect(Number(safe.cardOwedAgorot)).toBe(120_000);
    await admin.notableTransaction.deleteMany({ where: { bankAccountId: overpaid.id } });
    await admin.bankAccount.delete({ where: { id: overpaid.id } });
  });

  it("another user sees none of these accounts", async () => {
    expect(await listAccountBalanceParts(stranger.id)).toEqual([]);
    const worth = await computeLiveNetWorth(stranger.id, asOf());
    expect(Number(worth.breakdown.bankAccounts)).toBe(0);
  });

  it("changes when a new transaction arrives, which is the whole point", async () => {
    const before = await computeLiveNetWorth(owner.id, asOf());
    const added = await row(checkingId, "2026-10-14", -40_000n, "Imported later");
    const after = await computeLiveNetWorth(owner.id, asOf());
    expect(Number(after.breakdown.bankAccounts)).toBe(Number(before.breakdown.bankAccounts) - 40_000);
    await admin.notableTransaction.delete({ where: { id: added.id } });
  });

  it("matches the arithmetic done by hand for a shekel account", () => {
    // The pure rule, with the same numbers as the checking account above.
    const settled = settleBalance(
      { accountType: "CHECKING", currency: "ILS", typedNative: 1_000_000, sameCurrencyFlowNative: -25_000 + 100_000 - 200_000, otherCurrencyFlowAgorot: 0 },
      1,
    );
    expect(settled.currentNative).toBe(875_000);
    expect(convertNativeAmountToAgorot(nativeAmount(875_000), "ILS", 1)).toBe(875_000);
  });
});
