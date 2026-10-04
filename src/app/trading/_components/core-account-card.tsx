import { CurrencyAmount } from "../../../components/currency/currency-amount";
import { formatAge, formatBps, formatUtcDateTime } from "../../../lib/core-format";
import { nativeAmount } from "../../../lib/currency";
import { formatExchangeRate } from "../../../lib/exchange-rate";
import { agorot } from "../../../lib/money";
import type { CoreAccountView, CoreMoney } from "../../../server/core/build-core-agent-data";

function toneClass(value: number): string {
  if (value > 0) return "text-positive";
  if (value < 0) return "text-negative";
  return "text-fg";
}

function Money({ money, primaryClassName }: { money: CoreMoney; primaryClassName?: string }) {
  return (
    <CurrencyAmount
      agorotValue={agorot(money.ilsAgorot)}
      nativeValue={nativeAmount(money.usdCents)}
      currency="USD"
      primaryClassName={primaryClassName ?? "font-tabular-figures text-lg font-semibold text-fg"}
    />
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-[8rem] flex-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      {children}
    </div>
  );
}

/**
 * The core's account as the router last saw it. Every figure is native
 * US dollars converted to shekels at read time at the latest synced rate;
 * the app-wide toggle chooses which of the pair leads, as everywhere else.
 */
export function CoreAccountCard({ account }: { account: CoreAccountView }) {
  const change = account.dayChange;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4" aria-labelledby="core-account-heading">
      <h2 id="core-account-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
        Account
      </h2>
      <div className="flex flex-wrap gap-6">
        <Stat label="Equity">
          <Money money={account.equity} />
        </Stat>
        <Stat label="Invested">
          <Money money={account.invested} />
        </Stat>
        <Stat label="Cash">
          <Money money={account.cash} />
        </Stat>
        <Stat label="Since last close">
          {change ? (
            <>
              <CurrencyAmount
                agorotValue={agorot(change.ilsAgorot)}
                nativeValue={nativeAmount(change.usdCents)}
                currency="USD"
                primaryClassName={`font-tabular-figures text-lg font-semibold ${toneClass(change.usdCents)}`}
                secondaryClassName={`font-tabular-figures text-xs ${toneClass(change.usdCents)}`}
                agorotOptions={{ showPositiveSign: true }}
                nativeOptions={{ showPositiveSign: true }}
              />
              <p className={`font-tabular-figures text-xs ${toneClass(change.usdCents)}`}>
                {change.bps === null ? "—" : `${change.bps > 0 ? "+" : ""}${formatBps(change.bps)}`}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">—</p>
          )}
        </Stat>
      </div>
      <p className="text-xs text-muted">
        As of {formatUtcDateTime(account.takenAt)} ({formatAge(account.ageSeconds)}
        {account.ageSeconds < 60 ? "" : " ago"}). US-dollar figures, converted at ₪{formatExchangeRate(account.usdIlsRate, "USD")} per $1 (the latest
        synced rate).
      </p>
    </section>
  );
}
