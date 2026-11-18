import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agorot } from "../../src/lib/money";
import { nativeAmount } from "../../src/lib/currency";
import { createAdminClient } from "../../src/server/db/admin-client";
import { computeLiveNetWorth } from "../../src/server/dal/net-worth";
import { recordPendingPaperTrade, settlePaperTradeReceipt, type PaperTradeReceiptInput } from "../../src/server/dal/paper-trades";
import { executeTrade, listPortfolioHoldings } from "../../src/server/dal/portfolio";
import { getMonthlyIncomeExpenseHistory, getSpendByCategoryInRange, listTransactions } from "../../src/server/dal/transactions";
import { checkAccountBalance } from "../../src/server/dal/balance-check";
import { flagExistingPaperRows } from "../../src/server/paper-trader/flag-existing-paper-rows";
import { buildTaxSimulation } from "../../src/server/tax/build-tax-data";
import { DE_DEFAULT_ANNUAL_ALLOWANCE_AGOROT } from "../../src/lib/tax-rules";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * Paper-trader money is practice money (AGENTS.md §3pppp). It must never move
 * a real balance, count in net worth, or show up as income or spending, while
 * still being visible where it belongs: the ledger list and the trading screens.
 *
 * Found by a design review of the live site: the trader's TSLA position was
 * inside real net worth, and each paper BUY lowered the real QNB USD balance.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("paper-trader money stays out of real totals", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userId: string;
  let accountId: string;
  const stamp = Date.now();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const extraUserIds: string[] = [];
  let realPortfolioValue = 0;

  function receipt(key: string, symbol: string, quantity: number): PaperTradeReceiptInput {
    return {
      idempotencyKey: key,
      orderId: `order-${key}`,
      symbol,
      side: "BUY",
      quantity,
      priceAgorot: agorot(37_000),
      nativePriceAmount: nativeAmount(10_000),
      currency: "USD",
      exchangeRate: 3.7,
      executedAt: new Date(),
      headline: "Paper headline",
    };
  }

  beforeAll(async () => {
    admin = createAdminClient();
    const user = await admin.user.create({ data: { email: `paper-sep-${stamp}@pfw.local`, displayName: "Paper Separation Test" } });
    userId = user.id;
    const account = await admin.bankAccount.create({
      data: {
        userId,
        institutionName: "QNB Test",
        last4: "0001",
        accountType: "CHECKING",
        currency: "USD",
        nativeBalance: 100_000n,
        balanceAsOf: new Date(Date.UTC(2020, 0, 1)),
      },
    });
    accountId = account.id;
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [userId, ...extraUserIds]);
    await admin.$disconnect();
  });

  it("a paper fill leaves net worth, cash and every spending total exactly as they were", async () => {
    // A simulated-desk position in GOOGL, so the paper fill below has a same-ticker real one to be kept apart from.
    const desk = await executeTrade(userId, {
      symbol: "GOOGL",
      side: "BUY",
      quantity: 2,
      priceAgorot: agorot(37_000),
      nativePriceAmount: nativeAmount(10_000),
      currency: "USD",
      exchangeRate: 3.7,
      executedAt: new Date(),
      idempotencyKey: `desk-${stamp}`,
    });
    expect(desk.ok).toBe(true);

    const before = await computeLiveNetWorth(userId);
    const incomeBefore = await getMonthlyIncomeExpenseHistory(userId, monthStart, nextMonthStart);

    const paperGoogl = await settlePaperTradeReceipt(userId, receipt(`paper-googl-${stamp}`, "GOOGL", 1));
    const paperTsla = await settlePaperTradeReceipt(userId, receipt(`paper-tsla-${stamp}`, "TSLA", 1));
    expect(paperGoogl.status).toBe("recorded");
    expect(paperTsla.status).toBe("recorded");

    const after = await computeLiveNetWorth(userId);
    realPortfolioValue = after.breakdown.portfolio;
    expect(after.netWorth).toBe(before.netWorth);
    expect(after.breakdown.portfolio).toBe(before.breakdown.portfolio);
    expect(after.breakdown.bankAccounts).toBe(before.breakdown.bankAccounts);
    expect(after.liquidity.liquidAgorot).toBe(before.liquidity.liquidAgorot);

    expect(await getMonthlyIncomeExpenseHistory(userId, monthStart, nextMonthStart)).toEqual(incomeBefore);
    const paperCategory = await admin.category.findFirstOrThrow({ where: { userId, slug: "paper-trading" } });
    const spend = await getSpendByCategoryInRange(userId, monthStart, nextMonthStart);
    expect(spend.find((s) => s.categoryId === paperCategory.id)).toBeUndefined();
  });

  it("a paper position is its own holding, even in a ticker the simulated desk also holds", async () => {
    const real = await listPortfolioHoldings(userId);
    expect(real.map((h) => h.symbol)).toEqual(["GOOGL"]);
    expect(real[0].isPaper).toBe(false);
    expect(real[0].quantity.toNumber()).toBe(2);

    const all = await listPortfolioHoldings(userId, { includePaper: true });
    expect(all.map((h) => `${h.symbol}:${h.isPaper}`).sort()).toEqual(["GOOGL:false", "GOOGL:true", "TSLA:true"]);
    expect(all.find((h) => h.symbol === "GOOGL" && h.isPaper)?.quantity.toNumber()).toBe(1);
  });

  it("the normal two-step path (pending receipt, then settled) also lands in one paper holding", async () => {
    const key = `paper-nvda-${stamp}`;
    expect((await recordPendingPaperTrade(userId, receipt(key, "NVDA", 1))).status).toBe("recorded");
    const pendingOnly = await admin.portfolioHolding.findMany({ where: { userId, symbol: "NVDA" } });
    expect(pendingOnly.map((h) => h.isPaper)).toEqual([true]);

    expect((await settlePaperTradeReceipt(userId, receipt(key, "NVDA", 1))).status).toBe("recorded");
    const holdings = await admin.portfolioHolding.findMany({ where: { userId, symbol: "NVDA" } });
    expect(holdings).toHaveLength(1);
    expect(holdings[0].isPaper).toBe(true);
    expect(holdings[0].quantity.toNumber()).toBe(1);
    expect((await computeLiveNetWorth(userId)).breakdown.portfolio).toBe(realPortfolioValue);
  });

  it("the paper ledger rows are flagged, still listed, and do not count toward the balance check", async () => {
    const rows = await admin.notableTransaction.findMany({ where: { userId } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.isPaper)).toBe(true);

    const listed = await listTransactions(userId, {});
    expect(listed.length).toBe(3);

    const check = await checkAccountBalance(userId, accountId, { day: new Date(), bankNative: 100_000 });
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.result.status).toBe("matches");
  });

  it("the tax simulator sees a paper-bought ticker the mock feed cannot price", async () => {
    const data = await buildTaxSimulation(userId, "FIFO", "DE", agorot(0), false, 0, DE_DEFAULT_ANNUAL_ALLOWANCE_AGOROT, 0.2, new Date());
    const tsla = data.openLots.filter((lot) => lot.symbol === "TSLA");
    expect(tsla).toHaveLength(1);
    expect(tsla[0].quantity).toBe(1);
    expect(tsla[0].symbolName).toBe("TSLA");
    expect(tsla[0].currentValueAgorot).toBeGreaterThan(0);
  });

  describe("flagging rows that existed before the flag did", () => {
    async function legacyUser(label: string) {
      const user = await admin.user.create({ data: { email: `paper-sep-${label}-${stamp}@pfw.local`, displayName: label } });
      extraUserIds.push(user.id);
      const account = await admin.bankAccount.create({
        data: { userId: user.id, institutionName: "T", last4: "0002", accountType: "CHECKING", currency: "USD", nativeBalance: 0n },
      });
      const category = await admin.category.create({ data: { userId: user.id, name: "Paper Trading", slug: "paper-trading" } });
      return { userId: user.id, accountId: account.id, categoryId: category.id };
    }

    it("flags a legacy paper ledger row and holding, and leaves a desk position alone", async () => {
      const u = await legacyUser("legacy");
      const tsla = await admin.portfolioHolding.create({
        data: { userId: u.userId, symbol: "TSLA", currency: "USD", quantity: "1", totalCostBasis: 100n, nativeCostBasis: 30n },
      });
      await admin.holdingLot.create({ data: { userId: u.userId, holdingId: tsla.id, quantity: "1", costBasis: 100n, acquiredAt: new Date() } });
      await admin.notableTransaction.create({
        data: {
          userId: u.userId, bankAccountId: u.accountId, categoryId: u.categoryId, providerTransactionId: "paper-trade:legacy-key",
          occurredAt: new Date(), currency: "USD", amount: -100n, nativeAmount: -30n, description: "BUY 1 TSLA", merchantName: "Paper Trading — TSLA",
        },
      });
      const aapl = await admin.portfolioHolding.create({
        data: { userId: u.userId, symbol: "AAPL", currency: "USD", quantity: "1", totalCostBasis: 100n, nativeCostBasis: 30n },
      });
      await admin.trade.create({
        data: {
          userId: u.userId, portfolioHoldingId: aapl.id, symbol: "AAPL", side: "BUY", currency: "USD", quantity: "1", priceAgorot: 100n, totalAgorot: 100n,
          nativePriceAmount: 30n, nativeTotalAmount: 30n, exchangeRateAtEntry: "3.5", executedAt: new Date(), idempotencyKey: "desk-legacy", status: "SETTLED",
        },
      });

      const result = await flagExistingPaperRows();
      expect(result.ok).toBe(true);

      expect((await admin.portfolioHolding.findUniqueOrThrow({ where: { id: tsla.id } })).isPaper).toBe(true);
      expect((await admin.portfolioHolding.findUniqueOrThrow({ where: { id: aapl.id } })).isPaper).toBe(false);
      expect((await admin.notableTransaction.findFirstOrThrow({ where: { userId: u.userId } })).isPaper).toBe(true);

      const again = await flagExistingPaperRows();
      expect(again.ok && again.holdingsFlagged === 0 && again.transactionsFlagged === 0).toBe(true);
    });

    it("a pending-only holding is a paper position, because only the paper path creates pending trades", async () => {
      const u = await legacyUser("pending");
      const nvda = await admin.portfolioHolding.create({
        data: { userId: u.userId, symbol: "NVDA", currency: "USD", quantity: "0", totalCostBasis: 0n, nativeCostBasis: 0n },
      });
      await admin.trade.create({
        data: {
          userId: u.userId, portfolioHoldingId: nvda.id, symbol: "NVDA", side: "BUY", currency: "USD", quantity: "1", priceAgorot: 100n, totalAgorot: 100n,
          nativePriceAmount: 30n, nativeTotalAmount: 30n, exchangeRateAtEntry: "3.5", executedAt: new Date(), idempotencyKey: "pending-legacy", status: "PENDING",
        },
      });
      await flagExistingPaperRows();
      expect((await admin.portfolioHolding.findUniqueOrThrow({ where: { id: nvda.id } })).isPaper).toBe(true);
    });

    it("leaves a split position alone and says so: a legacy paper holding next to a new paper one in the same ticker", async () => {
      const u = await legacyUser("conflict");
      const legacy = await admin.portfolioHolding.create({
        data: { userId: u.userId, symbol: "TSLA", currency: "USD", quantity: "1", totalCostBasis: 100n, nativeCostBasis: 30n },
      });
      await admin.holdingLot.create({ data: { userId: u.userId, holdingId: legacy.id, quantity: "1", costBasis: 100n, acquiredAt: new Date() } });
      const fresh = await admin.portfolioHolding.create({
        data: { userId: u.userId, symbol: "TSLA", currency: "USD", isPaper: true, quantity: "2", totalCostBasis: 200n, nativeCostBasis: 60n },
      });

      const result = await flagExistingPaperRows();
      expect(result.ok && result.conflicts).toBeGreaterThanOrEqual(1);
      expect((await admin.portfolioHolding.findUniqueOrThrow({ where: { id: legacy.id } })).isPaper).toBe(false);
      expect((await admin.portfolioHolding.findUniqueOrThrow({ where: { id: fresh.id } })).isPaper).toBe(true);
    });
  });
});
