"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";

export function TradeForm({ symbols, defaultSymbol }: { symbols: readonly string[]; defaultSymbol: string }) {
  const router = useRouter();
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [quantity, setQuantity] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!quantity.trim()) return;

    setIsSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/trades", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ symbol, side, quantity: quantity.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Trade failed");
      }
      setSuccess(`${side === "BUY" ? "Bought" : "Sold"} ${quantity} ${symbol}`);
      setQuantity("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trade failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="trade-symbol" className="text-xs font-medium text-muted">
          Symbol
        </label>
        <select
          id="trade-symbol"
          value={symbol}
          onChange={(event) => setSymbol(event.target.value)}
          className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {symbols.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="trade-side" className="text-xs font-medium text-muted">
          Side
        </label>
        <select
          id="trade-side"
          value={side}
          onChange={(event) => setSide(event.target.value as "BUY" | "SELL")}
          className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="BUY">Buy</option>
          <option value="SELL">Sell</option>
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="trade-quantity" className="text-xs font-medium text-muted">
          Quantity
        </label>
        <input
          id="trade-quantity"
          inputMode="decimal"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          placeholder="10"
          className="w-28 rounded-md border border-border bg-bg px-3 py-2 font-tabular-figures text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting || !quantity.trim()}
        className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        {isSubmitting ? "Submitting…" : `${side === "BUY" ? "Buy" : "Sell"} ${symbol}`}
      </button>
      {error && <p className="w-full text-sm text-negative">{error}</p>}
      {success && <p className="w-full text-sm text-positive">{success}</p>}
    </form>
  );
}
