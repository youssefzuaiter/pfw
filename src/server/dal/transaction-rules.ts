import "server-only";
import type { Prisma } from "../../generated/prisma/client";
import { RuleActionsSchema, RuleConditionsSchema, type RuleAction, type RuleCondition, type StoredTransactionRule } from "../../lib/categorization/rule-engine";
import { withUserScope, type ScopedTransactionClient } from "../db/with-user-scope";

export type TransactionRuleRecord = {
  id: string;
  name: string;
  priority: number;
  isActive: boolean;
  conditions: RuleCondition[];
  actions: RuleAction[];
  createdAt: Date;
  updatedAt: Date;
};

type RawTransactionRuleRow = {
  id: string;
  name: string;
  priority: number;
  isActive: boolean;
  conditions: Prisma.JsonValue;
  actions: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Re-parses a row's `conditions`/`actions` `Json` columns back into their
 * typed shape via the SAME Zod schemas that validated them at write time
 * (`rule-engine.ts`) — cheap, and a real defense against a hypothetical
 * malformed row (a direct DB edit, a future migration), rather than
 * blindly trusting the database. Throws on a genuinely malformed row —
 * the same "a real bug to surface loudly, not paper over" posture other
 * parse-on-read paths in this app take.
 */
function toRecord(row: RawTransactionRuleRow): TransactionRuleRecord {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    isActive: row.isActive,
    conditions: RuleConditionsSchema.parse(row.conditions),
    actions: RuleActionsSchema.parse(row.actions),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Every rule owned by `userId`, in the order the management screen shows them — priority ascending, ties broken by creation order. */
export async function listTransactionRules(userId: string): Promise<TransactionRuleRecord[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.transactionRule.findMany({ where: { userId }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] }),
  );
  return rows.map(toRecord);
}

function toStoredRule(record: TransactionRuleRecord): StoredTransactionRule {
  return {
    id: record.id,
    priority: record.priority,
    isActive: record.isActive,
    conditions: record.conditions,
    actions: record.actions,
  };
}

/**
 * Every ACTIVE rule, in the exact order `rule-engine.ts`'s `applyRules`
 * expects (priority ascending) — using an ALREADY-OPEN scoped
 * transaction client, not a fresh `withUserScope` call. This is the one
 * the categorization pipeline's Tier 0 actually calls
 * (`transaction-import.ts`, `transactions.ts`'s `createTransaction`),
 * and both of those callers already hold their own `tx` inside their
 * own `withUserScope` block — opening a second, nested one here would
 * mean grabbing a second connection from the pool mid-transaction for
 * no reason, not just redundant ceremony. `listActiveTransactionRulesForEvaluation`
 * below is the version for a caller that ISN'T already inside one.
 */
export async function fetchActiveRulesForEvaluation(
  tx: ScopedTransactionClient,
  userId: string,
): Promise<StoredTransactionRule[]> {
  const rows = await tx.transactionRule.findMany({
    where: { userId, isActive: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toRecord).map(toStoredRule);
}

/** Same as `fetchActiveRulesForEvaluation`, but opens its own scoped transaction — for a caller with no `tx` of its own already open. */
export async function listActiveTransactionRulesForEvaluation(userId: string): Promise<StoredTransactionRule[]> {
  return withUserScope(userId, (tx) => fetchActiveRulesForEvaluation(tx, userId));
}

/** See bank-accounts.ts for why this returns `null` rather than throwing on a mismatch. */
export async function getTransactionRuleById(userId: string, id: string): Promise<TransactionRuleRecord | null> {
  const row = await withUserScope(userId, (tx) => tx.transactionRule.findFirst({ where: { id, userId } }));
  return row ? toRecord(row) : null;
}

export type TransactionRuleInput = {
  name: string;
  priority: number;
  isActive: boolean;
  conditions: readonly RuleCondition[];
  actions: readonly RuleAction[];
};

export async function createTransactionRule(userId: string, input: TransactionRuleInput): Promise<TransactionRuleRecord> {
  const row = await withUserScope(userId, (tx) =>
    tx.transactionRule.create({
      data: {
        userId,
        name: input.name,
        priority: input.priority,
        isActive: input.isActive,
        // `conditions`/`actions` are Zod-validated discriminated unions
        // (plain, JSON-serializable objects) by the time they reach this
        // function — the cast is only bridging Prisma's `InputJsonValue`
        // type, not skipping any validation.
        conditions: input.conditions as unknown as Prisma.InputJsonValue,
        actions: input.actions as unknown as Prisma.InputJsonValue,
      },
    }),
  );
  return toRecord(row);
}

export type UpdateTransactionRuleInput = Partial<TransactionRuleInput>;

/** Returns `null` on an ownership mismatch, same convention as every other DAL updater — an update to another user's rule is indistinguishable from one that doesn't exist. */
export async function updateTransactionRule(
  userId: string,
  id: string,
  input: UpdateTransactionRuleInput,
): Promise<TransactionRuleRecord | null> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.transactionRule.findFirst({ where: { id, userId } });
    if (!existing) return null;

    const row = await tx.transactionRule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.conditions !== undefined ? { conditions: input.conditions as unknown as Prisma.InputJsonValue } : {}),
        ...(input.actions !== undefined ? { actions: input.actions as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    return toRecord(row);
  });
}

export type DeleteTransactionRuleResult = { ok: true } | { ok: false; error: "not_found" };

export async function deleteTransactionRule(userId: string, id: string): Promise<DeleteTransactionRuleResult> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.transactionRule.findFirst({ where: { id, userId } });
    if (!existing) return { ok: false, error: "not_found" };
    await tx.transactionRule.delete({ where: { id } });
    return { ok: true };
  });
}

/** A rule the user accepted from an AI suggestion (AGENTS.md §3ooo): "the merchant/description contains `keyword`" → `categoryId`. */
export type SuggestedRuleInput = {
  field: "merchantName" | "description";
  keyword: string;
  categoryId: string;
};

/**
 * Rules saved from AI suggestions run after a hand-written rule, whose
 * default priority is 0 — so if the two ever disagree, the one the user
 * wrote themselves wins.
 */
export const SUGGESTED_RULE_PRIORITY = 100;

/** The longest rule name the rules route accepts. */
const MAX_RULE_NAME_LENGTH = 80;

/**
 * Creates one `contains` → `categorize` rule per accepted suggestion, in one
 * transaction. Skipped, not failed: a category that is not this user's (or
 * is archived, or is Uncategorized), an empty keyword, and a keyword that
 * already has a single-condition rule on the same field — whatever that
 * rule does, a second one on the same word would either repeat it or lose
 * to it, so neither is worth saving.
 */
export async function createRulesFromSuggestions(
  userId: string,
  rules: readonly SuggestedRuleInput[],
): Promise<{ created: number; skipped: number }> {
  if (rules.length === 0) return { created: 0, skipped: 0 };
  return withUserScope(userId, async (tx) => {
    const categories = await tx.category.findMany({
      where: { userId, id: { in: [...new Set(rules.map((rule) => rule.categoryId))] }, archivedAt: null, isUncategorized: false },
      select: { id: true, slug: true, name: true },
    });
    const categoryById = new Map(categories.map((category) => [category.id, category]));

    const existing = await tx.transactionRule.findMany({ where: { userId }, select: { conditions: true } });
    const taken = new Set<string>();
    for (const row of existing) {
      const parsed = RuleConditionsSchema.safeParse(row.conditions);
      if (!parsed.success || parsed.data.length !== 1) continue;
      const [condition] = parsed.data;
      if (condition.field !== "amount") taken.add(ruleKey(condition.field, condition.value));
    }

    let created = 0;
    for (const rule of rules) {
      const category = categoryById.get(rule.categoryId);
      const keyword = rule.keyword.trim();
      const key = ruleKey(rule.field, keyword);
      if (!category || keyword.length === 0 || taken.has(key)) continue;
      taken.add(key);
      await tx.transactionRule.create({
        data: {
          userId,
          name: `${keyword} → ${category.name}`.slice(0, MAX_RULE_NAME_LENGTH),
          priority: SUGGESTED_RULE_PRIORITY,
          isActive: true,
          conditions: [{ field: rule.field, operator: "contains", value: keyword }] as unknown as Prisma.InputJsonValue,
          actions: [{ type: "categorize", categorySlug: category.slug }] as unknown as Prisma.InputJsonValue,
        },
      });
      created += 1;
    }
    return { created, skipped: rules.length - created };
  });
}

function ruleKey(field: string, value: string): string {
  return `${field}|${value.trim().toLocaleLowerCase()}`;
}
