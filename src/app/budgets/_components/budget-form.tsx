"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";

export function BudgetForm({
  categoryId,
  initialLimit,
  compact = false,
}: {
  categoryId: string;
  initialLimit?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(initialLimit ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!amount.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId, monthlyLimit: amount.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to save budget");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save budget");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`budget-amount-${categoryId}`}>
        Monthly limit in shekels
      </label>
      <input
        id={`budget-amount-${categoryId}`}
        inputMode="decimal"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        placeholder="0.00"
        className={`rounded-md border border-border bg-bg px-2 py-1 font-tabular-figures text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${compact ? "w-24" : "w-32"}`}
      />
      <button
        type="submit"
        disabled={isSubmitting || !amount.trim()}
        className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border px-3 py-1 text-xs font-medium text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        {initialLimit ? "Update" : "Set budget"}
      </button>
      {error && <span className="text-xs text-negative">{error}</span>}
    </form>
  );
}
