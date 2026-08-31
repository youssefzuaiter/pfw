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
export function DividendSchedule({ payouts }: { payouts: UpcomingPayout[] }) {
  const mode = useCurrencyDisplayMode();
  const asOf = new Date();
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
