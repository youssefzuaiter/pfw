"use client";

import { useCurrencyDisplayMode } from "../../../lib/hooks/use-currency-display-mode";
import { formatNativeAmount } from "../../../lib/currency";
import { addAgorot, formatAgorot } from "../../../lib/money";
import type { UpcomingPayout } from "../../../lib/portfolio-analytics";

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysUntil(date: Date, asOf: Date): number {
  return Math.ceil((date.getTime() - asOf.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * The upcoming payout schedule. Every amount here is explicitly labelled
 * as projected — it is computed from today's share count and today's FX
 * rate, both of which can still move before the pay date, so presenting
 * it as a settled figure would overstate what's actually known.
 */
/** Same primary/secondary swap `<CurrencyAmount>` applies elsewhere, kept
 * inline here rather than via that shared component because this row's
 * secondary line carries an extra per-share × quantity breakdown
 * `<CurrencyAmount>`'s generic two-figure shape doesn't have room for. */
/**
 * `asOf` is passed in from the server rather than read as `new Date()`
 * here, for two reasons. It's a hydration mismatch otherwise — this is a
 * Client Component, so it also renders on the server, and the "in Nd"
 * countdown is computed from the server clock during SSR and the
 * browser's clock at hydration; any device-clock skew that crosses a
 * `Math.ceil` day boundary makes those two renders disagree. It's also an
 * internal inconsistency: every projected amount in these rows was
 * already computed server-side against `buildPortfolioData`'s own `asOf`,
 * so measuring the countdown from a different instant means the amount
 * and the date beside it describe two slightly different moments.
 */
export function DividendSchedule({ payouts, asOf }: { payouts: UpcomingPayout[]; asOf: Date }) {
  const mode = useCurrencyDisplayMode();
  const projectedTotal = addAgorot(...payouts.map((payout) => payout.projectedAgorot));

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {payouts.map((payout) => {
          const days = daysUntil(payout.payDate, asOf);
          const ilsText = formatAgorot(payout.projectedAgorot);
          const nativeBreakdownText = `${formatNativeAmount(payout.amountPerShareNative, payout.currency)}/sh × ${payout.quantity} = ${formatNativeAmount(payout.projectedNativeAmount, payout.currency)}`;
          const [primaryText, secondaryText] =
            mode === "native"
              ? [formatNativeAmount(payout.projectedNativeAmount, payout.currency), ilsText]
              : [ilsText, nativeBreakdownText];
          return (
            <li
              key={`${payout.symbol}-${payout.exDate.toISOString()}`}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0"
            >
              <div>
                <p className="font-medium text-fg">{payout.symbol}</p>
                <p className="font-tabular-figures text-xs text-muted">
                  ex {formatDate(payout.exDate)} · pays {formatDate(payout.payDate)}
                  {days > 0 && ` · in ${days}d`}
                </p>
              </div>
              <div className="text-right">
                <p className="font-tabular-figures text-sm text-fg">{primaryText}</p>
                <p className="font-tabular-figures text-xs text-muted">{secondaryText}</p>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="font-tabular-figures text-xs text-muted">
        Projected total {formatAgorot(projectedTotal)} — based on current holdings and today&apos;s exchange rate;
        both can change before the pay date. Always shown in ₪ regardless of the toggle above, since payouts can
        span more than one native currency and only ₪ is a common unit to sum them in.
      </p>
    </div>
  );
}
