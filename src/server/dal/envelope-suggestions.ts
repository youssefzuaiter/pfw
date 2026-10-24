import { monthKeyToExclusiveEndDate, monthKeyToStartDate, shiftMonthKey } from "../../lib/date-month";
import { SUGGESTION_MONTHS, suggestEnvelopeAmounts } from "../../lib/envelope-suggestions";
import { agorot, type Agorot } from "../../lib/money";
import { withUserScope } from "../db/with-user-scope";
import { allocateInTransaction, availableToBudgetInTransaction, getAvailableToBudget, getEnvelopeBalances } from "./envelopes";
import { getMonthlyIncomeExpenseHistory, getSpendByCategoryInRange } from "./transactions";

export type EnvelopeSuggestionRow = {
  categoryId: string;
  categoryName: string;
  averageAgorot: number;
  suggestedAgorot: number;
};

export type EnvelopeSuggestions = {
  month: string;
  /** How many of the months looked at had any activity; the average is over these. */
  monthsUsed: number;
  availableAgorot: Agorot;
  /** Only envelopes with nothing set for `month` yet; one already set is never overwritten. */
  suggestions: EnvelopeSuggestionRow[];
};

/**
 * Suggested envelope amounts for `month` (AGENTS.md §3mmmm), from what each
 * category cost in the up to `SUGGESTION_MONTHS` complete months before it.
 * Reads only: nothing is written until the user applies.
 */
export async function listEnvelopeSuggestions(userId: string, month: string): Promise<EnvelopeSuggestions> {
  const windows = Array.from({ length: SUGGESTION_MONTHS }, (_, i) => shiftMonthKey(month, -(i + 1)));
  const from = monthKeyToStartDate(windows[windows.length - 1]);
  const to = monthKeyToStartDate(month);

  const [activity, spendPerMonth, balances, available] = await Promise.all([
    getMonthlyIncomeExpenseHistory(userId, from, to),
    Promise.all(windows.map((key) => getSpendByCategoryInRange(userId, monthKeyToStartDate(key), monthKeyToExclusiveEndDate(key)))),
    getEnvelopeBalances(userId, month),
    getAvailableToBudget(userId, month),
  ]);

  const monthsUsed = new Set(activity.map((m) => m.monthKey)).size;
  const totals = new Map<string, number>();
  for (const rows of spendPerMonth) {
    for (const row of rows) totals.set(row.categoryId, (totals.get(row.categoryId) ?? 0) + Number(row.totalAgorot));
  }

  const open = new Map(balances.filter((b) => b.allocatedThisMonthAgorot === 0).map((b) => [b.categoryId, b.categoryName]));
  const suggestions = suggestEnvelopeAmounts(totals, monthsUsed)
    .filter((s) => open.has(s.categoryId))
    .map((s) => ({ ...s, categoryName: open.get(s.categoryId)! }));

  return { month, monthsUsed, availableAgorot: available, suggestions };
}

export type ApplyEnvelopeSuggestionsResult =
  | { ok: true; applied: number; totalAgorot: Agorot }
  | { ok: false; error: "exceeds_available"; availableAgorot: Agorot; requestedAgorot: Agorot }
  | { ok: false; error: "category_not_found" | "already_set" };

export const MAX_SUGGESTION_ITEMS = 100;

/**
 * Sets the chosen envelopes for `month`, all or nothing in one transaction.
 * The request is untrusted: every category must be the caller's, must have
 * nothing set for the month yet (a suggestion never overwrites a budget the
 * user chose), and the total may not exceed what is available to budget, which
 * is read in the same transaction as the writes.
 */
export async function applyEnvelopeSuggestions(
  userId: string,
  month: string,
  items: readonly { categoryId: string; amountAgorot: Agorot }[],
): Promise<ApplyEnvelopeSuggestionsResult> {
  if (items.length === 0 || items.length > MAX_SUGGESTION_ITEMS) {
    throw new RangeError(`Apply takes between 1 and ${MAX_SUGGESTION_ITEMS} envelopes`);
  }
  if (new Set(items.map((item) => item.categoryId)).size !== items.length) {
    throw new RangeError("Each envelope can be set only once");
  }

  return withUserScope(userId, async (tx): Promise<ApplyEnvelopeSuggestionsResult> => {
    const categories = await tx.category.findMany({ where: { userId, id: { in: items.map((i) => i.categoryId) }, archivedAt: null, isUncategorized: false }, select: { id: true } });
    if (categories.length !== items.length) return { ok: false, error: "category_not_found" };

    const existing = await tx.envelopeAllocation.findMany({
      where: { userId, month, categoryId: { in: items.map((i) => i.categoryId) }, amountAgorot: { not: 0n } },
      select: { categoryId: true },
    });
    if (existing.length > 0) return { ok: false, error: "already_set" };

    const requested = agorot(items.reduce((sum, item) => sum + item.amountAgorot, 0));
    const available = await availableToBudgetInTransaction(tx, userId, month);
    if (requested > available) return { ok: false, error: "exceeds_available", availableAgorot: available, requestedAgorot: requested };

    for (const item of items) {
      const result = await allocateInTransaction(tx, userId, item.categoryId, item.amountAgorot, month);
      if (!result.ok) return { ok: false, error: "category_not_found" };
    }
    return { ok: true, applied: items.length, totalAgorot: requested };
  });
}
