"use client";

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";
import { formatAgorot } from "../../../lib/money";
import type { ParsedReceipt } from "../../../lib/receipt-parser";
import { parseReceiptText } from "../../../lib/receipt-parser";
import { useInlineStyleProperty } from "../../../lib/hooks/use-inline-style-property";

type BankAccountOption = { id: string; label: string };
type Stage = "idle" | "processing" | "review" | "submitting" | "error";

// Deliberately narrow — this dialog's content is fixed, not arbitrary
// markup — same convention and same reasoning as MobileNav's drawer.
const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])";

function agorotToInputValue(value: number): string {
  return (Math.abs(value) / 100).toFixed(2);
}

function dateToInputValue(date: Date | null): string {
  return (date ?? new Date()).toISOString().slice(0, 10);
}

export function ReceiptScannerModal({ bankAccounts }: { bankAccounts: readonly BankAccountOption[] }) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [progressStatus, setProgressStatus] = useState("");
  const progressBarRef = useRef<HTMLDivElement>(null);
  // Set via the CSSOM (§3x), not React's `style` prop — see
  // useInlineStyleProperty's doc comment for why a plain inline `style`
  // here would be silently blocked by this app's CSP on first paint.
  useInlineStyleProperty(progressBarRef, "width", `${progress}%`);
  const [parsed, setParsed] = useState<ParsedReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [merchantName, setMerchantName] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [amount, setAmount] = useState("");
  const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? "");

  const dialogRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const dialogNode = dialogRef.current;
    dialogNode?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        handleClose();
        return;
      }
      if (event.key !== "Tab" || !dialogNode) return;

      const focusable = Array.from(dialogNode.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleClose is stable enough for this dialog's lifetime; re-running per render would re-attach the listener needlessly.
  }, [isOpen]);

  function resetState() {
    setStage("idle");
    setProgress(0);
    setProgressStatus("");
    setParsed(null);
    setError(null);
    setMerchantName("");
    setOccurredAt("");
    setAmount("");
  }

  function handleOpen() {
    setIsOpen(true);
  }

  function handleClose() {
    setIsOpen(false);
    resetState();
    openButtonRef.current?.focus();
  }

  async function processFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setStage("error");
      setError("Only image files (JPEG, PNG, etc.) are supported — PDF receipts aren't handled yet.");
      return;
    }

    setStage("processing");
    setError(null);
    setProgress(0);

    try {
      // Dynamically imported so Tesseract.js's ~4MB of worker/WASM glue
      // never loads until a user actually drops a file — see
      // src/lib/receipt-ocr.ts's header comment.
      const { recognizeReceiptText } = await import("../../../lib/receipt-ocr");
      const text = await recognizeReceiptText(file, (p) => {
        setProgress(Math.round(p.progress * 100));
        setProgressStatus(p.status);
      });

      const result = parseReceiptText(text);
      setParsed(result);
      setMerchantName(result.merchantName ?? "");
      setOccurredAt(dateToInputValue(result.occurredAt));
      setAmount(result.totalAgorot !== null ? agorotToInputValue(result.totalAgorot) : "");
      setStage("review");
    } catch (err) {
      setStage("error");
      setError(err instanceof Error ? err.message : "Couldn't read that image — try a clearer photo.");
    }
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void processFile(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void processFile(file);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingOver(true);
  }

  function handleDragLeave() {
    setIsDraggingOver(false);
  }

  function handleChooseFileClick() {
    fileInputRef.current?.click();
  }

  function handleRetry() {
    resetState();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bankAccountId || !amount.trim() || !merchantName.trim()) return;

    setStage("submitting");
    setError(null);

    try {
      // Dynamically imported so Transformers.js's WASM runtime and model
      // download never load on an ordinary receipt scan until this final
      // submit step — same lazy-loading precedent as Tesseract.js above.
      // The Self-Learning Vector Categorization Engine (AGENTS.md §3u):
      // this embedding lets the server's categorization cascade try Tier
      // 3 (similarity match against previously-corrected merchants)
      // before falling back to Uncategorized/needs-review.
      const { embedTextWithTimeout } = await import("../../../lib/embeddings/local-embedder");
      const embedding = await embedTextWithTimeout(merchantName.trim());

      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankAccountId,
          // Receipts are always an expense — force negative regardless
          // of what was typed, rather than trusting a sign the user
          // never actually entered.
          amount: `-${amount.trim().replace(/^-/, "")}`,
          occurredAt: new Date(occurredAt).toISOString(),
          description: merchantName.trim(),
          merchantName: merchantName.trim(),
          embedding,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? "Failed to add the transaction");
      }

      router.refresh();
      handleClose();
    } catch (err) {
      setStage("review");
      setError(err instanceof Error ? err.message : "Failed to add the transaction");
    }
  }

  return (
    <>
      <button
        ref={openButtonRef}
        type="button"
        onClick={handleOpen}
        className="uv-btn-press rounded-md border border-border px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Scan a receipt
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            onClick={handleClose}
            className="absolute inset-0 bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="receipt-scanner-title"
            className="relative z-10 flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 id="receipt-scanner-title" className="font-display text-lg font-semibold text-fg">
                Scan a receipt
              </h2>
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close"
                className="rounded-md p-1 text-muted hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                ✕
              </button>
            </div>
            <p className="mb-4 text-xs text-muted">
              The image is processed entirely on this device — it&apos;s never uploaded anywhere. Only the fields you
              review and confirm below are sent to add the transaction.
            </p>

            {(stage === "idle" || stage === "error") && (
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
                  isDraggingOver ? "border-accent bg-accent/5" : "border-border"
                }`}
              >
                <p className="text-sm text-muted">Drag a receipt photo here, or</p>
                <button
                  type="button"
                  onClick={handleChooseFileClick}
                  className="uv-btn-press rounded-md border border-border bg-accent px-3 py-1.5 text-sm font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Choose a file
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileInputChange}
                  className="sr-only"
                />
                {error && <p className="mt-2 text-xs text-negative">{error}</p>}
              </div>
            )}

            {stage === "processing" && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Spinner />
                <p className="text-sm text-muted">{progressStatus || "Reading the receipt…"}</p>
                <div className="h-1.5 w-full rounded-full bg-border">
                  <div ref={progressBarRef} className="h-full rounded-full bg-accent transition-all" />
                </div>
              </div>
            )}

            {(stage === "review" || stage === "submitting") && (
              <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                <Badge variant="neutral">Review the extracted details before adding</Badge>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">Merchant</span>
                  <input
                    value={merchantName}
                    onChange={(event) => setMerchantName(event.target.value)}
                    required
                    className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <div className="flex gap-3">
                  <label className="flex flex-1 flex-col gap-1">
                    <span className="text-xs font-medium text-muted">Date</span>
                    <input
                      type="date"
                      value={occurredAt}
                      onChange={(event) => setOccurredAt(event.target.value)}
                      required
                      className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                  <label className="flex flex-1 flex-col gap-1">
                    <span className="text-xs font-medium text-muted">Total (₪)</span>
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      required
                      className="rounded-md border border-border bg-bg px-3 py-2 font-tabular-figures text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">Account</span>
                  <select
                    value={bankAccountId}
                    onChange={(event) => setBankAccountId(event.target.value)}
                    required
                    className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {bankAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.label}
                      </option>
                    ))}
                  </select>
                </label>
                {parsed?.taxAgorot !== null && parsed?.taxAgorot !== undefined && (
                  <p className="text-xs text-muted">Detected tax: {formatAgorot(parsed.taxAgorot)}</p>
                )}
                {parsed && parsed.lineItems.length > 0 && (
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer">{parsed.lineItems.length} line item(s) detected</summary>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {parsed.lineItems.map((item, index) => (
                        <li key={index} className="flex justify-between">
                          <span>{item.description}</span>
                          <span className="font-tabular-figures">{formatAgorot(item.amountAgorot)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {error && <p className="text-xs text-negative">{error}</p>}
                <div className="mt-1 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleRetry}
                    disabled={stage === "submitting"}
                    className="rounded-md px-3 py-2 text-sm text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    Start over
                  </button>
                  <button
                    type="submit"
                    disabled={stage === "submitting" || !bankAccountId}
                    className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {stage === "submitting" && <Spinner />}
                    Add transaction
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
