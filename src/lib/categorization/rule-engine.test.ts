import { describe, expect, it } from "vitest";
import { agorot } from "../money";
import {
  AmountConditionSchema,
  applyRules,
  RuleActionSchema,
  RuleConditionSchema,
  type StoredTransactionRule,
  type TransactionRuleData,
} from "./rule-engine";

function transaction(overrides: Partial<TransactionRuleData> = {}): TransactionRuleData {
  return {
    merchantName: "Netflix [נטפליקס]",
    description: "Netflix [נטפליקס]",
    amountAgorot: agorot(-5490),
    ...overrides,
  };
}

function rule(overrides: Partial<StoredTransactionRule> = {}): StoredTransactionRule {
  return {
    id: "rule-1",
    priority: 0,
    isActive: true,
    conditions: [{ field: "merchantName", operator: "contains", value: "Netflix" }],
    actions: [{ type: "categorize", categorySlug: "entertainment" }],
    ...overrides,
  };
}

describe("applyRules()", () => {
  it("applies a matching rule's categorize action", () => {
    const result = applyRules(transaction(), [rule()]);
    expect(result.categorySlug).toBe("entertainment");
    expect(result.matchedRuleIds).toEqual(["rule-1"]);
  });

  it("skips a non-matching transaction — no actions applied, nothing recorded as matched", () => {
    const result = applyRules(transaction({ merchantName: "Some Grocer" }), [rule()]);
    expect(result).toEqual({ matchedRuleIds: [] });
  });

  it("skips an inactive rule even when its conditions match", () => {
    const result = applyRules(transaction(), [rule({ isActive: false })]);
    expect(result).toEqual({ matchedRuleIds: [] });
  });

  it("requires ALL conditions on a rule to match (AND semantics)", () => {
    const twoConditionRule = rule({
      conditions: [
        { field: "merchantName", operator: "contains", value: "Netflix" },
        { field: "amount", operator: "lessThan", value: "-100.00" },
      ],
    });

    // amount is only -₪54.90, so the second condition fails even though the first matches.
    expect(applyRules(transaction(), [twoConditionRule]).matchedRuleIds).toEqual([]);

    const bothMatch = transaction({ amountAgorot: agorot(-15000) });
    expect(applyRules(bothMatch, [twoConditionRule]).matchedRuleIds).toEqual(["rule-1"]);
  });

  it("respects priority order — a lower-priority-number rule's action wins over a higher one", () => {
    const rules: StoredTransactionRule[] = [
      rule({ id: "low-priority", priority: 10, actions: [{ type: "categorize", categorySlug: "shopping" }] }),
      rule({ id: "high-priority", priority: 0, actions: [{ type: "categorize", categorySlug: "entertainment" }] }),
    ];

    // Passed in "wrong" (low-priority-first) array order on purpose —
    // applyRules must sort by priority itself, not trust caller order.
    const result = applyRules(transaction(), rules);
    expect(result.categorySlug).toBe("entertainment");
    expect(result.matchedRuleIds).toEqual(["high-priority", "low-priority"]);
  });

  it("a later rule's rename/flag actions never override an earlier match's — first match wins per action kind", () => {
    const rules: StoredTransactionRule[] = [
      rule({
        id: "first",
        priority: 0,
        actions: [{ type: "rename", value: "Streaming subscription" }, { type: "flag", value: false }],
      }),
      rule({
        id: "second",
        priority: 1,
        actions: [{ type: "rename", value: "Should never win" }, { type: "flag", value: true }],
      }),
    ];

    const result = applyRules(transaction(), rules);
    expect(result.renamedMerchantName).toBe("Streaming subscription");
    expect(result.forceNeedsReview).toBe(false);
    expect(result.matchedRuleIds).toEqual(["first", "second"]);
  });

  it("evaluates an 'equals' text condition case-insensitively, exact match only", () => {
    const equalsRule = rule({ conditions: [{ field: "merchantName", operator: "equals", value: "netflix" }] });
    expect(applyRules(transaction({ merchantName: "Netflix" }), [equalsRule]).matchedRuleIds).toEqual(["rule-1"]);
    expect(applyRules(transaction({ merchantName: "Netflix Extra" }), [equalsRule]).matchedRuleIds).toEqual([]);
  });

  it("evaluates a 'contains' description condition via the Hebrew-safe whole-word matcher", () => {
    const descriptionRule = rule({
      conditions: [{ field: "description", operator: "contains", value: "קפה" }],
      actions: [{ type: "categorize", categorySlug: "dining" }],
    });
    expect(
      applyRules(transaction({ description: "קפה קפה" }), [descriptionRule]).categorySlug,
    ).toBe("dining");
  });

  it("evaluates amount conditions against the transaction's signed agorot amount", () => {
    const greaterThan = rule({ conditions: [{ field: "amount", operator: "greaterThan", value: "-100.00" }] });
    const lessThan = rule({ id: "rule-2", conditions: [{ field: "amount", operator: "lessThan", value: "-100.00" }] });
    const equals = rule({ id: "rule-3", conditions: [{ field: "amount", operator: "equals", value: "-54.90" }] });

    // -₪54.90 > -₪100.00
    expect(applyRules(transaction(), [greaterThan]).matchedRuleIds).toEqual(["rule-1"]);
    expect(applyRules(transaction(), [lessThan]).matchedRuleIds).toEqual([]);
    expect(applyRules(transaction(), [equals]).matchedRuleIds).toEqual(["rule-3"]);
  });

  it("treats a transaction with no merchantName as an empty string for merchant conditions, never throwing", () => {
    const merchantRule = rule({ conditions: [{ field: "merchantName", operator: "contains", value: "Netflix" }] });
    expect(() => applyRules(transaction({ merchantName: null }), [merchantRule])).not.toThrow();
    expect(applyRules(transaction({ merchantName: null }), [merchantRule]).matchedRuleIds).toEqual([]);
  });

  it("returns an empty result for an empty rule set", () => {
    expect(applyRules(transaction(), [])).toEqual({ matchedRuleIds: [] });
  });
});

describe("RuleConditionSchema", () => {
  it("accepts a well-formed merchantName condition", () => {
    expect(RuleConditionSchema.safeParse({ field: "merchantName", operator: "contains", value: "Netflix" }).success).toBe(
      true,
    );
  });

  it("rejects an amount condition with an invalid operator", () => {
    expect(
      RuleConditionSchema.safeParse({ field: "amount", operator: "contains", value: "10.00" }).success,
    ).toBe(false);
  });

  it("rejects an empty value", () => {
    expect(RuleConditionSchema.safeParse({ field: "merchantName", operator: "equals", value: "" }).success).toBe(false);
  });
});

describe("AmountConditionSchema", () => {
  it("accepts a well-formed shekel-string value", () => {
    expect(AmountConditionSchema.safeParse({ field: "amount", operator: "equals", value: "-125.50" }).success).toBe(
      true,
    );
  });

  it("rejects a malformed shekel-string value (never a raw float)", () => {
    expect(AmountConditionSchema.safeParse({ field: "amount", operator: "equals", value: "not-a-number" }).success).toBe(
      false,
    );
  });
});

describe("RuleActionSchema", () => {
  it("accepts each of the three action kinds", () => {
    expect(RuleActionSchema.safeParse({ type: "categorize", categorySlug: "dining" }).success).toBe(true);
    expect(RuleActionSchema.safeParse({ type: "rename", value: "Coffee" }).success).toBe(true);
    expect(RuleActionSchema.safeParse({ type: "flag", value: true }).success).toBe(true);
  });

  it("rejects an unknown action type", () => {
    expect(RuleActionSchema.safeParse({ type: "delete", value: true }).success).toBe(false);
  });
});
