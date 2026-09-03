import Link from "next/link";
import { getCurrentUser } from "../../../server/auth/current-user";
import { listCategories } from "../../../server/dal/categories";
import { listTransactionRules } from "../../../server/dal/transaction-rules";
import { CreateRuleForm } from "./_components/create-rule-form";
import { RuleRowActions } from "./_components/rule-row-actions";

export const instant = false;

const FIELD_LABEL: Record<string, string> = { merchantName: "Merchant name", description: "Description", amount: "Amount" };
const OPERATOR_LABEL: Record<string, string> = {
  equals: "equals",
  contains: "contains",
  greaterThan: "is greater than",
  lessThan: "is less than",
};

function summarizeCondition(condition: { field: string; operator: string; value: string }): string {
  return `${FIELD_LABEL[condition.field] ?? condition.field} ${OPERATOR_LABEL[condition.operator] ?? condition.operator} "${condition.value}"`;
}

function summarizeAction(action: { type: string; categorySlug?: string; value?: string | boolean }): string {
  if (action.type === "categorize") return `set category to "${action.categorySlug}"`;
  if (action.type === "rename") return `rename merchant to "${action.value}"`;
  return `${action.value ? "flag" : "clear the flag on"} for review`;
}

/**
 * Tier 0 rule management (the rule-engine plan) — a "simple" screen per
 * the task's own scope: view, create, and toggle rules. Reachable by
 * direct link from `/transactions`, not one of `PRIMARY_NAV_ITEMS`, same
 * "sub-view, not one of the spec's 9 primary destinations" pattern as
 * `/transactions/subscriptions`.
 */
export default async function TransactionRulesPage() {
  const user = await getCurrentUser();
  const [rules, categories] = await Promise.all([listTransactionRules(user.id), listCategories(user.id)]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-fg">Transaction rules</h1>
          <p className="mt-1 text-sm text-muted">
            Deterministic rules run first, on both CSV import and manual entry — before the automatic categorization
            engine ever sees a transaction.
          </p>
        </div>
        <Link
          href="/transactions"
          className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ← Transactions
        </Link>
      </div>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">New rule</h2>
        <CreateRuleForm categories={categories.map((c) => ({ slug: c.slug, name: c.name }))} />
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Rules ({rules.length})</h2>
        {rules.length === 0 ? (
          <p className="text-sm text-muted">No rules yet — every transaction goes straight to the categorization engine.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className={`flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0 ${
                  rule.isActive ? "" : "opacity-60"
                }`}
              >
                <div>
                  <p className="font-medium text-fg">
                    {rule.name} <span className="font-tabular-figures text-xs text-muted">priority {rule.priority}</span>
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    If {rule.conditions.map(summarizeCondition).join(" AND ")}, then {rule.actions.map(summarizeAction).join("; ")}.
                  </p>
                </div>
                <RuleRowActions rule={{ id: rule.id, isActive: rule.isActive }} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
