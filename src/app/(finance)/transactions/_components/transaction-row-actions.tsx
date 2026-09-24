"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Per-row delete and transfer controls.
 *
 * Delete is SOFT and offers an undo in place, because nothing here is
 * worth making permanent on one click — this app had no delete at all
 * until a real 211-row import made "a mistake is permanent" the honest
 * description of it.
 *
 * The transfer toggle marks money moved between the user's own accounts,
 * which stays in the ledger but leaves every earned/spent figure. The
 * rows that need it usually arrive in bulk and look alike, so a Tier-0
 * rule is the better tool for a whole statement; this is for the ones
 * that slip through.
 */
export function TransactionRowActions({
  transactionId,
  isTransfer,
}: {
  transactionId: string;
  isTransfer: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [transfer, setTransfer] = useState(isTransfer);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Request failed");
      router.refresh();
      return true;
    } catch {
      setError("Failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteClick() {
    if (await post(`/api/transactions/${transactionId}/delete`, { deleted: true })) setDeleted(true);
  }

  async function handleRestoreClick() {
    if (await post(`/api/transactions/${transactionId}/delete`, { deleted: false })) setDeleted(false);
  }

  async function handleTransferClick() {
    const next = !transfer;
    if (await post(`/api/transactions/${transactionId}/transfer`, { isTransfer: next })) setTransfer(next);
  }

  if (deleted) {
    return (
      <button
        type="button"
        onClick={handleRestoreClick}
        disabled={busy}
        className="rounded border border-border bg-elevated px-2 py-1 text-xs text-accent transition-colors hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {busy ? "…" : "Undo delete"}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={handleTransferClick}
        disabled={busy}
        title="Money between your own accounts — kept in the ledger, left out of income and spending"
        className={`rounded border px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
          transfer
            ? "border-accent/50 bg-accent/10 text-accent"
            : "border-border bg-elevated text-muted hover:bg-elevated-hover"
        }`}
      >
        Transfer
      </button>
      <button
        type="button"
        onClick={handleDeleteClick}
        disabled={busy}
        className="rounded border border-border bg-elevated px-2 py-1 text-xs text-muted transition-colors hover:bg-elevated-hover hover:text-negative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {busy ? "…" : "Delete"}
      </button>
      {error && <span className="text-xs text-negative">{error}</span>}
    </span>
  );
}
