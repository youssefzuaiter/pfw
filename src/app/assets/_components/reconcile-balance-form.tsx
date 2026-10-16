"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";

/**
 * "On this day the balance was this": re-states an account's balance so that
 * transactions are counted from the day after (Safe to Spend, AGENTS.md
 * §3yyy). The fix for an account whose typed balance already included
 * transactions that would otherwise be counted a second time.
 */
export function ReconcileBalanceForm({ accountId, isCard }: { accountId: string; isCard: boolean }) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [nativeBalance, setNativeBalance] = useState("");
  const [balanceAsOf, setBalanceAsOf] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nativeBalance.trim() || !balanceAsOf) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/bank-accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nativeBalance: nativeBalance.trim(), balanceAsOf }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to update the balance");
      }
      setNativeBalance("");
      setBalanceAsOf("");
      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update the balance");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleToggleClick() {
    setIsOpen((open) => !open);
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={handleToggleClick}
        className="uv-btn-press rounded-md border border-border px-3 py-1 text-xs font-medium text-fg transition-colors hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Update balance
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor={`reconcile-balance-${accountId}`} className="text-xs font-medium text-muted">
          {isCard ? "Amount owed" : "Balance"}
        </label>
        <input
          id={`reconcile-balance-${accountId}`}
          inputMode="decimal"
          value={nativeBalance}
          onChange={(event) => setNativeBalance(event.target.value)}
          placeholder="0.00"
          className="w-28 rounded-md border border-border bg-elevated px-2 py-1 font-tabular-figures tracking-tight text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`reconcile-date-${accountId}`} className="text-xs font-medium text-muted">
          As of
        </label>
        <input
          id={`reconcile-date-${accountId}`}
          type="date"
          value={balanceAsOf}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(event) => setBalanceAsOf(event.target.value)}
          className="rounded-md border border-border bg-elevated px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting || !nativeBalance.trim() || !balanceAsOf}
        className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border px-3 py-1 text-xs font-medium text-fg transition-colors hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        Save
      </button>
      <button
        type="button"
        onClick={handleToggleClick}
        className="rounded-md px-2 py-1 text-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Cancel
      </button>
      {error && <span className="w-full text-xs text-negative">{error}</span>}
    </form>
  );
}
