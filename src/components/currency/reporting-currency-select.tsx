"use client";

import type { ChangeEvent } from "react";
import { CURRENCY_SYMBOLS, SUPPORTED_CURRENCIES, isSupportedCurrency, type CurrencyCode } from "../../lib/currency";

const REPORTING_CURRENCY_NAMES: Record<CurrencyCode, string> = {
  ILS: "Israeli shekel",
  USD: "US dollar",
  EUR: "Euro",
  GBP: "British pound",
  TRY: "Turkish lira",
};

/**
 * The "show totals in" chooser, shared by Settings → Preferences and the
 * first-run wizard so the two cannot drift: one list of currencies (always
 * `SUPPORTED_CURRENCIES`, never a hand-copied one) and one set of names.
 */
export function ReportingCurrencySelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: CurrencyCode;
  onChange: (currency: CurrencyCode) => void;
}) {
  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    if (isSupportedCurrency(event.target.value)) onChange(event.target.value);
  }

  return (
    <select
      id={id}
      value={value}
      onChange={handleChange}
      className="w-56 rounded-md border border-border bg-elevated px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {SUPPORTED_CURRENCIES.map((currency) => (
        <option key={currency} value={currency}>
          {CURRENCY_SYMBOLS[currency]} {REPORTING_CURRENCY_NAMES[currency]}
        </option>
      ))}
    </select>
  );
}
