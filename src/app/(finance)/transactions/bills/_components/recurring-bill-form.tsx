"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Spinner } from "../../../../../components/spinner/spinner";
import { SUPPORTED_CURRENCIES, type CurrencyCode } from "../../../../../lib/currency";

export type CadenceValue = "monthly" | "quarterly" | "annual";
export type ItemKind = "bill" | "subscription";

/** The words each page uses, so neither page talks about the other's items. */
export const KIND_WORDS: Record<ItemKind, { noun: string; namePlaceholder: string; addLabel: string }> = {
  bill: { noun: "bill", namePlaceholder: "Electricity", addLabel: "Save bill" },
  subscription: { noun: "subscription", namePlaceholder: "Netflix", addLabel: "Save subscription" },
};

const CADENCES: readonly { value: CadenceValue; label: string }[] = [
  { value: "monthly", label: "Every month" },
  { value: "quarterly", label: "Every 3 months" },
  { value: "annual", label: "Every year" },
];

/** A bill as the form edits it: the amount as the text the user would type. */
export type EditableBill = {
  id: string;
  kind: ItemKind;
  name: string;
  amount: string;
  /** Billed by use: a different amount every time. */
  amountVaries: boolean;
  currency: CurrencyCode;
  cadence: CadenceValue;
  anchorDate: string;
  categoryId: string | null;
};

type Props = {
  categories: readonly { id: string; name: string }[];
  /** Which page the item belongs to when adding a new one. Ignored when editing: an item keeps its kind. */
  kind?: ItemKind;
  /** Given, the form edits that bill instead of adding a new one. */
  bill?: EditableBill;
  /** Called after a successful save, once the page has been refreshed. */
  onDone?: () => void;
};

const FIELD =
  "rounded-md border border-border bg-elevated px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Adds a bill or a subscription by hand, or edits one (AGENTS.md §3cccc, §3eeee). The
 * date is any date the bill is due; later due dates follow from how often it
 * repeats, so there is nothing to keep up to date.
 */
export function RecurringBillForm({ categories, kind = "bill", bill, onDone }: Props) {
  const router = useRouter();
  const idBase = useId();
  const [name, setName] = useState(bill?.name ?? "");
  const [amount, setAmount] = useState(bill?.amount ?? "");
  const [amountVaries, setAmountVaries] = useState(bill?.amountVaries ?? false);
  const [currency, setCurrency] = useState<CurrencyCode>(bill?.currency ?? "ILS");
  const [cadence, setCadence] = useState<CadenceValue>(bill?.cadence ?? "monthly");
  const [anchorDate, setAnchorDate] = useState(bill?.anchorDate ?? todayIso());
  const [categoryId, setCategoryId] = useState(bill?.categoryId ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = bill !== undefined;
  const itemKind: ItemKind = bill?.kind ?? kind;
  const words = KIND_WORDS[itemKind];

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !amount.trim() || !anchorDate) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch(isEdit ? `/api/recurring-bills/${bill.id}` : "/api/recurring-bills", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          amount: amount.trim(),
          currency,
          cadence,
          anchorDate,
          categoryId: categoryId || null,
          amountVaries,
          ...(isEdit ? {} : { kind: itemKind }),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? (isEdit ? `Failed to save the ${words.noun}` : `Failed to add the ${words.noun}`));
      }
      if (!isEdit) {
        setName("");
        setAmount("");
        setAmountVaries(false);
        setAnchorDate(todayIso());
        setCategoryId("");
      }
      router.refresh();
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to save the ${words.noun}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleVariesChange(event: React.ChangeEvent<HTMLInputElement>) {
    setAmountVaries(event.target.checked);
  }

  const id = (field: string) => `${idBase}-${field}`;

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={id("name")} className="text-xs font-medium text-muted">
          Name
        </label>
        <input
          id={id("name")}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          placeholder={words.namePlaceholder}
          className={`min-w-[150px] ${FIELD}`}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id("amount")} className="text-xs font-medium text-muted">
          {amountVaries ? "Typical amount" : "Amount"}
        </label>
        <input
          id={id("amount")}
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="49.90"
          className={`w-28 font-tabular-figures tracking-tight ${FIELD}`}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id("currency")} className="text-xs font-medium text-muted">
          Currency
        </label>
        <select id={id("currency")} value={currency} onChange={(event) => setCurrency(event.target.value as CurrencyCode)} className={FIELD}>
          {SUPPORTED_CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id("cadence")} className="text-xs font-medium text-muted">
          Repeats
        </label>
        <select id={id("cadence")} value={cadence} onChange={(event) => setCadence(event.target.value as CadenceValue)} className={FIELD}>
          {CADENCES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id("date")} className="text-xs font-medium text-muted">
          Due date
        </label>
        <input
          id={id("date")}
          type="date"
          value={anchorDate}
          onChange={(event) => setAnchorDate(event.target.value)}
          aria-describedby={id("date-help")}
          className={FIELD}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id("category")} className="text-xs font-medium text-muted">
          Category (optional)
        </label>
        <select id={id("category")} value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className={FIELD}>
          <option value="">None</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex w-full flex-col gap-1">
        <label htmlFor={id("varies")} className="flex items-center gap-2 text-sm text-fg">
          <input
            id={id("varies")}
            type="checkbox"
            checked={amountVaries}
            onChange={handleVariesChange}
            aria-describedby={id("varies-help")}
            className="h-4 w-4 rounded border-border bg-elevated accent-[var(--pfw-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          The amount is different every time
        </label>
        <p id={id("varies-help")} className="text-xs text-muted">
          For a bill billed by use, like electricity or water. Its payments are recognised by name whatever the amount, and
          what it is expected to cost becomes the average of its last three payments. The typical amount is only the
          starting guess.
        </p>
      </div>
      <p id={id("date-help")} className="w-full text-xs text-muted">
        Any date it is or was due: later dates follow from how often it repeats. A category lets Safe to Spend see that
        an envelope already holds the money for it.
      </p>
      <button
        type="submit"
        disabled={isSubmitting}
        className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        {isSubmitting ? "Saving…" : isEdit ? "Save changes" : words.addLabel}
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-negative">
          {error}
        </p>
      )}
    </form>
  );
}
