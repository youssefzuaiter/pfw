"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Badge } from "../../../../components/badge/badge";
import { Spinner } from "../../../../components/spinner/spinner";
import { textItemsToTsv } from "../../../../lib/csv-import/text-items-to-rows";

type BankAccountOption = { id: string; label: string; currency: string };

type RejectedRow = { lineNumber: number; message: string };

type PreviewRow = {
  lineNumber: number;
  date: string;
  description: string;
  merchantName: string | null;
  /** Pre-formatted by the server with its own currency symbol (e.g. "-₺1,234.56"). */
  amount: string;
  isExpense: boolean;
};

type Preview = {
  adapterLabel: string;
  currency: string;
  totals: { count: number; rejected: number };
  rows: PreviewRow[];
  rejectedRows: RejectedRow[];
};

type ImportSuccess = {
  adapterLabel: string;
  importedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  rejectedRows: RejectedRow[];
};

/**
 * Two-step import: the first submit is a dry run that parses the file
 * server-side and echoes back the first rows exactly as they would be
 * booked (dates, signed amounts in the account's own currency); the
 * second commits. The preview exists because a statement layout's sign
 * convention and number format are DECLARED per adapter, never sniffed
 * (AGENTS.md §3j) — and for the Turkish layouts this app has never had a
 * real sample file to check that declaration against (§3bbb). Seeing
 * "-₺1,234.56 MİGROS / +₺45,000.00 MAAŞ" before anything is written is
 * the check; a whole month imported with every sign inverted is the
 * failure it prevents.
 */
export function ImportCsvForm({ bankAccounts }: { bankAccounts: readonly BankAccountOption[] }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ImportSuccess | null>(null);

  const selectedAccount = bankAccounts.find((account) => account.id === bankAccountId) ?? null;

  function resetOutcome() {
    // Clear any previous outcome as soon as the inputs change, so a
    // stale preview or "imported 42 rows" banner can never appear to
    // describe a file (or account) the user is about to submit.
    setPreview(null);
    setResult(null);
    setError(null);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFileName(event.target.files?.[0]?.name ?? null);
    resetOutcome();
  }

  function handleAccountChange(event: ChangeEvent<HTMLSelectElement>) {
    setBankAccountId(event.target.value);
    resetOutcome();
  }

  /**
   * A PDF is converted to the same tab-separated table a CSV upload
   * already produces, IN THE BROWSER, and only that table is uploaded —
   * the file itself never leaves the device (AGENTS.md §3bbb, the same
   * posture as receipt OCR in §3q).
   *
   * pdf.js is imported dynamically by `extractPdfTextItems`, so none of
   * its weight is paid by anyone who only ever uploads CSVs.
   */
  async function buildUpload(file: File): Promise<File> {
    if (!file.name.toLowerCase().endsWith(".pdf")) return file;

    const { extractPdfTextItems } = await import("../../../../lib/pdf-extract");
    const tsv = textItemsToTsv(await extractPdfTextItems(file));
    return new File([tsv], `${file.name.replace(/\.pdf$/i, "")}.csv`, { type: "text/csv" });
  }

  async function submit(mode: "preview" | "import") {
    const chosen = fileInputRef.current?.files?.[0];
    if (!chosen || !bankAccountId) return;

    setIsSubmitting(true);
    setError(null);
    setResult(null);
    if (mode === "preview") setPreview(null);

    try {
      const formData = new FormData();
      formData.append("file", await buildUpload(chosen));
      formData.append("bankAccountId", bankAccountId);
      if (mode === "preview") formData.append("dryRun", "1");

      const response = await fetch("/api/transactions/import", { method: "POST", body: formData });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error ?? (mode === "preview" ? "Preview failed" : "Import failed"));
      }

      if (mode === "preview") {
        setPreview({
          adapterLabel: body.adapterLabel,
          currency: body.currency,
          totals: body.totals,
          rows: body.rows ?? [],
          rejectedRows: body.rejectedRows ?? [],
        });
        return;
      }

      setPreview(null);
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

  function handlePreviewSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit("preview");
  }

  function handleImportClick() {
    void submit("import");
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
      <h2 id="import-heading" className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
        Import statement
      </h2>
      <p className="mb-3 text-xs text-muted">
        Upload a .csv or .pdf bank or credit-card statement. A PDF is read in your browser and never uploaded.
        Amounts are read in the selected account&apos;s currency
        {selectedAccount ? ` (${selectedAccount.currency})` : ""}; you&apos;ll see a preview before anything is
        saved. Duplicate rows from a statement you have already imported are detected and skipped automatically.
      </p>

      <form onSubmit={handlePreviewSubmit} className="flex flex-wrap items-end gap-3">
        {/*
         * `min-w-0` on the wrapper is load-bearing, not decorative — a
         * real bug found live: a bilingual account label ("Current
         * Account [עו״ש] — Bank Hapoalim [בנק הפועלים]") is long enough
         * that the `<select>`'s intrinsic content width alone exceeded a
         * 390px mobile viewport, and a flex item's default `min-width:
         * auto` means `flex-wrap` still won't let it shrink below that —
         * it forced real horizontal page scroll on mobile (confirmed via
         * `document.documentElement.scrollWidth` on a real page load),
         * not just an inline visual overflow. `min-w-0` here plus `w-full
         * min-w-0` on the select itself is what actually lets both shrink
         * to the available row width; the browser truncates the option
         * text on its own once the box is narrower than its content.
         */}
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="import-account" className="text-xs font-medium text-muted">
            Account
          </label>
          <select
            id="import-account"
            value={bankAccountId}
            onChange={handleAccountChange}
            className="w-full min-w-0 rounded-md border border-border bg-elevated px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            accept=".csv,.pdf,text/csv,application/pdf"
            onChange={handleFileChange}
            className="max-w-[260px] rounded-md border border-border bg-elevated px-3 py-2 text-sm text-fg file:mr-3 file:rounded file:border-0 file:bg-elevated file:px-2 file:py-1 file:text-xs file:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <button
          type="submit"
          disabled={isSubmitting || !fileName}
          className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-elevated px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isSubmitting && !preview && <Spinner />}
          {isSubmitting && !preview ? "Reading…" : "Preview"}
        </button>
      </form>

      {/* `role="status"` (a polite live region) so a screen reader announces
          the outcome without the user having to go hunting for it. */}
      <div role="status" aria-live="polite" className="mt-3 empty:mt-0">
        {error && <p className="text-sm text-negative">{error}</p>}

        {preview && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="neutral">{preview.totals.count} rows ready</Badge>
              {preview.totals.rejected > 0 && <Badge variant="warning">{preview.totals.rejected} rows rejected</Badge>}
              <span className="text-xs text-muted">
                Detected format: {preview.adapterLabel} · amounts in {preview.currency}
              </span>
            </div>

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Preview of the first parsed rows</caption>
                <thead className="bg-elevated text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Date
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Description
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.lineNumber} className="border-t border-border">
                      <td className="whitespace-nowrap px-3 py-1.5 font-tabular-figures text-muted">{row.date}</td>
                      <td className="max-w-[320px] truncate px-3 py-1.5 text-fg">{row.merchantName ?? row.description}</td>
                      <td
                        className={`whitespace-nowrap px-3 py-1.5 text-right font-tabular-figures ${
                          row.isExpense ? "text-negative" : "text-positive"
                        }`}
                      >
                        {row.amount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.totals.count > preview.rows.length && (
              <p className="text-xs text-muted">
                Showing the first {preview.rows.length} of {preview.totals.count} rows.
              </p>
            )}
            <p className="text-xs text-muted">
              Check that money out is negative and the dates are right — if a column is inverted, this is the moment
              to stop, not after the import.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleImportClick}
                disabled={isSubmitting}
                className="uv-btn-press flex items-center gap-2 rounded-md border border-transparent bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {isSubmitting && <Spinner />}
                {isSubmitting ? "Importing…" : `Import ${preview.totals.count} rows`}
              </button>
              <button
                type="button"
                onClick={resetOutcome}
                disabled={isSubmitting}
                className="rounded-md border border-border bg-elevated px-3 py-2 text-sm text-fg transition-colors hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                Cancel
              </button>
            </div>

            {preview.rejectedRows.length > 0 && (
              <details className="text-xs text-muted">
                <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Show rejected rows
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5 pl-4">
                  {preview.rejectedRows.map((row) => (
                    <li key={row.lineNumber} className="list-disc">
                      Line {row.lineNumber}: {row.message}
                    </li>
                  ))}
                  {preview.totals.rejected > preview.rejectedRows.length && (
                    <li className="list-disc">…and {preview.totals.rejected - preview.rejectedRows.length} more</li>
                  )}
                </ul>
              </details>
            )}
          </div>
        )}

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
