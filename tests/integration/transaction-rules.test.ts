import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import {
  createTransactionRule,
  deleteTransactionRule,
  getTransactionRuleById,
  listActiveTransactionRulesForEvaluation,
  listTransactionRules,
  updateTransactionRule,
  type TransactionRuleInput,
} from "../../src/server/dal/transaction-rules";

/**
 * DAL-level CRUD + negative IDOR coverage for `TransactionRule`, same
 * shape as `tests/integration/idor.test.ts` (Section 2.2): User B
 * requesting/mutating User A's rule must come back indistinguishable
 * from "doesn't exist" (`null` / `{ ok: false, error: "not_found" }`),
 * never a 403 or a leaked row. Exercises both the DAL's own
 * `where: { userId }` clause and the RLS policy underneath it
 * (`withUserScope`) together, on purpose — either one failing alone
 * would still leave the other to catch a cross-tenant access.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("transaction-rules DAL", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };

  const sampleInput: TransactionRuleInput = {
    name: "Netflix -> Entertainment",
    priority: 5,
    isActive: true,
    conditions: [{ field: "merchantName", operator: "contains", value: "Netflix" }],
    actions: [{ type: "categorize", categorySlug: "entertainment" }],
  };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `rules-test-a-${Date.now()}@pfw.local`, displayName: "Rules Test A" },
    });
    userB = await admin.user.create({
      data: { email: `rules-test-b-${Date.now()}@pfw.local`, displayName: "Rules Test B" },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  it("creates a rule and reads it back with typed conditions/actions", async () => {
    const created = await createTransactionRule(userA.id, sampleInput);
    expect(created.name).toBe(sampleInput.name);
    expect(created.conditions).toEqual(sampleInput.conditions);
    expect(created.actions).toEqual(sampleInput.actions);

    const fetched = await getTransactionRuleById(userA.id, created.id);
    expect(fetched).toEqual(created);
  });

  it("lists rules ordered by priority ascending, ties broken by creation order", async () => {
    const low = await createTransactionRule(userA.id, { ...sampleInput, name: "low", priority: 10 });
    const high = await createTransactionRule(userA.id, { ...sampleInput, name: "high", priority: 0 });

    const rules = await listTransactionRules(userA.id);
    const ids = rules.map((r) => r.id);
    expect(ids.indexOf(high.id)).toBeLessThan(ids.indexOf(low.id));
  });

  it("listActiveTransactionRulesForEvaluation excludes inactive rules", async () => {
    const active = await createTransactionRule(userA.id, { ...sampleInput, name: "active", isActive: true });
    const inactive = await createTransactionRule(userA.id, { ...sampleInput, name: "inactive", isActive: false });

    const evaluationRules = await listActiveTransactionRulesForEvaluation(userA.id);
    const ids = evaluationRules.map((r) => r.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(inactive.id);
  });

  it("updates a rule's fields, leaving unspecified fields unchanged", async () => {
    const created = await createTransactionRule(userA.id, sampleInput);
    const updated = await updateTransactionRule(userA.id, created.id, { isActive: false });
    expect(updated?.isActive).toBe(false);
    expect(updated?.name).toBe(sampleInput.name);
    expect(updated?.conditions).toEqual(sampleInput.conditions);
  });

  it("deletes a rule", async () => {
    const created = await createTransactionRule(userA.id, sampleInput);
    const result = await deleteTransactionRule(userA.id, created.id);
    expect(result).toEqual({ ok: true });
    expect(await getTransactionRuleById(userA.id, created.id)).toBeNull();
  });

  it("deleting an already-deleted (or nonexistent) rule reports not_found", async () => {
    const result = await deleteTransactionRule(userA.id, "cnonexistentxxxxxxxxxxxxxxxx");
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  describe("cross-user IDOR", () => {
    it("getTransactionRuleById returns null for another user's rule", async () => {
      const ruleA = await createTransactionRule(userA.id, sampleInput);
      expect(await getTransactionRuleById(userB.id, ruleA.id)).toBeNull();
    });

    it("updateTransactionRule returns null and does not modify another user's rule", async () => {
      const ruleA = await createTransactionRule(userA.id, sampleInput);
      const result = await updateTransactionRule(userB.id, ruleA.id, { name: "hijacked" });
      expect(result).toBeNull();

      const stillOwnedByA = await getTransactionRuleById(userA.id, ruleA.id);
      expect(stillOwnedByA?.name).toBe(sampleInput.name);
    });

    it("deleteTransactionRule reports not_found and does not delete another user's rule", async () => {
      const ruleA = await createTransactionRule(userA.id, sampleInput);
      const result = await deleteTransactionRule(userB.id, ruleA.id);
      expect(result).toEqual({ ok: false, error: "not_found" });

      expect(await getTransactionRuleById(userA.id, ruleA.id)).not.toBeNull();
    });

    it("listTransactionRules and listActiveTransactionRulesForEvaluation never include another user's rules", async () => {
      const ruleA = await createTransactionRule(userA.id, sampleInput);

      const listB = await listTransactionRules(userB.id);
      expect(listB.map((r) => r.id)).not.toContain(ruleA.id);

      const activeListB = await listActiveTransactionRulesForEvaluation(userB.id);
      expect(activeListB.map((r) => r.id)).not.toContain(ruleA.id);
    });
  });
});
