import "server-only";
import { addAgorot, agorot, multiplyAgorot, subtractAgorot, type Agorot } from "../../lib/money";
import { nativeAmount } from "../../lib/currency";
import { convertNativeAmountToAgorot } from "../../lib/exchange-rate";
import { classifyLiquidity, type LiquidityBreakdown } from "../../lib/liquidity-classification";
import { getMockPriceAgorot } from "../../lib/mock-market-data";
import { buildWalletBalances } from "../crypto/build-wallet-balances";
import { withUserScope } from "../db/with-user-scope";
import { getLatestRateTable } from "./exchange-rates";

export type LiveNetWorth = {
  totalAssets: Agorot;
  totalLiabilities: Agorot;
  netWorth: Agorot;
  breakdown: {
    bankAccounts: Agorot;
    manualAssets: Agorot;
    portfolio: Agorot;
    /** Live on-chain wallet balances (AGENTS.md §3w) — kept as its own line rather than folded into `portfolio` (the simulated trading desk): a wallet balance is externally observed, never bought/sold through this app's own `Trade` model, so conflating the two would misrepresent where the figure actually came from. */
    cryptoWallets: Agorot;
    debts: Agorot;
  };
  /** The Real-Time Liquidity Runway & Burn-Rate Engine's asset classification (AGENTS.md §3v) — computed from the SAME already-fetched rows as `breakdown` above, purely additive, so this costs no extra database round trip. */
  liquidity: LiquidityBreakdown;
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
 *
 * A foreign-currency account's ILS value is computed here, live, from
 * the latest synced rate — never read from a stored column, because a
 * live balance's base-currency value moves with the FX rate and a stored
 * mirror would be stale the moment rates changed (AGENTS.md law #5, and
 * BankAccount's own schema comment).
 */
export async function computeLiveNetWorth(userId: string, asOf: Date = new Date()): Promise<LiveNetWorth> {
  const [rateTable, [accounts, assets, holdings, debts], walletBalances] = await Promise.all([
    getLatestRateTable(asOf),
    withUserScope(userId, (tx) =>
      Promise.all([
        tx.bankAccount.findMany({ where: { userId } }),
        tx.manualAsset.findMany({ where: { userId } }),
        tx.portfolioHolding.findMany({ where: { userId } }),
        tx.debt.findMany({ where: { userId } }),
      ]),
    ),
    // Runs in parallel with everything else above — a user with no
    // tracked wallets (the common case; nothing seeds one by default)
    // resolves this near-instantly (an empty findMany + one cached
    // price-table read), and a user WITH wallets is still bounded by
    // build-wallet-balances.ts's own per-wallet RPC timeout, not this
    // function's own logic.
    buildWalletBalances(userId),
  ]);

  const toAgorot = (balance: bigint, currency: keyof typeof rateTable) =>
    convertNativeAmountToAgorot(nativeAmount(Number(balance)), currency, rateTable[currency]);

  const bankAssetRows = accounts
    .filter((a) => a.accountType !== "CREDIT_CARD")
    .map((a) => ({ accountType: a.accountType, valueAgorot: toAgorot(a.nativeBalance, a.currency) }));
  const bankAssetAmounts = bankAssetRows.map((r) => r.valueAgorot);
  const bankLiabilityAmounts = accounts
    .filter((a) => a.accountType === "CREDIT_CARD")
    .map((a) => toAgorot(a.nativeBalance, a.currency));
  const manualAssetAmounts = assets.map((a) => agorot(Number(a.currentValue)));
  const portfolioAmounts = holdings.map((h) =>
    multiplyAgorot(getMockPriceAgorot(h.symbol, asOf, rateTable.USD), h.quantity.toNumber()),
  );
  const debtAmounts = debts.map((d) => agorot(Number(d.currentBalance)));

  const bankAccountsTotal = addAgorot(...bankAssetAmounts);
  const manualAssetsTotal = addAgorot(...manualAssetAmounts);
  const portfolioTotal = addAgorot(...portfolioAmounts);
  const cryptoWalletsTotal = walletBalances.totalValueAgorot;
  const debtsTotal = addAgorot(...bankLiabilityAmounts, ...debtAmounts);

  const totalAssets = addAgorot(bankAccountsTotal, manualAssetsTotal, portfolioTotal, cryptoWalletsTotal);
  const totalLiabilities = debtsTotal;

  const liquidity = classifyLiquidity(
    bankAssetRows,
    assets.map((a) => ({
      assetType: a.assetType,
      liquidityTierOverride: a.liquidityTier,
      valueAgorot: agorot(Number(a.currentValue)),
    })),
    portfolioAmounts.map((valueAgorot) => ({ valueAgorot })),
    walletBalances.wallets.map((w) => ({ valueAgorot: w.valueAgorot })),
  );

  return {
    totalAssets,
    totalLiabilities,
    netWorth: subtractAgorot(totalAssets, totalLiabilities),
    breakdown: {
      bankAccounts: bankAccountsTotal,
      manualAssets: manualAssetsTotal,
      portfolio: portfolioTotal,
      cryptoWallets: cryptoWalletsTotal,
      debts: debtsTotal,
    },
    liquidity,
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
