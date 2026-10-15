"use client";

import { BASE_CURRENCY } from "../../lib/currency";
import { parseShekelsToAgorot } from "../../lib/money";
import { useReportingMoney } from "./reporting-currency-provider";

/**
 * "≈ $135.14 at today's rate" beside an amount typed in shekels
 * (AGENTS.md §3www). These forms store a shekel figure with no columns for
 * an entered currency or rate, so they keep taking shekels; this only shows
 * what the typed figure is worth in the user's reporting currency. Renders
 * nothing when totals are shown in shekels or the text isn't an amount yet.
 */
export function ShekelEquivalentHint({ value, className = "" }: { value: string; className?: string }) {
  const money = useReportingMoney();
  const text = value.trim();
  if (money.context.currency === BASE_CURRENCY || text === "") return null;
  let amount: ReturnType<typeof parseShekelsToAgorot>;
  try {
    amount = parseShekelsToAgorot(text);
  } catch {
    return null;
  }
  return (
    <span className={`font-tabular-figures text-xs text-muted ${className}`}>
      ≈ {money.format(amount)} at today&apos;s rate
    </span>
  );
}
