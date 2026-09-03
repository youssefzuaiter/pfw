import { formatAgorot, agorot } from "../../../lib/money";
import { nativeAmount, type CurrencyCode } from "../../../lib/currency";
import { Badge } from "../../../components/badge/badge";
import { CurrencyAmount } from "../../../components/currency/currency-amount";
import { CurrencyToggle } from "../../../components/currency/currency-toggle";

type SharedEnvelopeAllocationRow = {
  id: string;
  amountAgorot: bigint;
  /** `YYYY-MM` (src/lib/date-month.ts). */
  month: string;
  category: { name: string };
  user: { id: string; displayName: string };
};

type SharedBankAccountRow = {
  id: string;
  institutionName: string;
  nickname: string | null;
  currency: CurrencyCode;
  nativeBalance: bigint;
  /** Live ₪ equivalent of `nativeBalance` at the latest synced exchange rate — computed server-side (page.tsx), never persisted (law #5). */
  agorotValue: number;
  user: { id: string; displayName: string };
};

type SharedCategoryRow = {
  id: string;
  name: string;
  user: { id: string; displayName: string };
};

/**
 * Everything shared into one Household Space (AGENTS.md §3s), pooled
 * from however many members chose to share something into it — every
 * row here came back from a real RLS-scoped query
 * (`getSharedGroupData`), so a row genuinely owned by someone else is
 * only ever visible because that member actually shared it, not because
 * this view trusts a client-supplied filter.
 */
export function HouseholdSharedView({
  myUserId,
  envelopeAllocations,
  bankAccounts,
  categories,
}: {
  myUserId: string;
  envelopeAllocations: SharedEnvelopeAllocationRow[];
  bankAccounts: SharedBankAccountRow[];
  categories: SharedCategoryRow[];
}) {
  function ownerLabel(user: { id: string; displayName: string }): string {
    return user.id === myUserId ? "You" : user.displayName;
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Shared envelopes</h2>
        {envelopeAllocations.length === 0 ? (
          <p className="text-sm text-muted">No envelopes shared into this household yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {envelopeAllocations.map((allocation) => (
              <li key={allocation.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
                <div>
                  <p className="text-sm text-fg">{allocation.category.name}</p>
                  <p className="text-xs text-muted">Shared by {ownerLabel(allocation.user)}</p>
                </div>
                <p className="font-tabular-figures text-sm text-fg">
                  {formatAgorot(agorot(Number(allocation.amountAgorot)))} allocated ({allocation.month})
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Shared accounts</h2>
          {bankAccounts.some((a) => a.currency !== "ILS") && <CurrencyToggle />}
        </div>
        {bankAccounts.length === 0 ? (
          <p className="text-sm text-muted">No accounts shared into this household yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {bankAccounts.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
                <div>
                  <p className="text-sm text-fg">{account.nickname ?? account.institutionName}</p>
                  <p className="text-xs text-muted">Shared by {ownerLabel(account.user)}</p>
                </div>
                <div className="text-right">
                  <CurrencyAmount
                    agorotValue={agorot(Math.round(account.agorotValue))}
                    nativeValue={nativeAmount(Number(account.nativeBalance))}
                    currency={account.currency}
                    primaryClassName="font-tabular-figures text-sm text-fg"
                    secondaryClassName="font-tabular-figures text-xs text-muted"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">
          Balances only — individual transactions on a shared account always stay in its owner&apos;s personal ledger
          (AGENTS.md §3s: personal asset vaults stay strictly isolated even when the account itself is shared).
        </p>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Shared categories</h2>
        {categories.length === 0 ? (
          <p className="text-sm text-muted">No categories shared into this household yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <li key={category.id}>
                <Badge variant="neutral">
                  {category.name} · {ownerLabel(category.user)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
