"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";

type BankAccountOption = { id: string; label: string };

type RejectedRow = { lineNumber: number; message: string };

type ImportSuccess = {
  adapterLabel: string;
  importedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  rejectedRows: RejectedRow[];
};

export function ImportCsvForm({ bankAccounts }: { bankAccounts: readonly BankAccountOption[] }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportSuccess | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFileName(event.target.files?.[0]?.name ?? null);
    // Clear any previous outcome as soon as a new file is chosen, so a
    // stale "imported 42 rows" banner can never appear to describe the
    // file the user is about to upload.
    setResult(null);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file || !bankAccountId) return;

    setIsSubmitting(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("bankAccountId", bankAccountId);

      const response = await fetch("/api/transactions/import", { method: "POST", body: formData });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error ?? "Import failed");
      }

      setResult({
        adapterLabel: body.adapterLabel,
        importedCount: body.importedCount,
        duplicateCount: body.duplicateCount,
        rejectedCount: body.rejectedCount,
        rejectedRows: body.rejectedRows ?? [],
      });
      setFileName(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (bankAccounts.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
        Add a bank account before importing a statement.
      </p>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="import-heading">
      <h2 id="import-heading" className="mb-1 text-sm font-medium uppercase tracking-wide text-muted">
        Import statement
      </h2>
      <p className="mb-3 text-xs text-muted">
        Upload a .csv bank or credit-card statement. Duplicate rows from a statement you have already imported are
        detected and skipped automatically.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="import-account" className="text-xs font-medium text-muted">
            Account
          </label>
          <select
            id="import-account"
            value={bankAccountId}
            onChange={(event) => setBankAccountId(event.target.value)}
            className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {bankAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="import-file" className="text-xs font-medium text-muted">
            Statement file
          </label>
          <input
            ref={fileInputRef}
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="max-w-[260px] rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg file:mr-3 file:rounded file:border-0 file:bg-border file:px-2 file:py-1 file:text-xs file:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <button
          type="submit"
          disabled={isSubmitting || !fileName}
          className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isSubmitting && <Spinner />}
          {isSubmitting ? "Importing…" : "Import"}
        </button>
      </form>

      {/* `role="status"` (a polite live region) so a screen reader announces
          the outcome without the user having to go hunting for it. */}
      <div role="status" aria-live="polite" className="mt-3 empty:mt-0">
        {error && <p className="text-sm text-negative">{error}</p>}

        {result && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={result.importedCount > 0 ? "positive" : "neutral"}>
                {result.importedCount} imported
              </Badge>
              {result.duplicateCount > 0 && (
                <Badge variant="neutral">{result.duplicateCount} duplicates skipped</Badge>
              )}
              {result.rejectedCount > 0 && (
                <Badge variant="warning">{result.rejectedCount} rows rejected</Badge>
              )}
              <span className="text-xs text-muted">Detected format: {result.adapterLabel}</span>
            </div>

            {result.rejectedRows.length > 0 && (
              <details className="text-xs text-muted">
                <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Show rejected rows
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5 pl-4">
                  {result.rejectedRows.map((row) => (
                    <li key={row.lineNumber} className="list-disc">
                      Line {row.lineNumber}: {row.message}
                    </li>
                  ))}
                  {result.rejectedCount > result.rejectedRows.length && (
                    <li className="list-disc">
                      …and {result.rejectedCount - result.rejectedRows.length} more
                    </li>
                  )}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
