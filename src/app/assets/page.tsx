import { Badge, type BadgeVariant } from "../../components/badge/badge";
import { CurrencyAmount } from "../../components/currency/currency-amount";
import { deriveValuationFreshness, type ValuationFreshness } from "../../lib/valuation-freshness";
import { nativeAmount } from "../../lib/currency";
import { convertNativeAmountToAgorot } from "../../lib/exchange-rate";
import { agorot, formatAgorot } from "../../lib/money";
import { buildWalletBalances } from "../../server/crypto/build-wallet-balances";
import { getCurrentUser } from "../../server/auth/current-user";
import { listBankAccounts } from "../../server/dal/bank-accounts";
import { getLatestRateTable } from "../../server/dal/exchange-rates";
import { listManualAssets } from "../../server/dal/manual-assets";
import { AddWalletForm } from "./_components/add-wallet-form";
import { CreateAssetForm } from "./_components/create-asset-form";
import { CreateBankAccountForm } from "./_components/create-bank-account-form";
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
  const [assets, walletBalances, bankAccounts, rateTable] = await Promise.all([
    listManualAssets(user.id),
    buildWalletBalances(user.id),
    listBankAccounts(user.id),
    getLatestRateTable(),
  ]);
  const now = new Date();

  const totalValue = assets.reduce((sum, asset) => sum + asset.currentValue, 0n);

  // Live conversion at the latest synced rate — never stored, per law #5
  // (a live balance's ₪ equivalent moves with the rate), same pattern
  // budgets/page.tsx uses for a shared bank account's native-vs-₪ pair.
  const bankAccountsWithIls = bankAccounts.map((account) => ({
    ...account,
    agorotValue: convertNativeAmountToAgorot(
      nativeAmount(Number(account.nativeBalance)),
      account.currency,
      rateTable[account.currency],
    ),
  }));
  const bankAssetsTotal = bankAccountsWithIls
    .filter((a) => a.accountType !== "CREDIT_CARD")
    .reduce((sum, a) => sum + Number(a.agorotValue), 0);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-4 md:px-6">
      <h1 className="font-display text-xl font-semibold text-slate-100">Assets</h1>

      <section aria-labelledby="bank-accounts-heading" className="flex flex-col gap-4">
        <div>
          <h2
            id="bank-accounts-heading"
            className="font-display text-sm font-semibold uppercase tracking-wide text-slate-400"
          >
            Bank Accounts
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Manually recorded — this is the balance you report, not a live bank connection (unless it came from
            Settings → Open Banking).
          </p>
        </div>

        {bankAccountsWithIls.length > 0 && (
          <p className="font-tabular-figures tracking-tight text-sm text-slate-400">
            Total tracked balance: <span className="text-slate-100">{formatAgorot(agorot(bankAssetsTotal))}</span>
          </p>
        )}

        <div className="rounded-lg border border-slate-800/80 bg-slate-900 p-4">
          <CreateBankAccountForm />
        </div>

        {bankAccountsWithIls.length === 0 && (
          <p className="text-sm text-slate-400">No bank accounts tracked yet — add one above.</p>
        )}

        <ul className="flex flex-col gap-3">
          {bankAccountsWithIls.map((account) => (
            <li key={account.id} className="rounded-lg border border-slate-800/80 bg-slate-900 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-slate-100">
                    {account.nickname ?? account.institutionName}{" "}
                    <span className="text-xs text-slate-400">
                      ({account.institutionName} ••{account.last4} — {BANK_ACCOUNT_TYPE_LABEL[account.accountType]})
                    </span>
                  </p>
                </div>
                <CurrencyAmount
                  agorotValue={account.agorotValue}
                  nativeValue={nativeAmount(Number(account.nativeBalance))}
                  currency={account.currency}
                  primaryClassName="font-tabular-figures tracking-tight text-sm text-slate-100"
                  secondaryClassName="font-tabular-figures tracking-tight text-xs text-slate-400"
                />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="manual-assets-heading" className="flex flex-col gap-4 border-t border-slate-800/80 pt-4">
        <div>
          <h2
            id="manual-assets-heading"
            className="font-display text-sm font-semibold uppercase tracking-wide text-slate-400"
          >
            Manual Assets
          </h2>
        </div>

        {assets.length > 0 && (
          <p className="font-tabular-figures tracking-tight text-sm text-slate-400">
            Total tracked value: <span className="text-slate-100">{formatAgorot(agorot(Number(totalValue)))}</span>
          </p>
        )}

        <div className="rounded-lg border border-slate-800/80 bg-slate-900 p-4">
          <CreateAssetForm />
        </div>

        {assets.length === 0 && <p className="text-sm text-slate-400">No manual assets tracked yet — add one above.</p>}

        <ul className="flex flex-col gap-4">
          {assets.map((asset) => {
            const freshness = deriveValuationFreshness(asset.valuedAt, now);
            return (
              <li key={asset.id} className="rounded-lg border border-slate-800/80 bg-slate-900 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-100">
                      {asset.name}{" "}
                      <span className="text-xs text-slate-400">({ASSET_TYPE_LABEL[asset.assetType]})</span>
                      {asset.taxAdvantaged && (
                        <span className="ml-2">
                          <Badge variant="neutral">Tax-advantaged</Badge>
                        </span>
                      )}
                    </p>
                    <p className="font-tabular-figures tracking-tight text-sm text-slate-400">
                      {formatAgorot(agorot(Number(asset.currentValue)))}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Badge variant={FRESHNESS_VARIANT[freshness]} pulse={freshness === "stale"}>
                      {FRESHNESS_LABEL[freshness]}
                    </Badge>
                    <DeleteAssetButton assetId={asset.id} assetName={asset.name} />
                  </div>
                </div>

                <p className="mt-2 text-xs text-slate-400">Last valued {asset.valuedAt.toISOString().slice(0, 10)}</p>

                <div className="mt-3">
                  <UpdateValuationForm assetId={asset.id} />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="crypto-wallets-heading" className="flex flex-col gap-4 border-t border-slate-800/80 pt-4">
        <div>
          <h2 id="crypto-wallets-heading" className="font-display text-sm font-semibold uppercase tracking-wide text-slate-400">
            Crypto Wallets
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Track public wallet addresses — live balances fetched from a public Ethereum RPC endpoint, read-only, no
            private key ever involved.
          </p>
        </div>

        {walletBalances.wallets.length > 0 && (
          <p className="font-tabular-figures tracking-tight text-sm text-slate-400">
            Total tracked value: <span className="text-slate-100">{formatAgorot(walletBalances.totalValueAgorot)}</span>
          </p>
        )}

        <div className="rounded-lg border border-slate-800/80 bg-slate-900 p-4">
          <AddWalletForm />
        </div>

        {walletBalances.wallets.length === 0 && (
          <p className="text-sm text-slate-400">No wallets tracked yet — add one above.</p>
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
