"use client";

import { useCurrencyDisplayMode } from "../../lib/hooks/use-currency-display-mode";
import { formatNativeAmount, type CurrencyCode, type NativeAmount } from "../../lib/currency";
import { formatAgorot, type Agorot } from "../../lib/money";

/**
 * The Currency UI Toggle's shared display primitive (Punch List Phase 3,
 * item 2, amending AGENTS.md §3k/§3l) — renders a foreign-currency
 * amount as a primary figure plus a smaller secondary figure, swapping
 * which one is primary based on the app-wide `useCurrencyDisplayMode()`
 * preference. Every screen showing a `BankAccount`/`PortfolioHolding`
 * native-vs-₪ pair (`household-shared-view.tsx`, `positions-table.tsx`)
 * uses this ONE component, so a single `<CurrencyToggle>` anywhere
 * changes every one of them consistently rather than each screen having
 * its own independent (and possibly inconsistent) toggle state.
 *
 * `currency === "ILS"` renders just the one figure, no secondary line
 * and no toggle-reactivity at all — there is no native-vs-₪ distinction
 * to switch between for an already-₪ amount, and showing "₪125 / ₪125"
 * would be actively confusing rather than merely redundant.
 */
export function CurrencyAmount({
  agorotValue,
  nativeValue,
  currency,
  primaryClassName = "font-tabular-figures text-fg",
  secondaryClassName = "font-tabular-figures text-xs text-muted",
  agorotOptions,
}: {
  agorotValue: Agorot;
  nativeValue: NativeAmount;
  currency: CurrencyCode;
  primaryClassName?: string;
  secondaryClassName?: string;
  agorotOptions?: Parameters<typeof formatAgorot>[1];
}) {
  const mode = useCurrencyDisplayMode();

  const ilsText = formatAgorot(agorotValue, agorotOptions);

  if (currency === "ILS") {
    return <p className={primaryClassName}>{ilsText}</p>;
  }

  const nativeText = formatNativeAmount(nativeValue, currency);
  const [primaryText, secondaryText] = mode === "native" ? [nativeText, ilsText] : [ilsText, nativeText];

  return (
    <>
      <p className={primaryClassName}>{primaryText}</p>
      <p className={secondaryClassName}>{secondaryText}</p>
    </>
  );
}
