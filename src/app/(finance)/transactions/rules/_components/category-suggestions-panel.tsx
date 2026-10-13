"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type ChangeEvent } from "react";
import { Badge } from "../../../../../components/badge/badge";

type RuleKeyword = { field: "merchantName" | "description"; keyword: string };

type Suggestion = {
  transactionId: string;
  occurredAt: string;
  label: string;
  amount: string;
  categoryId: string;
  categoryName: string;
  /** The merchant word a rule could match on, or null (AGENTS.md §3ooo). */
  rule: RuleKeyword | null;
};

type CategoryChoice = { id: string; name: string };

type SuggestionsResponse = {
  total: number;
  considered: number;
  suggestions: Suggestion[];
  categories: CategoryChoice[];
};

type RowChoice = { checked: boolean; categoryId: string };

/** A rule the panel offers: every ticked row with this word is going to the same category. */
export type RuleProposal = RuleKeyword & { key: string; categoryId: string; rowCount: number };

/**
 * One proposal per merchant word among the ticked rows. A word whose ticked
 * rows are going to different categories (the user changed one) is not
 * offered: a rule on it would contradict what the user just chose. Exported
 * for its own test.
 */
export function proposeRules(suggestions: readonly Suggestion[], choices: ReadonlyMap<string, RowChoice>): RuleProposal[] {
  const groups = new Map<string, { rule: RuleKeyword; categoryIds: Set<string>; rowCount: number }>();
  for (const suggestion of suggestions) {
    const choice = choices.get(suggestion.transactionId);
    if (!suggestion.rule || !choice?.checked) continue;
    const key = `${suggestion.rule.field}|${suggestion.rule.keyword.toLocaleLowerCase()}`;
    const group = groups.get(key) ?? { rule: suggestion.rule, categoryIds: new Set<string>(), rowCount: 0 };
    group.categoryIds.add(choice.categoryId);
    group.rowCount += 1;
    groups.set(key, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.categoryIds.size === 1)
    .map(([key, group]) => ({ ...group.rule, key, categoryId: [...group.categoryIds][0], rowCount: group.rowCount }))
    .sort((a, b) => b.rowCount - a.rowCount || a.keyword.localeCompare(b.keyword));
}

/**
 * AI category suggestions for transactions still in Uncategorized
 * (AGENTS.md §3kkk). Asking writes nothing; the user ticks what to keep,
 * can change any category, and only "Apply" changes the ledger. What is
 * sent to Anthropic is stated before the button, because it leaves the app.
 *
 * Each merchant word can also be kept as a rule (§3ooo), so the next
 * statement sorts itself without asking Claude. A word seen on two or more
 * ticked rows is offered ticked — a recurring merchant is the point; a word
 * from a single row is offered unticked, since one purchase is weak evidence.
 */
export function CategorySuggestionsPanel() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SuggestionsResponse | null>(null);
  const [choices, setChoices] = useState<Map<string, RowChoice>>(new Map());
  const [ruleOverrides, setRuleOverrides] = useState<Map<string, boolean>>(new Map());
  const [applied, setApplied] = useState<{ updated: number; rulesCreated: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = [...choices.entries()].filter(([, choice]) => choice.checked);
  const proposals = useMemo(() => (result ? proposeRules(result.suggestions, choices) : []), [result, choices]);
  const isRuleChecked = (proposal: RuleProposal) => ruleOverrides.get(proposal.key) ?? proposal.rowCount >= 2;
  const selectedRules = proposals.filter(isRuleChecked);
  const categoryNameById = new Map(result?.categories.map((category) => [category.id, category.name]) ?? []);

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
      setRuleOverrides(new Map());
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
          rules: selectedRules.map(({ field, keyword, categoryId }) => ({ field, keyword, categoryId })),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not apply the categories");
      setApplied({ updated: body.updated ?? 0, rulesCreated: body.rulesCreated ?? 0 });
      setResult(null);
      setChoices(new Map());
      setRuleOverrides(new Map());
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

  function handleRuleChange(event: ChangeEvent<HTMLInputElement>) {
    const key = event.currentTarget.dataset.key;
    const checked = event.currentTarget.checked;
    if (!key) return;
    setRuleOverrides((current) => new Map(current).set(key, checked));
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
            {busy
              ? "Applying…"
              : `Apply ${selected.length} categor${selected.length === 1 ? "y" : "ies"}` +
                (selectedRules.length > 0 ? ` and ${selectedRules.length} rule${selectedRules.length === 1 ? "" : "s"}` : "")}
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
          Categorized {applied.updated} transaction{applied.updated === 1 ? "" : "s"}
          {applied.rulesCreated > 0 &&
            ` and saved ${applied.rulesCreated} rule${applied.rulesCreated === 1 ? "" : "s"} for future imports`}
          .
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

          {proposals.length > 0 && (
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-medium text-muted">Also save as rules</legend>
              <p className="mb-2 text-xs text-muted">
                A rule sorts future imports from that merchant without asking Claude. Rules you write yourself still
                win.
              </p>
              <ul className="flex flex-col gap-1.5">
                {proposals.map((proposal) => (
                  <li key={proposal.key}>
                    <label className="flex items-start gap-2 text-xs text-fg">
                      <input
                        type="checkbox"
                        data-key={proposal.key}
                        checked={isRuleChecked(proposal)}
                        onChange={handleRuleChange}
                        className="mt-0.5 h-4 w-4 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <span>
                        {proposal.field === "merchantName" ? "Merchant" : "Description"} contains{" "}
                        <span className="font-medium">&ldquo;{proposal.keyword}&rdquo;</span> →{" "}
                        {categoryNameById.get(proposal.categoryId) ?? "this category"}{" "}
                        <span className="text-muted">({proposal.rowCount} here)</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
        </div>
      )}
    </section>
  );
}
