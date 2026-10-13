"use client";

import { useCurrencyDisplayMode } from "../../lib/hooks/use-currency-display-mode";
import { useReportingMoney } from "./reporting-currency-provider";
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
 * An amount already in the reporting currency (₪ by default, AGENTS.md
 * §3nnn) renders just the one figure, no secondary line and no
 * toggle-reactivity at all — there is nothing to switch between, and
 * showing "₪125 / ₪125" would be actively confusing rather than merely
 * redundant. Otherwise the converted figure is in the reporting currency.
 */
export function CurrencyAmount({
  agorotValue,
  nativeValue,
  currency,
  primaryClassName = "font-tabular-figures text-fg",
  secondaryClassName = "font-tabular-figures text-xs text-muted",
  agorotOptions,
  nativeOptions,
}: {
  agorotValue: Agorot;
  nativeValue: NativeAmount;
  currency: CurrencyCode;
  primaryClassName?: string;
  secondaryClassName?: string;
  agorotOptions?: Parameters<typeof formatAgorot>[1];
  /** The native-figure counterpart of `agorotOptions` (e.g. `showPositiveSign` for a day's change), so both lines of a signed amount agree. */
  nativeOptions?: Parameters<typeof formatNativeAmount>[2];
}) {
  const mode = useCurrencyDisplayMode();
  const money = useReportingMoney();

  // An amount already in the reporting currency is shown once, exactly as
  // recorded: converting it to shekels and back would only add rounding.
  if (currency === money.context.currency) {
    const text =
      currency === "ILS" ? formatAgorot(agorotValue, agorotOptions) : formatNativeAmount(nativeValue, currency, nativeOptions);
    return <p className={primaryClassName}>{text}</p>;
  }

  // "ils" mode predates the reporting currency (AGENTS.md §3nnn); it means
  // the converted figure, which is now in the reporting currency.
  const convertedText = money.format(agorotValue, agorotOptions);
  const nativeText = formatNativeAmount(nativeValue, currency, nativeOptions);
  const [primaryText, secondaryText] = mode === "native" ? [nativeText, convertedText] : [convertedText, nativeText];

  return (
    <>
      <p className={primaryClassName}>{primaryText}</p>
      <p className={secondaryClassName}>{secondaryText}</p>
    </>
  );
}
