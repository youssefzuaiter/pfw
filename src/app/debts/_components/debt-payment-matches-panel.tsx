"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "../../../components/spinner/spinner";

export type DebtPaymentMatchRow = {
  debtId: string;
  transactionId: string;
  debtName: string;
  label: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amountFormatted: string;
};

/**
 * Repayments of your debts that are already in your transactions (AGENTS.md
 * §3nnnn). Recording one reduces the debt's balance by the principal part,
 * exactly as typing the payment in would, so each is ticked by the user.
 */
export function DebtPaymentMatchesPanel({ rows }: { rows: DebtPaymentMatchRow[] }) {
  const router = useRouter();
  const key = (row: DebtPaymentMatchRow) => `${row.debtId}|${row.transactionId}`;
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(rows.map(key)));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ applied: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleToggle(event: React.ChangeEvent<HTMLInputElement>) {
    // Read from the event now: the updater below runs later, when currentTarget is gone.
    const id = event.currentTarget.dataset.key ?? "";
    const checked = event.currentTarget.checked;
    setTicked((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleApply() {
    setBusy(true);
    setError(null);
    try {
      const items = rows.filter((row) => ticked.has(key(row))).map((row) => ({ debtId: row.debtId, transactionId: row.transactionId }));
      const response = await fetch("/api/debts/payment-matches/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not record the payments");
      setDone({ applied: body.applied, skipped: body.skipped });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record the payments");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section role="status" className="rounded-lg border border-border bg-surface p-4 text-sm text-fg">
        Recorded {done.applied} {done.applied === 1 ? "payment" : "payments"}.
        {done.skipped > 0 ? ` ${done.skipped} no longer matched and were left alone.` : ""}
      </section>
    );
  }

  return (
    <section aria-labelledby="debt-matches-heading" className="rounded-lg border border-border bg-surface p-4">
      <h2 id="debt-matches-heading" className="text-xs font-medium uppercase tracking-wide text-muted">
        Payments found in your transactions
      </h2>
      <p className="mt-1 text-sm text-muted">
        These transactions look like repayments of your debts, made after you added them. Recording one lowers that debt&apos;s balance, the same as typing the payment in.
      </p>
      <ul className="mt-3 flex flex-col">
        {rows.map((row) => (
          <li key={key(row)} className="flex flex-wrap items-center gap-3 border-b border-border py-2 last:border-0">
            <input
              type="checkbox"
              checked={ticked.has(key(row))}
              data-key={key(row)}
              onChange={handleToggle}
              aria-label={`Record ${row.label} on ${row.date} as a payment of ${row.debtName}`}
              className="h-4 w-4 shrink-0 accent-[var(--pfw-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{row.label}</p>
              <p className="text-xs text-muted">
                <span className="font-tabular-figures tracking-tight">{row.date}</span> · pays {row.debtName}
              </p>
            </div>
            <span className="font-tabular-figures font-medium tracking-tight text-fg">{row.amountFormatted}</span>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-2 text-sm text-negative">{error}</p>}
      <button
        type="button"
        onClick={handleApply}
        disabled={busy || ticked.size === 0}
        className="uv-btn-press mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {busy && <Spinner size="sm" />}
        Record {ticked.size} {ticked.size === 1 ? "payment" : "payments"}
      </button>
    </section>
  );
}
