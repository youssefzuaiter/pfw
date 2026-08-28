import "server-only";
import { addAgorot, agorot, multiplyAgorot, subtractAgorot, type Agorot } from "../../lib/money";
import { getMockPriceAgorot } from "../../lib/mock-market-data";
import { withUserScope } from "../db/with-user-scope";

export type LiveNetWorth = {
  totalAssets: Agorot;
  totalLiabilities: Agorot;
  netWorth: Agorot;
  breakdown: {
    bankAccounts: Agorot;
    manualAssets: Agorot;
    portfolio: Agorot;
    debts: Agorot;
  };
};

/**
 * Computes net worth live from current data — this is never read from
 * `NetWorthSnapshot`, which is historical-only (see that model's doc
 * comment in schema.prisma; the "derived truth" law). Every read happens
 * inside one transaction so the figure is internally consistent — no
 * risk of, say, an account balance and a holding value coming from two
 * different moments in time.
 *
 * Bank accounts: checking/savings are assets; a credit-card balance is
 * stored positive = money owed, so it's a liability, not a negative
 * asset — `accountType` is what distinguishes them. Portfolio holdings
 * are valued at the mock "current price" (src/lib/mock-market-data.ts),
 * not their cost basis, so unrealized gains/losses show up here the same
 * way they would for a real brokerage account.
 */
export async function computeLiveNetWorth(userId: string, asOf: Date = new Date()): Promise<LiveNetWorth> {
  const [accounts, assets, holdings, debts] = await withUserScope(userId, (tx) =>
    Promise.all([
      tx.bankAccount.findMany({ where: { userId } }),
      tx.manualAsset.findMany({ where: { userId } }),
      tx.portfolioHolding.findMany({ where: { userId } }),
      tx.debt.findMany({ where: { userId } }),
    ]),
  );

  const bankAssetAmounts = accounts
    .filter((a) => a.accountType !== "CREDIT_CARD")
    .map((a) => agorot(Number(a.currentBalance)));
  const bankLiabilityAmounts = accounts
    .filter((a) => a.accountType === "CREDIT_CARD")
    .map((a) => agorot(Number(a.currentBalance)));
  const manualAssetAmounts = assets.map((a) => agorot(Number(a.currentValue)));
  const portfolioAmounts = holdings.map((h) =>
    multiplyAgorot(getMockPriceAgorot(h.symbol, asOf), h.quantity.toNumber()),
  );
  const debtAmounts = debts.map((d) => agorot(Number(d.currentBalance)));

  const bankAccountsTotal = addAgorot(...bankAssetAmounts);
  const manualAssetsTotal = addAgorot(...manualAssetAmounts);
  const portfolioTotal = addAgorot(...portfolioAmounts);
  const debtsTotal = addAgorot(...bankLiabilityAmounts, ...debtAmounts);

  const totalAssets = addAgorot(bankAccountsTotal, manualAssetsTotal, portfolioTotal);
  const totalLiabilities = debtsTotal;

  return {
    totalAssets,
    totalLiabilities,
    netWorth: subtractAgorot(totalAssets, totalLiabilities),
    breakdown: {
      bankAccounts: bankAccountsTotal,
      manualAssets: manualAssetsTotal,
      portfolio: portfolioTotal,
      debts: debtsTotal,
    },
  };
}

/** Historical daily snapshots for the dashboard's net-worth sparkline — never "today" (see above). */
export async function getNetWorthHistory(userId: string, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withUserScope(userId, (tx) =>
    tx.netWorthSnapshot.findMany({
      where: { userId, snapshotDate: { gte: since } },
      orderBy: { snapshotDate: "asc" },
    }),
  );
}
