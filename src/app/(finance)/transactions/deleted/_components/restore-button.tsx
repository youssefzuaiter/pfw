"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * One restore control for both cases on the Recently deleted screen: a
 * single transaction and a whole deleted import. They differ only in the
 * endpoint and body, so they share this rather than two near-copies.
 *
 * On success the page is refreshed and the restored rows drop out of the
 * list (the list shows only deleted rows), so there is no "restored" state
 * to keep here. On failure the row stays and says so.
 */
export function RestoreButton({
  path,
  body,
  label,
  variant = "row",
}: {
  path: string;
  body?: unknown;
  label: string;
  variant?: "row" | "batch";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRestoreClick() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) throw new Error("Request failed");
      router.refresh();
    } catch {
      setError("Failed — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {variant === "batch" ? (
        <button
          type="button"
          onClick={handleRestoreClick}
          disabled={busy}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy ? "Restoring…" : label}
        </button>
      ) : (
        <button
          type="button"
          onClick={handleRestoreClick}
          disabled={busy}
          className="rounded border border-border bg-elevated px-2 py-1 text-xs text-accent transition-colors hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy ? "…" : label}
        </button>
      )}
      {error && (
        <span role="alert" className="text-xs text-negative">
          {error}
        </span>
      )}
    </span>
  );
}
