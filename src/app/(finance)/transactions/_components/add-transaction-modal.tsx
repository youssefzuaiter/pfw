"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "../../../../components/spinner/spinner";
import { ToggleSwitch } from "../../../../components/toggle/toggle-switch";

type BankAccountOption = { id: string; label: string };

// Deliberately narrow — this dialog's content is fixed, not arbitrary
// markup — same convention as ReceiptScannerModal/MobileNav's drawer.
const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])";

/**
 * The app's one general-purpose manual transaction entry point — deliberately
 * separate from `ReceiptScannerModal`, which always forces an expense on
 * purpose (a receipt IS an expense, per that component's own doc comment).
 * `POST /api/transactions` has always accepted a positive (income) amount —
 * its own doc comment says so explicitly — but nothing in the UI ever
 * exercised that path before this, since the receipt scanner was this
 * app's only manual-entry surface and hardcoded a negative sign. This
 * closes that gap: an Income/Expense toggle picks the sign, everything
 * else reuses the exact same route, categorization cascade, and Tier 3
 * embedding lookup the receipt scanner already uses.
 */
export function AddTransactionModal({ bankAccounts }: { bankAccounts: readonly BankAccountOption[] }) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isIncome, setIsIncome] = useState(false);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);

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
    setIsIncome(false);
    setDescription("");
    setAmount("");
    setOccurredAt("");
    setError(null);
  }

  function handleOpen() {
    setIsOpen(true);
    setOccurredAt(new Date().toISOString().slice(0, 10));
  }

  function handleClose() {
    setIsOpen(false);
    resetState();
    openButtonRef.current?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bankAccountId || !amount.trim() || !description.trim()) return;

    setIsSubmitting(true);
    setError(null);

    try {
      // Dynamically imported so Transformers.js's WASM runtime and model
      // download never load until this final submit step — same
      // lazy-loading precedent as ReceiptScannerModal.
      const { embedTextWithTimeout } = await import("../../../../lib/embeddings/local-embedder");
      const embedding = await embedTextWithTimeout(description.trim());

      const signedAmount = `${isIncome ? "" : "-"}${amount.trim().replace(/^-/, "")}`;

      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankAccountId,
          amount: signedAmount,
          occurredAt: new Date(occurredAt).toISOString(),
          description: description.trim(),
          merchantName: description.trim(),
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
      setError(err instanceof Error ? err.message : "Failed to add the transaction");
    } finally {
      setIsSubmitting(false);
    }
  }

  // No duplicate empty-state message here — `ImportCsvForm` (rendered
  // right alongside this component on /transactions) already tells the
  // user to add a bank account first when `bankAccounts` is empty.
  if (bankAccounts.length === 0) {
    return null;
  }

  return (
    <>
      <button
        ref={openButtonRef}
        type="button"
        onClick={handleOpen}
        className="uv-btn-press rounded-md border border-slate-800/80 px-3 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Add transaction
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
            aria-labelledby="add-transaction-title"
            className="relative z-10 flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto rounded-lg border border-slate-800/80 bg-slate-950 p-5 shadow-2xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 id="add-transaction-title" className="font-display text-lg font-semibold text-slate-100">
                Add transaction
              </h2>
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close"
                className="rounded-md p-1 text-slate-400 hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <ToggleSwitch
                id="txn-is-income"
                checked={isIncome}
                onChange={setIsIncome}
                label={isIncome ? "Income" : "Expense"}
              />
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-slate-400">Description</span>
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={isIncome ? "Salary" : "Groceries"}
                  required
                  className="rounded-md border border-slate-800/80 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <div className="flex gap-3">
                <label className="flex flex-1 flex-col gap-1">
                  <span className="text-xs font-medium text-slate-400">Date</span>
                  <input
                    type="date"
                    value={occurredAt}
                    onChange={(event) => setOccurredAt(event.target.value)}
                    required
                    className="rounded-md border border-slate-800/80 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <label className="flex flex-1 flex-col gap-1">
                  <span className="text-xs font-medium text-slate-400">Amount (₪)</span>
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="0.00"
                    required
                    className="rounded-md border border-slate-800/80 bg-slate-800 px-3 py-2 font-tabular-figures tracking-tight text-sm text-slate-100 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-slate-400">Account</span>
                <select
                  value={bankAccountId}
                  onChange={(event) => setBankAccountId(event.target.value)}
                  required
                  className="rounded-md border border-slate-800/80 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {bankAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label}
                    </option>
                  ))}
                </select>
              </label>
              {error && <p className="text-xs text-negative">{error}</p>}
              <div className="mt-1 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={isSubmitting}
                  className="rounded-md px-3 py-2 text-sm text-slate-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !bankAccountId}
                  className="uv-btn-press flex items-center gap-2 rounded-md border border-transparent bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {isSubmitting && <Spinner />}
                  Add transaction
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
