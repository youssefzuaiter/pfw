import { Badge, type BadgeVariant } from "../../components/badge/badge";
import { CurrencyAmount } from "../../components/currency/currency-amount";
import { deriveValuationFreshness, type ValuationFreshness } from "../../lib/valuation-freshness";
import { currentBalanceAgorot, describeBalanceHistory, settleBalance } from "../../lib/account-balance";
import { agorot } from "../../lib/money";
import { buildWalletBalances } from "../../server/crypto/build-wallet-balances";
import { getCurrentUser } from "../../server/auth/current-user";
import { getReportingFormatter } from "../../server/reporting/reporting-context";
import { ReportingRateNote } from "../../components/currency/reporting-currency-provider";
import { listAccountBalanceParts } from "../../server/dal/account-balances";
import { getLatestRateTable } from "../../server/dal/exchange-rates";
import { listManualAssets } from "../../server/dal/manual-assets";
import { AddWalletForm } from "./_components/add-wallet-form";
import { CreateAssetForm } from "./_components/create-asset-form";
import { CreateBankAccountForm } from "./_components/create-bank-account-form";
import { CheckBalanceForm } from "./_components/check-balance-form";
import { ReconcileBalanceForm } from "./_components/reconcile-balance-form";
import { DeleteAssetButton } from "./_components/delete-asset-button";
import { UpdateValuationForm } from "./_components/update-valuation-form";
import { WalletBalanceRow } from "./_components/wallet-balance-row";

const BANK_ACCOUNT_TYPE_LABEL: Record<string, string> = {
  CHECKING: "Checking",
  SAVINGS: "Savings",
  CREDIT_CARD: "Credit card",
};

export const instant = false;

const ASSET_TYPE_LABEL: Record<string, string> = {
  PROPERTY: "Property",
  VEHICLE: "Vehicle",
  CRYPTO: "Crypto",
  PENSION: "Pension",
  KEREN_HISHTALMUT: "Keren Hishtalmut",
  OTHER: "Other",
};

const FRESHNESS_LABEL: Record<ValuationFreshness, string> = {
  fresh: "Fresh",
  aging: "Aging",
  stale: "Stale",
};

const FRESHNESS_VARIANT: Record<ValuationFreshness, BadgeVariant> = {
  fresh: "positive",
  aging: "warning",
  stale: "critical",
};

export default async function AssetsPage() {
  const user = await getCurrentUser();
  const formatMoney = await getReportingFormatter(user.id);
  const [assets, walletBalances, bankAccounts, rateTable] = await Promise.all([
    listManualAssets(user.id),
    buildWalletBalances(user.id),
    listAccountBalanceParts(user.id),
    getLatestRateTable(),
  ]);
  const now = new Date();

  const totalValue = assets.reduce((sum, asset) => sum + asset.currentValue, 0n);

  // What each account holds NOW: the balance the user typed, rolled forward by
  // the transactions recorded since (`src/lib/account-balance.ts`, the same
  // figure net worth and Safe to Spend use). The shekel equivalent is a live
  // conversion at the latest synced rate, never stored (law #5).
  const bankAccountsWithIls = bankAccounts.map(({ account, parts }) => {
    const rate = rateTable[parts.currency];
    const settled = settleBalance(parts, rate);
    return {
      ...account,
      agorotValue: currentBalanceAgorot(parts, rate),
      currentNative: settled.currentNative,
      history: describeBalanceHistory({
        accountType: account.accountType,
        currency: account.currency,
        typedNative: parts.typedNative,
        changeNative: settled.changeNative,
        balanceAsOf: account.balanceAsOf,
      }),
    };
  });
  const bankAssetsTotal = bankAccountsWithIls
    .filter((a) => a.accountType !== "CREDIT_CARD")
    .reduce((sum, a) => sum + Number(a.agorotValue), 0);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-4 md:px-6">
      <h1 className="font-display text-xl font-semibold text-fg">Assets</h1>
      <ReportingRateNote />

      <section aria-labelledby="bank-accounts-heading" className="flex flex-col gap-4">
        <div>
          <h2
            id="bank-accounts-heading"
            className="font-display text-sm font-semibold uppercase tracking-wide text-muted"
          >
            Bank Accounts
          </h2>
          <p className="mt-1 text-sm text-muted">
            Each balance is the figure you entered plus the transactions recorded since, not a live bank connection
            (unless it came from Settings → Open Banking). Compare it with your bank, and use Update balance if it is off.
          </p>
        </div>

        {bankAccountsWithIls.length > 0 && (
          <p className="font-tabular-figures tracking-tight text-sm text-muted">
            Total tracked balance: <span className="text-fg">{formatMoney(agorot(bankAssetsTotal))}</span>
          </p>
        )}

        <div className="rounded-lg border border-border bg-surface p-4">
          <CreateBankAccountForm />
        </div>

        {bankAccountsWithIls.length === 0 && (
          <p className="text-sm text-muted">No bank accounts tracked yet — add one above.</p>
        )}

        <ul className="flex flex-col gap-3">
          {bankAccountsWithIls.map((account) => (
            <li key={account.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-fg">
                    {account.nickname ?? account.institutionName}{" "}
                    <span className="text-xs text-muted">
                      ({account.institutionName} ••{account.last4} — {BANK_ACCOUNT_TYPE_LABEL[account.accountType]})
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {account.history}
                  </p>
                  <div className="mt-2 flex flex-col gap-2">
                    <div className="flex flex-wrap gap-2">
                      <CheckBalanceForm accountId={account.id} isCard={account.accountType === "CREDIT_CARD"} currency={account.currency} />
                      <ReconcileBalanceForm accountId={account.id} isCard={account.accountType === "CREDIT_CARD"} />
                    </div>
                  </div>
                </div>
                <CurrencyAmount
                  agorotValue={account.agorotValue}
                  nativeValue={account.currentNative}
                  currency={account.currency}
                  primaryClassName="font-tabular-figures tracking-tight text-sm text-fg"
                  secondaryClassName="font-tabular-figures tracking-tight text-xs text-muted"
                />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="manual-assets-heading" className="flex flex-col gap-4 border-t border-border pt-4">
        <div>
          <h2
            id="manual-assets-heading"
            className="font-display text-sm font-semibold uppercase tracking-wide text-muted"
          >
            Manual Assets
          </h2>
        </div>

        {assets.length > 0 && (
          <p className="font-tabular-figures tracking-tight text-sm text-muted">
            Total tracked value: <span className="text-fg">{formatMoney(agorot(Number(totalValue)))}</span>
          </p>
        )}

        <div className="rounded-lg border border-border bg-surface p-4">
          <CreateAssetForm />
        </div>

        {assets.length === 0 && <p className="text-sm text-muted">No manual assets tracked yet — add one above.</p>}

        <ul className="flex flex-col gap-4">
          {assets.map((asset) => {
            const freshness = deriveValuationFreshness(asset.valuedAt, now);
            return (
              <li key={asset.id} className="rounded-lg border border-border bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-fg">
                      {asset.name}{" "}
                      <span className="text-xs text-muted">({ASSET_TYPE_LABEL[asset.assetType]})</span>
                      {asset.taxAdvantaged && (
                        <span className="ml-2">
                          <Badge variant="neutral">Tax-advantaged</Badge>
                        </span>
                      )}
                    </p>
                    <p className="font-tabular-figures tracking-tight text-sm text-muted">
                      {formatMoney(agorot(Number(asset.currentValue)))}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Badge variant={FRESHNESS_VARIANT[freshness]} pulse={freshness === "stale"}>
                      {FRESHNESS_LABEL[freshness]}
                    </Badge>
                    <DeleteAssetButton assetId={asset.id} assetName={asset.name} />
                  </div>
                </div>

                <p className="mt-2 text-xs text-muted">Last valued {asset.valuedAt.toISOString().slice(0, 10)}</p>

                <div className="mt-3">
                  <UpdateValuationForm assetId={asset.id} />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="crypto-wallets-heading" className="flex flex-col gap-4 border-t border-border pt-4">
        <div>
          <h2 id="crypto-wallets-heading" className="font-display text-sm font-semibold uppercase tracking-wide text-muted">
            Crypto Wallets
          </h2>
          <p className="mt-1 text-sm text-muted">
            Track public wallet addresses — live balances fetched from a public Ethereum RPC endpoint, read-only, no
            private key ever involved.
          </p>
        </div>

        {walletBalances.wallets.length > 0 && (
          <p className="font-tabular-figures tracking-tight text-sm text-muted">
            Total tracked value: <span className="text-fg">{formatMoney(walletBalances.totalValueAgorot)}</span>
          </p>
        )}

        <div className="rounded-lg border border-border bg-surface p-4">
          <AddWalletForm />
        </div>

        {walletBalances.wallets.length === 0 && (
          <p className="text-sm text-muted">No wallets tracked yet — add one above.</p>
        )}

        <ul className="flex flex-col gap-4">
          {walletBalances.wallets.map((wallet) => (
            <WalletBalanceRow
              key={wallet.id}
              id={wallet.id}
              address={wallet.address}
              label={wallet.label}
              chainId={wallet.chainId}
              balanceWei={wallet.balanceWei !== null ? wallet.balanceWei.toString() : null}
              valueAgorot={Number(wallet.valueAgorot)}
              stakingYieldBps={wallet.stakingYieldBps}
              cumulativeGasFeesWei={wallet.cumulativeGasFeesWei !== null ? wallet.cumulativeGasFeesWei.toString() : null}
              rpcError={wallet.rpcError}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}
