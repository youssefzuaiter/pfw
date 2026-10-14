"use client";

import { useState, type MouseEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";

/**
 * Settings → Your data → Download (AGENTS.md §3uuu). Fetches the export and
 * hands the browser the file; the decrypted data lives only in the response
 * and the download, never in page state.
 */
type Format = "json" | "csv";

const FALLBACK_NAMES: Record<Format, string> = { json: "pfw-export.json", csv: "pfw-export.zip" };

export function ExportDataPanel() {
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload(event: MouseEvent<HTMLButtonElement>) {
    const format = event.currentTarget.dataset.format as Format;
    setBusy(format);
    setError(null);
    try {
      const response = await fetch("/api/account/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format }),
      });
      if (!response.ok) {
        throw new Error(response.status === 429 ? "Too many exports. Try again in an hour." : "The export could not be made.");
      }
      const filename = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? FALLBACK_NAMES[format];
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Let the download start before the data is released.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The export could not be made.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold text-fg">Download your data</h3>
      <p className="text-xs text-muted">
        Everything in your account, decrypted: accounts, transactions (including deleted ones), budgets, goals, debts,
        assets, trades, rules, settings, notifications and your history. Passwords, two-factor secrets and other sign-in
        secrets are left out. The file is not encrypted, so keep it somewhere safe.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-format="json"
          onClick={handleDownload}
          disabled={busy !== null}
          className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-fg hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy === "json" && <Spinner />} Download JSON
        </button>
        <button
          type="button"
          data-format="csv"
          onClick={handleDownload}
          disabled={busy !== null}
          className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-fg hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy === "csv" && <Spinner />} Download CSV (ZIP)
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-negative">
          {error}
        </p>
      )}
    </div>
  );
}
