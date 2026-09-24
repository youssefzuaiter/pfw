"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "../../../../../components/badge/badge";

type Change = {
  transactionId: string;
  occurredAt: string;
  label: string;
  categoryFrom: string | null;
  categoryTo: string | null;
  renameTo: string | null;
  transferTo: boolean | null;
};

type Preview = {
  totalChanges: number;
  changes: Change[];
  alreadyCorrect: number;
  protectedByManualChoice: number;
};

/**
 * Runs the rules over transactions already stored.
 *
 * Rules otherwise only fire at import, manual entry and sync, so writing
 * one did nothing for the rows already in the ledger — a real first
 * import left 209 of 211 in Uncategorized with no remedy but 209
 * dropdowns.
 *
 * Preview first, always, and the apply button only appears once a
 * preview has run: this can rewrite hundreds of rows and, unlike a
 * transaction, a categorisation has no undo.
 */
export function ApplyRulesPanel() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/transactions/rules/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not apply rules");

      if (dryRun) {
        setApplied(null);
        setPreview(body);
      } else {
        setPreview(null);
        setApplied(body.updatedCount ?? 0);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply rules");
    } finally {
      setBusy(false);
    }
  }

  function handlePreviewClick() {
    void run(true);
  }

  function handleApplyClick() {
    void run(false);
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="apply-rules-heading">
      <h2 id="apply-rules-heading" className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
        Apply rules to existing transactions
      </h2>
      <p className="mb-3 text-xs text-muted">
        Rules normally run only when a transaction arrives. This runs them over what you already have. A
        transaction you categorised by hand is never re-categorised — only rows still Uncategorized or flagged
        for review.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handlePreviewClick}
          disabled={busy}
          className="rounded-md border border-border bg-elevated px-3 py-2 text-sm text-fg transition-colors hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy && !preview ? "Checking…" : "Preview changes"}
        </button>

        {preview && preview.totalChanges > 0 && (
          <button
            type="button"
            onClick={handleApplyClick}
            disabled={busy}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {busy ? "Applying…" : `Apply to ${preview.totalChanges} transaction${preview.totalChanges === 1 ? "" : "s"}`}
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-negative">{error}</p>}

      {applied !== null && (
        <p className="mt-2 text-sm text-positive">
          Updated {applied} transaction{applied === 1 ? "" : "s"}.
        </p>
      )}

      {preview && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={preview.totalChanges > 0 ? "neutral" : "positive"}>
              {preview.totalChanges} would change
            </Badge>
            {preview.alreadyCorrect > 0 && (
              <Badge variant="positive">{preview.alreadyCorrect} already correct</Badge>
            )}
            {preview.protectedByManualChoice > 0 && (
              <Badge variant="warning">{preview.protectedByManualChoice} left alone (categorised by hand)</Badge>
            )}
          </div>

          {preview.totalChanges === 0 ? (
            <p className="text-xs text-muted">
              Nothing to change. Either no rule matches these transactions, or they already hold the values the
              rules would set.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Transactions these rules would change</caption>
                <thead className="bg-elevated text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Date</th>
                    <th scope="col" className="px-3 py-2 font-medium">Transaction</th>
                    <th scope="col" className="px-3 py-2 font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((change) => (
                    <tr key={change.transactionId} className="border-t border-border">
                      <td className="whitespace-nowrap px-3 py-1.5 font-tabular-figures text-muted">
                        {change.occurredAt}
                      </td>
                      <td className="max-w-[320px] truncate px-3 py-1.5 text-fg">{change.label}</td>
                      <td className="px-3 py-1.5 text-muted">
                        {change.categoryTo && (
                          <span>
                            {change.categoryFrom} → <span className="text-accent">{change.categoryTo}</span>
                          </span>
                        )}
                        {change.renameTo && <span> rename → {change.renameTo}</span>}
                        {change.transferTo !== null && (
                          <span> {change.transferTo ? "mark as transfer" : "unmark transfer"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.totalChanges > preview.changes.length && (
                <p className="px-3 py-2 text-xs text-muted">
                  Showing {preview.changes.length} of {preview.totalChanges}.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
