import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { agorot } from "../../src/lib/money";
import { nativeAmount } from "../../src/lib/currency";
import { recordPendingPaperTrade, settlePaperTradeReceipt, type PaperTradeReceiptInput } from "../../src/server/dal/paper-trades";
import { settleWithRaceRetry } from "../../src/server/paper-trader/settle-with-race-retry";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * The pending/settled two-phase receipt flow, against real Postgres —
 * and specifically the ordering RACE found live (trader integration
 * hardening, ad hoc): Alpaca fills a paper order within milliseconds
 * and the trader's settlement stream is an independent task, so the
 * "settled" receipt can reach PFW before the "pending" one has
 * committed. Three of four real trades in one evening were stranded
 * `PENDING` by exactly that, while the route answered 200 for each.
 * There were no tests for this path at all before this file.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("paper-trade receipts: pending → settled, in any order", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userId: string;

  function receipt(key: string): PaperTradeReceiptInput {
    return {
      idempotencyKey: key,
      orderId: `order-${key}`,
      symbol: "TSLA",
      side: "BUY",
      quantity: 0.021774068,
      priceAgorot: agorot(108478),
      nativePriceAmount: nativeAmount(36491),
      currency: "USD",
      exchangeRate: 2.97274,
      executedAt: new Date(),
      headline: "TSLA soars on blowout deliveries",
    };
  }

  beforeAll(async () => {
    admin = createAdminClient();
    const user = await admin.user.create({
      data: { email: `paper-trade-settlement-${Date.now()}@pfw.local`, displayName: "Settlement Race Test" },
    });
    userId = user.id;
    // The ledger booking needs an account to debit.
    await admin.bankAccount.create({
      data: { userId, institutionName: "Test Bank", last4: "0001", accountType: "CHECKING", nativeBalance: 10_000_000n },
    });
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [userId]);
    await admin.$disconnect();
  });

  async function tradeStatus(key: string) {
    const trade = await admin.trade.findFirst({ where: { userId, idempotencyKey: key }, select: { status: true } });
    const ledgerRows = await admin.notableTransaction.count({ where: { userId, providerTransactionId: `paper-trade:${key}` } });
    return { status: trade?.status ?? null, ledgerRows };
  }

  it("the normal order: pending then settled → SETTLED with exactly one ledger row", async () => {
    const key = `it-settle-normal-${Date.now()}`;
    expect((await recordPendingPaperTrade(userId, receipt(key))).status).toBe("recorded");
    expect((await tradeStatus(key)).status).toBe("PENDING");

    const settled = await settlePaperTradeReceipt(userId, receipt(key));
    expect(settled.status).toBe("recorded");
    expect(await tradeStatus(key)).toEqual({ status: "SETTLED", ledgerRows: 1 });
  });

  it("the reverse order: settled first, then a late pending receipt → stays SETTLED, pending is a duplicate", async () => {
    const key = `it-settle-reverse-${Date.now()}`;
    expect((await settlePaperTradeReceipt(userId, receipt(key))).status).toBe("recorded");
    expect((await tradeStatus(key)).status).toBe("SETTLED");

    expect((await recordPendingPaperTrade(userId, receipt(key))).status).toBe("duplicate");
    expect(await tradeStatus(key)).toEqual({ status: "SETTLED", ledgerRows: 1 });
  });

  it("a settlement redelivered after settling is a duplicate, never a second ledger row", async () => {
    const key = `it-settle-redeliver-${Date.now()}`;
    await recordPendingPaperTrade(userId, receipt(key));
    await settlePaperTradeReceipt(userId, receipt(key));
    expect((await settlePaperTradeReceipt(userId, receipt(key))).status).toBe("duplicate");
    expect(await tradeStatus(key)).toEqual({ status: "SETTLED", ledgerRows: 1 });
  });

  it("the live race: pending and settled arriving concurrently always ends SETTLED (never stranded)", async () => {
    // Nondeterministic by nature — run it several times. Before the fix,
    // whichever interleaving hit P2002 on the settle side was answered
    // "duplicate" and the trade stayed PENDING with no ledger row.
    for (let round = 0; round < 6; round++) {
      const key = `it-settle-race-${Date.now()}-${round}`;
      const [pending, settled] = await Promise.all([
        recordPendingPaperTrade(userId, receipt(key)),
        settleWithRaceRetry(userId, receipt(key)),
      ]);
      expect(["recorded", "duplicate"]).toContain(pending.status);
      expect(["recorded", "duplicate"]).toContain(settled.status);
      expect(await tradeStatus(key)).toEqual({ status: "SETTLED", ledgerRows: 1 });
    }
  });
});
