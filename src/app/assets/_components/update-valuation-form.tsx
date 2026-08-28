"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";

export function UpdateValuationForm({ assetId }: { assetId: string }) {
  const router = useRouter();
  const [currentValue, setCurrentValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentValue.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/assets/${assetId}/valuation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentValue: currentValue.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to update valuation");
      }
      setCurrentValue("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update valuation");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`valuation-${assetId}`}>
        New value (₪)
      </label>
      <input
        id={`valuation-${assetId}`}
        inputMode="decimal"
        value={currentValue}
        onChange={(event) => setCurrentValue(event.target.value)}
        placeholder="510000.00"
        className="w-32 rounded-md border border-border bg-bg px-2 py-1 font-tabular-figures text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <button
        type="submit"
        disabled={isSubmitting || !currentValue.trim()}
        className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border px-3 py-1 text-xs font-medium text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        Update valuation
      </button>
      {error && <span className="text-xs text-negative">{error}</span>}
    </form>
  );
}
