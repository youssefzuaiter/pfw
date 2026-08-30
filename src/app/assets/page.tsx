import { Badge, type BadgeVariant } from "../../components/badge/badge";
import { deriveValuationFreshness, type ValuationFreshness } from "../../lib/valuation-freshness";
import { agorot, formatAgorot } from "../../lib/money";
import { buildWalletBalances } from "../../server/crypto/build-wallet-balances";
import { getCurrentUser } from "../../server/auth/current-user";
import { listManualAssets } from "../../server/dal/manual-assets";
import { AddWalletForm } from "./_components/add-wallet-form";
import { CreateAssetForm } from "./_components/create-asset-form";
import { UpdateValuationForm } from "./_components/update-valuation-form";
import { WalletBalanceRow } from "./_components/wallet-balance-row";

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
  const [assets, walletBalances] = await Promise.all([listManualAssets(user.id), buildWalletBalances(user.id)]);
  const now = new Date();

  const totalValue = assets.reduce((sum, asset) => sum + asset.currentValue, 0n);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
      <h1 className="font-display text-2xl font-semibold text-fg">Assets</h1>

      {assets.length > 0 && (
        <p className="font-tabular-figures text-sm text-muted">
          Total tracked value: <span className="text-fg">{formatAgorot(agorot(Number(totalValue)))}</span>
        </p>
      )}

      <section className="rounded-lg border border-border bg-surface p-4">
        <CreateAssetForm />
      </section>

      {assets.length === 0 && <p className="text-sm text-muted">No manual assets tracked yet — add one above.</p>}

      <ul className="flex flex-col gap-4">
        {assets.map((asset) => {
          const freshness = deriveValuationFreshness(asset.valuedAt, now);
          return (
            <li key={asset.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-fg">
                    {asset.name} <span className="text-xs text-muted">({ASSET_TYPE_LABEL[asset.assetType]})</span>
                    {asset.taxAdvantaged && (
                      <span className="ml-2">
                        <Badge variant="neutral">Tax-advantaged</Badge>
                      </span>
                    )}
                  </p>
                  <p className="font-tabular-figures text-sm text-muted">
                    {formatAgorot(agorot(Number(asset.currentValue)))}
                  </p>
                </div>
                <Badge variant={FRESHNESS_VARIANT[freshness]} pulse={freshness === "stale"}>
                  {FRESHNESS_LABEL[freshness]}
                </Badge>
              </div>

              <p className="mt-2 text-xs text-muted">Last valued {asset.valuedAt.toISOString().slice(0, 10)}</p>

              <div className="mt-3">
                <UpdateValuationForm assetId={asset.id} />
              </div>
            </li>
          );
        })}
      </ul>

      <section aria-labelledby="crypto-wallets-heading" className="flex flex-col gap-4 border-t border-border pt-6">
        <div>
          <h2 id="crypto-wallets-heading" className="font-display text-lg font-semibold text-fg">
            Crypto Wallets
          </h2>
          <p className="mt-1 text-sm text-muted">
            Track public wallet addresses — live balances fetched from a public Ethereum RPC endpoint, read-only, no
            private key ever involved.
          </p>
        </div>

        {walletBalances.wallets.length > 0 && (
          <p className="font-tabular-figures text-sm text-muted">
            Total tracked value: <span className="text-fg">{formatAgorot(walletBalances.totalValueAgorot)}</span>
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
