"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent } from "react";
import { Badge } from "../../../../../components/badge/badge";

type Suggestion = {
  transactionId: string;
  occurredAt: string;
  label: string;
  amount: string;
  categoryId: string;
  categoryName: string;
};

type CategoryChoice = { id: string; name: string };

type SuggestionsResponse = {
  total: number;
  considered: number;
  suggestions: Suggestion[];
  categories: CategoryChoice[];
};

type RowChoice = { checked: boolean; categoryId: string };

/**
 * AI category suggestions for transactions still in Uncategorized
 * (AGENTS.md §3kkk). Asking writes nothing; the user ticks what to keep,
 * can change any category, and only "Apply" changes the ledger. What is
 * sent to Anthropic is stated before the button, because it leaves the app.
 */
export function CategorySuggestionsPanel() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SuggestionsResponse | null>(null);
  const [choices, setChoices] = useState<Map<string, RowChoice>>(new Map());
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = [...choices.entries()].filter(([, choice]) => choice.checked);

  async function handleSuggestClick() {
    setBusy(true);
    setError(null);
    setApplied(null);
    try {
      const response = await fetch("/api/transactions/category-suggestions", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not get suggestions");
      const data = body as SuggestionsResponse;
      setResult(data);
      setChoices(new Map(data.suggestions.map((s) => [s.transactionId, { checked: true, categoryId: s.categoryId }])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not get suggestions");
    } finally {
      setBusy(false);
    }
  }

  async function handleApplyClick() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/transactions/category-suggestions/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          choices: selected.map(([transactionId, choice]) => ({ transactionId, categoryId: choice.categoryId })),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not apply the categories");
      setApplied(body.updated ?? 0);
      setResult(null);
      setChoices(new Map());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the categories");
    } finally {
      setBusy(false);
    }
  }

  function handleCheckChange(event: ChangeEvent<HTMLInputElement>) {
    const id = event.currentTarget.dataset.id;
    const checked = event.currentTarget.checked;
    if (!id) return;
    setChoices((current) => {
      const next = new Map(current);
      const choice = next.get(id);
      if (choice) next.set(id, { ...choice, checked });
      return next;
    });
  }

  function handleCategoryChange(event: ChangeEvent<HTMLSelectElement>) {
    const id = event.currentTarget.dataset.id;
    const categoryId = event.currentTarget.value;
    if (!id) return;
    setChoices((current) => {
      const next = new Map(current);
      const choice = next.get(id);
      if (choice) next.set(id, { ...choice, categoryId });
      return next;
    });
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="category-suggestions-heading">
      <h2 id="category-suggestions-heading" className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
        Suggest categories with AI
      </h2>
      <p className="mb-3 text-xs text-muted">
        Sends the merchant, description, amount and date of up to 200 uncategorized transactions, and your category
        names, to Anthropic&rsquo;s Claude. Nothing changes until you apply. Each category you apply is also learned, so
        the next import from the same merchant is placed automatically.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSuggestClick}
          disabled={busy}
          className="rounded-md border border-border bg-elevated px-3 py-2 text-sm text-fg transition-colors hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy && !result ? "Asking Claude…" : "Get suggestions"}
        </button>

        {result && selected.length > 0 && (
          <button
            type="button"
            onClick={handleApplyClick}
            disabled={busy}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {busy ? "Applying…" : `Apply ${selected.length} categor${selected.length === 1 ? "y" : "ies"}`}
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-sm text-negative" role="alert">
          {error}
        </p>
      )}

      {applied !== null && (
        <p className="mt-2 text-sm text-positive" role="status">
          Categorized {applied} transaction{applied === 1 ? "" : "s"}.
        </p>
      )}

      {result && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="neutral">{result.suggestions.length} suggested</Badge>
            {result.considered - result.suggestions.length > 0 && (
              <Badge variant="warning">{result.considered - result.suggestions.length} with no confident match</Badge>
            )}
            {result.total > result.considered && (
              <Badge variant="neutral">{result.total - result.considered} more left for the next run</Badge>
            )}
          </div>

          {result.suggestions.length === 0 ? (
            <p className="text-xs text-muted">
              {result.total === 0
                ? "Nothing is uncategorized."
                : "Claude found no confident match. Try adding a category or a rule for these merchants."}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Suggested categories for uncategorized transactions</caption>
                <thead className="bg-elevated text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Apply</th>
                    <th scope="col" className="px-3 py-2 font-medium">Date</th>
                    <th scope="col" className="px-3 py-2 font-medium">Transaction</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
                    <th scope="col" className="px-3 py-2 font-medium">Category</th>
                  </tr>
                </thead>
                <tbody>
                  {result.suggestions.map((suggestion) => {
                    const choice = choices.get(suggestion.transactionId);
                    return (
                      <tr key={suggestion.transactionId} className="border-t border-border">
                        <td className="px-3 py-1.5">
                          <input
                            type="checkbox"
                            data-id={suggestion.transactionId}
                            checked={choice?.checked ?? false}
                            onChange={handleCheckChange}
                            aria-label={`Apply a category to ${suggestion.label}`}
                            className="h-4 w-4 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 font-tabular-figures text-muted">
                          {suggestion.occurredAt}
                        </td>
                        <td className="max-w-[280px] truncate px-3 py-1.5 text-fg">{suggestion.label}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-tabular-figures text-fg">
                          {suggestion.amount}
                        </td>
                        <td className="px-3 py-1.5">
                          <select
                            data-id={suggestion.transactionId}
                            value={choice?.categoryId ?? suggestion.categoryId}
                            onChange={handleCategoryChange}
                            aria-label={`Category for ${suggestion.label}`}
                            className="rounded-md border border-border bg-elevated px-2 py-1 text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {result.categories.map((category) => (
                              <option key={category.id} value={category.id}>
                                {category.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
