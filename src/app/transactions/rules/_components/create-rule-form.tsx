"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent, type MouseEvent } from "react";
import { Spinner } from "../../../../components/spinner/spinner";

type ConditionField = "merchantName" | "description" | "amount";
type ConditionRow = { field: ConditionField; operator: string; value: string };
type ActionType = "categorize" | "rename" | "flag";
type ActionRow = { type: ActionType; categorySlug: string; renameValue: string; flagValue: boolean };

const OPERATORS_BY_FIELD: Record<ConditionField, { value: string; label: string }[]> = {
  merchantName: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "equals" },
  ],
  description: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "equals" },
  ],
  amount: [
    { value: "equals", label: "equals" },
    { value: "greaterThan", label: "is greater than" },
    { value: "lessThan", label: "is less than" },
  ],
};

function newCondition(): ConditionRow {
  return { field: "merchantName", operator: "contains", value: "" };
}

function newAction(defaultCategorySlug: string): ActionRow {
  return { type: "categorize", categorySlug: defaultCategorySlug, renameValue: "", flagValue: true };
}

/**
 * A "simple" rule builder per the task's own scope: a name, a priority,
 * one or more AND-ed conditions, one or more actions — no OR/grouping,
 * matching `rule-engine.ts`'s own deliberately narrow v1 shape.
 */
export function CreateRuleForm({ categories }: { categories: { slug: string; name: string }[] }) {
  const router = useRouter();
  const defaultCategorySlug = categories[0]?.slug ?? "";

  const [name, setName] = useState("");
  const [priority, setPriority] = useState("0");
  const [conditions, setConditions] = useState<ConditionRow[]>([newCondition()]);
  const [actions, setActions] = useState<ActionRow[]>([newAction(defaultCategorySlug)]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateCondition(index: number, patch: Partial<ConditionRow>) {
    setConditions((rows) =>
      rows.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, ...patch };
        // Changing the field can invalidate the previously-selected
        // operator (e.g. "amount" doesn't offer "contains") — reset to
        // that field's first valid operator rather than leaving a
        // mismatched combination silently selected.
        if (patch.field && !OPERATORS_BY_FIELD[patch.field].some((o) => o.value === next.operator)) {
          next.operator = OPERATORS_BY_FIELD[patch.field][0].value;
        }
        return next;
      }),
    );
  }

  function updateAction(index: number, patch: Partial<ActionRow>) {
    setActions((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function handleAddCondition() {
    setConditions((rows) => [...rows, newCondition()]);
  }

  function handleRemoveCondition(event: MouseEvent<HTMLButtonElement>) {
    const index = Number(event.currentTarget.dataset.index);
    setConditions((rows) => rows.filter((_, i) => i !== index));
  }

  function handleAddAction() {
    setActions((rows) => [...rows, newAction(defaultCategorySlug)]);
  }

  function handleRemoveAction(event: MouseEvent<HTMLButtonElement>) {
    const index = Number(event.currentTarget.dataset.index);
    setActions((rows) => rows.filter((_, i) => i !== index));
  }

  function handleConditionFieldChange(event: ChangeEvent<HTMLSelectElement>) {
    const index = Number(event.currentTarget.dataset.index);
    updateCondition(index, { field: event.target.value as ConditionField });
  }

  function handleConditionOperatorChange(event: ChangeEvent<HTMLSelectElement>) {
    const index = Number(event.currentTarget.dataset.index);
    updateCondition(index, { operator: event.target.value });
  }

  function handleConditionValueChange(event: ChangeEvent<HTMLInputElement>) {
    const index = Number(event.currentTarget.dataset.index);
    updateCondition(index, { value: event.target.value });
  }

  function handleActionTypeChange(event: ChangeEvent<HTMLSelectElement>) {
    const index = Number(event.currentTarget.dataset.index);
    updateAction(index, { type: event.target.value as ActionType });
  }

  function handleActionCategoryChange(event: ChangeEvent<HTMLSelectElement>) {
    const index = Number(event.currentTarget.dataset.index);
    updateAction(index, { categorySlug: event.target.value });
  }

  function handleActionRenameValueChange(event: ChangeEvent<HTMLInputElement>) {
    const index = Number(event.currentTarget.dataset.index);
    updateAction(index, { renameValue: event.target.value });
  }

  function handleActionFlagChange(event: ChangeEvent<HTMLInputElement>) {
    const index = Number(event.currentTarget.dataset.index);
    updateAction(index, { flagValue: event.target.checked });
  }

  const isValid =
    name.trim().length > 0 &&
    conditions.every((c) => c.value.trim().length > 0) &&
    actions.every((a) => (a.type === "categorize" ? a.categorySlug.length > 0 : a.type === "rename" ? a.renameValue.trim().length > 0 : true));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/transaction-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          priority: Number(priority) || 0,
          isActive: true,
          conditions: conditions.map((c) => ({ field: c.field, operator: c.operator, value: c.value.trim() })),
          actions: actions.map((a) => {
            if (a.type === "categorize") return { type: "categorize", categorySlug: a.categorySlug };
            if (a.type === "rename") return { type: "rename", value: a.renameValue.trim() };
            return { type: "flag", value: a.flagValue };
          }),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to create rule");
      }
      setName("");
      setPriority("0");
      setConditions([newCondition()]);
      setActions([newAction(defaultCategorySlug)]);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create rule");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor="rule-name" className="text-xs font-medium text-muted">
            Rule name
          </label>
          <input
            id="rule-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Netflix -> Entertainment"
            className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex w-28 flex-col gap-1">
          <label htmlFor="rule-priority" className="text-xs font-medium text-muted">
            Priority
          </label>
          <input
            id="rule-priority"
            type="number"
            min={0}
            max={10000}
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted">Conditions (all must match)</p>
        {conditions.map((condition, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select
              data-index={index}
              value={condition.field}
              onChange={handleConditionFieldChange}
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="merchantName">Merchant name</option>
              <option value="description">Description</option>
              <option value="amount">Amount</option>
            </select>
            <select
              data-index={index}
              value={condition.operator}
              onChange={handleConditionOperatorChange}
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {OPERATORS_BY_FIELD[condition.field].map((op) => (
                <option key={op.value} value={op.value}>
                  {op.label}
                </option>
              ))}
            </select>
            <input
              data-index={index}
              value={condition.value}
              onChange={handleConditionValueChange}
              placeholder={condition.field === "amount" ? "e.g. -50.00" : "e.g. Netflix"}
              className="min-w-[160px] flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {conditions.length > 1 && (
              <button
                type="button"
                data-index={index}
                onClick={handleRemoveCondition}
                className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={handleAddCondition}
          className="uv-btn-press self-start rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          + Add condition
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted">Then</p>
        {actions.map((action, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select
              data-index={index}
              value={action.type}
              onChange={handleActionTypeChange}
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="categorize">Set category</option>
              <option value="rename">Rename merchant</option>
              <option value="flag">Flag for review</option>
            </select>
            {action.type === "categorize" && (
              <select
                data-index={index}
                value={action.categorySlug}
                onChange={handleActionCategoryChange}
                className="min-w-[160px] flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {categories.length === 0 && <option value="">No categories yet</option>}
                {categories.map((category) => (
                  <option key={category.slug} value={category.slug}>
                    {category.name}
                  </option>
                ))}
              </select>
            )}
            {action.type === "rename" && (
              <input
                data-index={index}
                value={action.renameValue}
                onChange={handleActionRenameValueChange}
                placeholder="New merchant name"
                className="min-w-[160px] flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            )}
            {action.type === "flag" && (
              <label className="flex items-center gap-2 text-sm text-fg">
                <input data-index={index} type="checkbox" checked={action.flagValue} onChange={handleActionFlagChange} />
                Needs review
              </label>
            )}
            {actions.length > 1 && (
              <button
                type="button"
                data-index={index}
                onClick={handleRemoveAction}
                className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={handleAddAction}
          className="uv-btn-press self-start rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          + Add action
        </button>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isSubmitting || !isValid}
          className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isSubmitting && <Spinner />}
          {isSubmitting ? "Creating…" : "Create rule"}
        </button>
        {error && <p className="text-sm text-negative">{error}</p>}
      </div>
    </form>
  );
}
