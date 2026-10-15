"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent } from "react";
import { Spinner } from "../../../../components/spinner/spinner";
import { CURRENCY_SYMBOLS, formatNativeAmount, nativeAmount, parseDecimalToNativeAmount, type CurrencyCode } from "../../../../lib/currency";

export type SplitView = { categoryId: string; categoryName: string; amountAgorot: number; nativeAmount: number };

type Line = { key: number; categoryId: string; amount: string };

const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])";

/** 1234 minor units → "12.34"; the sign is dropped, since parts are typed unsigned. */
function minorToDecimal(minor: number): string {
  const magnitude = Math.abs(minor);
  return `${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
}

/** The typed amount in minor units, or null while it isn't one yet. */
function parseLine(amount: string): number | null {
  const text = amount.trim();
  if (text === "" || text.startsWith("-")) return null;
  try {
    return parseDecimalToNativeAmount(text);
  } catch {
    return null;
  }
}

function initialLines(categoryId: string, total: number, splits: readonly SplitView[]): Line[] {
  if (splits.length > 0) {
    return splits.map((split, index) => ({ key: index, categoryId: split.categoryId, amount: minorToDecimal(split.nativeAmount) }));
  }
  return [
    { key: 0, categoryId, amount: minorToDecimal(total) },
    { key: 1, categoryId: "", amount: "" },
  ];
}

/**
 * Divides one transaction across categories (AGENTS.md §3xxx). Amounts are
 * typed in the transaction's own currency and must add up to it exactly:
 * the dialog shows what is left to assign, and Save stays off until that is
 * zero. The server checks the same sum again and writes a ledger commit.
 */
export function SplitEditorModal({
  transactionId,
  label,
  currency,
  nativeTotal,
  categoryId,
  splits,
  categories,
  triggerLabel,
}: {
  transactionId: string;
  label: string;
  currency: CurrencyCode;
  /** The transaction's amount in its own currency, minor units, signed. */
  nativeTotal: number;
  categoryId: string;
  splits: readonly SplitView[];
  /** Active categories a part can go to (not Uncategorized). */
  categories: readonly { id: string; name: string }[];
  triggerLabel: string;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>(() => initialLines(categoryId, nativeTotal, splits));
  const [nextKey, setNextKey] = useState(splits.length + 2);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);

  const total = Math.abs(nativeTotal);
  const parsed = lines.map((line) => parseLine(line.amount));
  const assigned = parsed.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const remaining = total - assigned;
  const chosen = lines.map((line) => line.categoryId).filter((id) => id !== "");
  const hasDuplicate = new Set(chosen).size !== chosen.length;
  const complete = lines.every((line, index) => line.categoryId !== "" && (parsed[index] ?? 0) > 0);
  const canSave = lines.length >= 2 && complete && !hasDuplicate && remaining === 0 && !isSaving;
  const format = (minor: number) => formatNativeAmount(nativeAmount(minor), currency);

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
  }, [isOpen]);

  function handleOpen() {
    setLines(initialLines(categoryId, nativeTotal, splits));
    setNextKey(splits.length + 2);
    setError(null);
    setIsOpen(true);
  }

  function handleClose() {
    setIsOpen(false);
    openButtonRef.current?.focus();
  }

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function handleCategoryChange(event: ChangeEvent<HTMLSelectElement>) {
    updateLine(Number(event.currentTarget.dataset.key), { categoryId: event.currentTarget.value });
  }

  function handleAmountChange(event: ChangeEvent<HTMLInputElement>) {
    updateLine(Number(event.currentTarget.dataset.key), { amount: event.currentTarget.value });
  }

  /** Puts whatever is left to assign onto this line. */
  function handleFillRest(event: MouseEvent<HTMLButtonElement>) {
    const key = Number(event.currentTarget.dataset.key);
    const index = lines.findIndex((line) => line.key === key);
    const current = parsed[index] ?? 0;
    const value = current + remaining;
    if (value > 0) updateLine(key, { amount: minorToDecimal(value) });
  }

  function handleRemoveLine(event: MouseEvent<HTMLButtonElement>) {
    const key = Number(event.currentTarget.dataset.key);
    setLines((current) => current.filter((line) => line.key !== key));
  }

  function handleAddLine() {
    setLines((current) => [...current, { key: nextKey, categoryId: "", amount: "" }]);
    setNextKey((key) => key + 1);
  }

  async function save(body: { splits: { categoryId: string; amount: string }[] }) {
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/transactions/${transactionId}/splits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: unknown };
      if (!response.ok) {
        setError(typeof result.error === "string" ? result.error : "Couldn't save the split. Try again.");
        return;
      }
      setIsOpen(false);
      router.refresh();
    } catch {
      setError("Couldn't save the split. Try again.");
    } finally {
      setIsSaving(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    void save({ splits: lines.map((line) => ({ categoryId: line.categoryId, amount: line.amount.trim() })) });
  }

  function handleUnsplit() {
    void save({ splits: [] });
  }

  const titleId = `split-title-${transactionId}`;
  const statusId = `split-status-${transactionId}`;

  return (
    <>
      <button
        ref={openButtonRef}
        type="button"
        onClick={handleOpen}
        className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-muted transition-colors hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {triggerLabel}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center whitespace-normal p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] text-left">
          <button
            type="button"
            aria-label="Close"
            onClick={handleClose}
            className="absolute inset-0 bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-y-auto rounded-lg border border-border bg-bg p-5 shadow-2xl"
          >
            <div className="mb-1 flex items-center justify-between">
              <h2 id={titleId} className="font-display text-lg font-semibold text-fg">
                Split across categories
              </h2>
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close"
                className="rounded-md p-1 text-muted hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                ✕
              </button>
            </div>
            <p className="mb-4 text-xs text-muted">
              {label} · <span className="font-tabular-figures tracking-tight">{format(nativeTotal)}</span>
            </p>

            <form onSubmit={handleSubmit} className="flex flex-col gap-3" aria-describedby={statusId}>
              {lines.map((line, index) => (
                <div key={line.key} className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={`split-category-${transactionId}-${line.key}`}>
                    Category {index + 1}
                  </label>
                  <select
                    id={`split-category-${transactionId}-${line.key}`}
                    data-key={line.key}
                    value={line.categoryId}
                    onChange={handleCategoryChange}
                    className="w-full rounded-md border border-border bg-elevated px-2 py-1.5 text-sm text-fg sm:w-auto sm:min-w-0 sm:flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">Choose a category</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                  <label className="sr-only" htmlFor={`split-amount-${transactionId}-${line.key}`}>
                    Amount {index + 1} ({CURRENCY_SYMBOLS[currency]})
                  </label>
                  <input
                    id={`split-amount-${transactionId}-${line.key}`}
                    data-key={line.key}
                    inputMode="decimal"
                    value={line.amount}
                    onChange={handleAmountChange}
                    placeholder={`${CURRENCY_SYMBOLS[currency]}0.00`}
                    className="w-28 rounded-md border border-border bg-elevated px-2 py-1.5 font-tabular-figures text-sm tracking-tight text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <button
                    type="button"
                    data-key={line.key}
                    onClick={handleFillRest}
                    disabled={remaining === 0}
                    className="rounded-md px-2 py-1 text-xs text-accent hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted"
                  >
                    Rest here
                  </button>
                  {lines.length > 2 && (
                    <button
                      type="button"
                      data-key={line.key}
                      onClick={handleRemoveLine}
                      aria-label={`Remove part ${index + 1}`}
                      className="rounded-md p-1 text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}

              <button
                type="button"
                onClick={handleAddLine}
                className="self-start rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                + Add a category
              </button>

              <p id={statusId} aria-live="polite" className={`text-sm ${remaining === 0 ? "text-positive" : "text-signature"}`}>
                {remaining === 0
                  ? complete
                    ? "Adds up exactly."
                    : "The amounts add up. Give every part a category and an amount above zero."
                  : remaining > 0
                    ? `${format(remaining)} left to assign.`
                    : `${format(-remaining)} more than the transaction.`}
                {hasDuplicate && " Each category can appear only once."}
              </p>
              {error && (
                <p role="alert" className="text-sm text-negative">
                  {error}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                {splits.length > 0 ? (
                  <button
                    type="button"
                    onClick={handleUnsplit}
                    disabled={isSaving}
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Remove split
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="submit"
                  disabled={!canSave}
                  className="uv-btn-press inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {isSaving && <Spinner />}
                  Save split
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
