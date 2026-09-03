import { z } from "zod";
import { compareAgorot, parseShekelsToAgorot, type Agorot } from "../money";
import { containsWholeWord } from "../text-matching";

/**
 * Tier 0 of the categorization pipeline — user-defined deterministic
 * rules, evaluated BEFORE the existing 4-tier cascade
 * (`src/lib/categorization/cascade.ts`) on both CSV import and manual
 * entry. Same `src/lib/` convention as every other engine in this app
 * (AGENTS.md §3b): pure functions over already-fetched data, no DAL/DB
 * access — `src/server/dal/transaction-rules.ts` and the pipeline call
 * sites own I/O.
 */

// ---------------------------------------------------------------------
// Zod schemas — the validated shape `TransactionRule.conditions`/`.actions`
// (Json columns, schema.prisma) are stored as, checked at the API
// boundary whenever a rule is created or updated. Never re-validated at
// evaluation time — `applyRules` below trusts its input the same way
// `cascade.ts`'s tiers trust theirs.
// ---------------------------------------------------------------------

const TextOperatorSchema = z.enum(["equals", "contains"]);

function isValidShekelString(value: string): boolean {
  try {
    parseShekelsToAgorot(value);
    return true;
  } catch {
    return false;
  }
}

export const MerchantNameConditionSchema = z.object({
  field: z.literal("merchantName"),
  operator: TextOperatorSchema,
  value: z.string().trim().min(1).max(200),
});

export const DescriptionConditionSchema = z.object({
  field: z.literal("description"),
  operator: TextOperatorSchema,
  value: z.string().trim().min(1).max(200),
});

/**
 * `value` is a shekel-string ("125.50", "-40.00"), the SAME wire
 * convention every other money-bearing input in this app already uses
 * (Budget's `monthlyLimit`, the tax simulator's income fields, etc.) —
 * parsed via `money.ts`'s own `parseShekelsToAgorot`, never a raw JSON
 * number, per the "money is never a float" law. Validated eagerly here
 * (`.refine`) so a malformed amount condition can never be stored and
 * only fail later, mid-evaluation. Comparisons happen against the
 * transaction's own SIGNED agorot amount (negative for an expense, per
 * `NotableTransaction.amount`'s own convention) — an "amount
 * greaterThan -50.00" condition matches any expense smaller in
 * magnitude than ₪50, exactly as it reads.
 */
export const AmountConditionSchema = z.object({
  field: z.literal("amount"),
  operator: z.enum(["equals", "greaterThan", "lessThan"]),
  value: z.string().refine(isValidShekelString, { message: "Not a valid shekel amount" }),
});

export const RuleConditionSchema = z.discriminatedUnion("field", [
  MerchantNameConditionSchema,
  DescriptionConditionSchema,
  AmountConditionSchema,
]);
export type RuleCondition = z.infer<typeof RuleConditionSchema>;

/** A rule matches only when EVERY condition matches (AND semantics) — no OR/grouping in this v1, matching the deliberately narrow "exact-match/contains" scope. */
export const RuleConditionsSchema = z.array(RuleConditionSchema).min(1).max(10);

/**
 * `categorize`'s target is a category SLUG, not a raw database id — the
 * same "permanent slugs" law Tier 2's own `DEFAULT_CATEGORY_RULES`
 * already follow (`tier2-rules.ts`), so a rule keeps working after the
 * user renames the category it points to. Resolved to this user's
 * actual category row the same way Tier 2 already is, via a
 * `resolveCategoryIdBySlug` callback — see `applyTransactionRulesTier`
 * below.
 */
export const CategorizeActionSchema = z.object({
  type: z.literal("categorize"),
  categorySlug: z.string().trim().min(1).max(60),
});

export const RenameActionSchema = z.object({
  type: z.literal("rename"),
  value: z.string().trim().min(1).max(200),
});

/** Forces (or clears) `needsReview` regardless of what the downstream cascade tiers would otherwise conclude. */
export const FlagActionSchema = z.object({
  type: z.literal("flag"),
  value: z.boolean(),
});

export const RuleActionSchema = z.discriminatedUnion("type", [CategorizeActionSchema, RenameActionSchema, FlagActionSchema]);
export type RuleAction = z.infer<typeof RuleActionSchema>;

export const RuleActionsSchema = z.array(RuleActionSchema).min(1).max(10);

// ---------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------

export type TransactionRuleData = {
  merchantName?: string | null;
  description: string;
  /** Signed agorot — negative for an expense, matching `NotableTransaction.amount`'s own convention. */
  amountAgorot: Agorot;
};

/** What `applyRules` needs from a stored `TransactionRule` row — deliberately not the raw Prisma row shape, so this stays testable with plain object literals. */
export type StoredTransactionRule = {
  id: string;
  priority: number;
  isActive: boolean;
  conditions: readonly RuleCondition[];
  actions: readonly RuleAction[];
};

export type RuleEvaluationResult = {
  /** Set by the first (lowest-`priority`) matching rule with a `categorize` action — a later match never overrides it. */
  categorySlug?: string;
  /** Set by the first matching rule with a `rename` action. */
  renamedMerchantName?: string;
  /** Set by the first matching rule with a `flag` action. */
  forceNeedsReview?: boolean;
  /** Every rule that matched, in evaluation order — for observability/audit logging by the caller; this pure function itself persists nothing. */
  matchedRuleIds: string[];
};

/**
 * `contains` goes through `text-matching.ts`'s Unicode-aware whole-word
 * matcher (the same one Tier 2's keyword rules use), not a plain
 * substring check — law #4's Hebrew `\b`-boundary bug applies just as
 * much to a user-authored rule condition as to an app-default keyword
 * list. `equals` is a case-insensitive exact match, same case-folding
 * `contains` already gets from that matcher's own `i` flag.
 */
function evaluateTextCondition(haystack: string, operator: "equals" | "contains", needle: string): boolean {
  if (operator === "equals") {
    return haystack.trim().toLowerCase() === needle.trim().toLowerCase();
  }
  return containsWholeWord(haystack, needle);
}

function evaluateAmountCondition(
  amount: Agorot,
  operator: "equals" | "greaterThan" | "lessThan",
  value: string,
): boolean {
  const threshold = parseShekelsToAgorot(value);
  const comparison = compareAgorot(amount, threshold);
  if (operator === "equals") return comparison === 0;
  if (operator === "greaterThan") return comparison > 0;
  return comparison < 0;
}

function evaluateCondition(transaction: TransactionRuleData, condition: RuleCondition): boolean {
  switch (condition.field) {
    case "merchantName":
      return evaluateTextCondition(transaction.merchantName ?? "", condition.operator, condition.value);
    case "description":
      return evaluateTextCondition(transaction.description, condition.operator, condition.value);
    case "amount":
      return evaluateAmountCondition(transaction.amountAgorot, condition.operator, condition.value);
  }
}

/**
 * Evaluates `rules` against `transaction`, applying every matching
 * rule's actions. Only active rules are considered, evaluated in
 * `priority` ascending order (lower runs first) — this function sorts
 * defensively rather than trusting the caller's array order, so it's
 * correct regardless of how `rules` was fetched.
 *
 * `categorySlug`/`renamedMerchantName`/`forceNeedsReview` are each set
 * by the FIRST matching rule that includes that kind of action; a
 * later, lower-priority rule's conflicting action is never applied —
 * the same "first confident tier wins" convention the surrounding
 * 4-tier cascade already follows (AGENTS.md §3b), rather than a
 * last-write-wins or compounding rule.
 */
export function applyRules(
  transaction: TransactionRuleData,
  rules: readonly StoredTransactionRule[],
): RuleEvaluationResult {
  const result: RuleEvaluationResult = { matchedRuleIds: [] };

  const activeRulesInPriorityOrder = rules
    .filter((rule) => rule.isActive)
    .slice()
    .sort((a, b) => a.priority - b.priority);

  for (const rule of activeRulesInPriorityOrder) {
    const allConditionsMatch = rule.conditions.every((condition) => evaluateCondition(transaction, condition));
    if (!allConditionsMatch) continue;

    result.matchedRuleIds.push(rule.id);

    for (const action of rule.actions) {
      if (action.type === "categorize" && result.categorySlug === undefined) {
        result.categorySlug = action.categorySlug;
      } else if (action.type === "rename" && result.renamedMerchantName === undefined) {
        result.renamedMerchantName = action.value;
      } else if (action.type === "flag" && result.forceNeedsReview === undefined) {
        result.forceNeedsReview = action.value;
      }
    }
  }

  return result;
}
