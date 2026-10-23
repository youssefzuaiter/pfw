"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Spinner } from "../../../../components/spinner/spinner";
import { agorot, formatAgorot, parseShekelsToAgorot } from "../../../../lib/money";

export type SuggestedBudgetRow = {
  categoryId: string;
  categoryName: string;
  /** What the category cost per month on average, formatted for display. */
  averageFormatted: string;
  /** The suggested amount as a shekel string, e.g. "1610.00": the input's starting value. */
  suggestedValue: string;
};

function parseAmount(value: string): number | null {
  try {
    const amount = parseShekelsToAgorot(value.trim());
    return amount > 0 ? amount : null;
  } catch {
    return null;
  }
}

/**
 * Suggested envelope amounts from what each category cost in recent months
 * (AGENTS.md §3mmmm). Everything starts ticked and every amount can be edited.
 * The total is checked against what is available to budget before anything is
 * sent, and the server checks it again.
 */
export function SuggestedBudgetsPanel({
  month,
  monthsUsed,
  availableAgorot,
  rows,
}: {
  month: string;
  monthsUsed: number;
  availableAgorot: number;
  rows: SuggestedBudgetRow[];
}) {
  const router = useRouter();
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(rows.map((row) => row.categoryId)));
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((row) => [row.categoryId, row.suggestedValue])));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { total, invalid } = useMemo(() => {
    let sum = 0;
    let bad = 0;
    for (const row of rows) {
      if (!ticked.has(row.categoryId)) continue;
      const amount = parseAmount(amounts[row.categoryId] ?? "");
      if (amount === null) bad++;
      else sum += amount;
    }
    return { total: sum, invalid: bad };
  }, [rows, ticked, amounts]);

  const exceeds = total > availableAgorot;
  const canApply = !busy && ticked.size > 0 && invalid === 0 && !exceeds;

  function handleToggle(event: React.ChangeEvent<HTMLInputElement>) {
    // Read from the event now: the updater below runs later, when currentTarget is gone.
    const id = event.currentTarget.dataset.categoryId ?? "";
    const checked = event.currentTarget.checked;
    setTicked((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleAmount(event: React.ChangeEvent<HTMLInputElement>) {
    const id = event.currentTarget.dataset.categoryId ?? "";
    const value = event.currentTarget.value;
    setAmounts((current) => ({ ...current, [id]: value }));
  }

  async function handleApply() {
    setBusy(true);
    setError(null);
    try {
      const items = rows.filter((row) => ticked.has(row.categoryId)).map((row) => ({ categoryId: row.categoryId, amount: amounts[row.categoryId].trim() }));
      const response = await fetch("/api/envelopes/suggestions/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, items }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not set the envelopes");
      setDone(body.applied);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not set the envelopes");
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <section role="status" className="rounded-lg border border-border bg-surface p-4 text-sm text-fg">
        Set {done} {done === 1 ? "envelope" : "envelopes"} for {month}. You can change any of them below.
      </section>
    );
  }

  return (
    <section aria-labelledby="suggested-heading" className="rounded-lg border border-border bg-surface p-4">
      <h2 id="suggested-heading" className="text-xs font-medium uppercase tracking-wide text-muted">
        Suggested budgets
      </h2>
      <p className="mt-1 text-sm text-muted">
        Based on what each category cost per month over the last {monthsUsed} {monthsUsed === 1 ? "month" : "months"} with activity, rounded up to the next ₪10.
        Only envelopes with nothing set for {month} are listed.
      </p>

      <ul className="mt-3 flex flex-col">
        {rows.map((row) => (
          <li key={row.categoryId} className="flex flex-wrap items-center gap-3 border-b border-border py-2 last:border-0">
            <input
              type="checkbox"
              checked={ticked.has(row.categoryId)}
              data-category-id={row.categoryId}
              onChange={handleToggle}
              aria-label={`Set a budget for ${row.categoryName}`}
              className="h-4 w-4 shrink-0 accent-[var(--pfw-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{row.categoryName}</p>
              <p className="text-xs text-muted">Average {row.averageFormatted} a month</p>
            </div>
            <label className="flex items-center gap-1 text-sm text-muted">
              <span className="sr-only">Amount for {row.categoryName}, in shekels</span>
              <span aria-hidden="true">₪</span>
              <input
                value={amounts[row.categoryId] ?? ""}
                data-category-id={row.categoryId}
                onChange={handleAmount}
                inputMode="decimal"
                disabled={!ticked.has(row.categoryId)}
                className="w-28 rounded-md border border-border bg-elevated px-2 py-1 text-right text-sm font-tabular-figures tracking-tight text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
            </label>
          </li>
        ))}
      </ul>

      <p className={`mt-3 text-sm ${exceeds ? "text-negative" : "text-muted"}`} role={exceeds ? "alert" : undefined}>
        Total <span className="font-tabular-figures font-medium tracking-tight">{formatAgorot(agorot(total))}</span> of{" "}
        <span className="font-tabular-figures tracking-tight">{formatAgorot(agorot(availableAgorot))}</span> available to budget
        {exceeds ? ". Untick some or lower an amount." : "."}
      </p>
      {invalid > 0 && <p role="alert" className="mt-1 text-sm text-negative">Enter an amount above zero for every ticked envelope.</p>}
      {error && <p role="alert" className="mt-1 text-sm text-negative">{error}</p>}

      <button
        type="button"
        onClick={handleApply}
        disabled={!canApply}
        className="uv-btn-press mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {busy && <Spinner size="sm" />}
        Set {ticked.size} {ticked.size === 1 ? "envelope" : "envelopes"}
      </button>
    </section>
  );
}
