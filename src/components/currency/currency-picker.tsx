"use client";

import type { ChangeEvent } from "react";
import { CURRENCY_SYMBOLS, SUPPORTED_CURRENCIES, isSupportedCurrency, type CurrencyCode } from "../../lib/currency";

/**
 * Which currency an amount is typed in (AGENTS.md §3www). A plain native
 * select, so it is keyboard- and screen-reader-operable for free; the
 * list is derived from SUPPORTED_CURRENCIES, never re-typed (§3bbb).
 */
export function CurrencyPicker({
  id,
  value,
  onChange,
  label = "Currency",
}: {
  id: string;
  value: CurrencyCode;
  onChange: (currency: CurrencyCode) => void;
  label?: string;
}) {
  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    if (isSupportedCurrency(event.target.value)) onChange(event.target.value);
  }

  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <select
        id={id}
        value={value}
        onChange={handleChange}
        className="rounded-md border border-border bg-elevated px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {SUPPORTED_CURRENCIES.map((code) => (
          <option key={code} value={code}>
            {CURRENCY_SYMBOLS[code]} {code}
          </option>
        ))}
      </select>
    </label>
  );
}
