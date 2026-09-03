import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agorot } from "../../src/lib/money";
import { createAdminClient } from "../../src/server/db/admin-client";
import { createTransactionRule } from "../../src/server/dal/transaction-rules";
import { importTransactions } from "../../src/server/dal/transaction-import";
import { createTransaction } from "../../src/server/dal/transactions";

/**
 * End-to-end integration coverage proving Tier 0 (`rule-engine.ts`) is
 * actually wired into BOTH entry points into the categorization
 * pipeline — CSV import (`transaction-import.ts`) and manual entry
 * (`transactions.ts`'s `createTransaction`) — not just unit-tested in
 * isolation. Real Postgres, real rule rows via the real DAL, real
 * cascade fallback for non-matching rows.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("Tier 0 rule pipeline integration", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let accountA: { id: string };
  let uncategorizedA: { id: string };
  let entertainmentA: { id: string };
  let diningA: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `tier0-pipeline-test-${Date.now()}@pfw.local`, displayName: "Tier 0 Pipeline Test" },
    });
    accountA = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "1234", accountType: "CHECKING", nativeBalance: 10_000n },
    });
    uncategorizedA = await admin.category.create({
      data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    entertainmentA = await admin.category.create({ data: { userId: userA.id, slug: "entertainment", name: "Entertainment" } });
    diningA = await admin.category.create({ data: { userId: userA.id, slug: "dining", name: "Dining" } });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: userA.id } });
    await admin.$disconnect();
  });

  describe("manual entry (createTransaction)", () => {
    it("a matching rule's categorize action bypasses the cascade entirely", async () => {
      const rule = await createTransactionRule(userA.id, {
        name: "Streamflix -> Entertainment",
        priority: 0,
        isActive: true,
        conditions: [{ field: "merchantName", operator: "contains", value: "Streamflix" }],
        actions: [{ type: "categorize", categorySlug: "entertainment" }],
      });

      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -5490n,
        occurredAt: new Date(),
        description: "Streamflix monthly",
        merchantName: "Streamflix",
      });

      expect(created.categoryId).toBe(entertainmentA.id);
      // A Tier 0 match is treated as fully confident — never flagged for
      // review just because it didn't go through Tiers 1-4.
      expect(created.needsReview).toBe(false);

      await admin.transactionRule.delete({ where: { id: rule.id } });
    });

    it("a rename action overrides the merchant name even when no rule sets a category", async () => {
      const rule = await createTransactionRule(userA.id, {
        name: "Clean up SQ prefix",
        priority: 0,
        isActive: true,
        conditions: [{ field: "merchantName", operator: "contains", value: "SQ" }],
        actions: [{ type: "rename", value: "Square Point of Sale" }],
      });

      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -1200n,
        occurredAt: new Date(),
        description: "SQ *RANDOMSHOP123",
        merchantName: "SQ *RANDOMSHOP123",
      });

      expect(created.merchantName).toBe("Square Point of Sale");
      // No categorize action on the matched rule — categorization still
      // ran the ordinary cascade, landing in Uncategorized/review since
      // nothing else matched this merchant.
      expect(created.categoryId).toBe(uncategorizedA.id);
      expect(created.needsReview).toBe(true);

      await admin.transactionRule.delete({ where: { id: rule.id } });
    });

    it("a flag action forces needsReview even when Tier 0 also confidently categorizes", async () => {
      const rule = await createTransactionRule(userA.id, {
        name: "Always review Streamflix",
        priority: 0,
        isActive: true,
        conditions: [{ field: "merchantName", operator: "equals", value: "Streamflix" }],
        actions: [{ type: "categorize", categorySlug: "entertainment" }, { type: "flag", value: true }],
      });

      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -5490n,
        occurredAt: new Date(),
        description: "Streamflix",
        merchantName: "Streamflix",
      });

      expect(created.categoryId).toBe(entertainmentA.id);
      expect(created.needsReview).toBe(true);

      await admin.transactionRule.delete({ where: { id: rule.id } });
    });

    it("a lower-priority-number rule wins over a higher one when both match", async () => {
      const loseRule = await createTransactionRule(userA.id, {
        name: "loses",
        priority: 10,
        isActive: true,
        conditions: [{ field: "merchantName", operator: "contains", value: "Cafe" }],
        actions: [{ type: "categorize", categorySlug: "entertainment" }],
      });
      const winRule = await createTransactionRule(userA.id, {
        name: "wins",
        priority: 0,
        isActive: true,
        conditions: [{ field: "merchantName", operator: "contains", value: "Cafe" }],
        actions: [{ type: "categorize", categorySlug: "dining" }],
      });

      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -2000n,
        occurredAt: new Date(),
        description: "Cafe Aroma",
        merchantName: "Cafe Aroma",
      });

      expect(created.categoryId).toBe(diningA.id);

      await admin.transactionRule.deleteMany({ where: { id: { in: [loseRule.id, winRule.id] } } });
    });

    it("an inactive rule never applies, even when its conditions would match", async () => {
      // A merchant name never used in an earlier test in this file — Tier
      // 1 (manual-correction learning) would otherwise correctly pick up
      // an earlier test's ALREADY-categorized "Streamflix" transaction and
      // re-apply its category on its own merits, which would make this
      // assertion pass for the wrong reason (Tier 1, not "the disabled
      // rule correctly did nothing").
      const rule = await createTransactionRule(userA.id, {
        name: "disabled",
        priority: 0,
        isActive: false,
        conditions: [{ field: "merchantName", operator: "contains", value: "Moonbase Cinema" }],
        actions: [{ type: "categorize", categorySlug: "entertainment" }],
      });

      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -5490n,
        occurredAt: new Date(),
        description: "Moonbase Cinema",
        merchantName: "Moonbase Cinema",
      });

      expect(created.categoryId).toBe(uncategorizedA.id);

      await admin.transactionRule.delete({ where: { id: rule.id } });
    });

    it("a non-matching transaction is entirely unaffected — normal cascade fallback", async () => {
      const rule = await createTransactionRule(userA.id, {
        name: "Streamflix only",
        priority: 0,
        isActive: true,
        conditions: [{ field: "merchantName", operator: "equals", value: "Streamflix" }],
        actions: [{ type: "categorize", categorySlug: "entertainment" }],
      });

      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -300n,
        occurredAt: new Date(),
        description: "Completely unrelated merchant",
        merchantName: "Some Random Store",
      });

      expect(created.categoryId).toBe(uncategorizedA.id);
      expect(created.needsReview).toBe(true);

      await admin.transactionRule.delete({ where: { id: rule.id } });
    });
  });

  describe("CSV import (importTransactions)", () => {
    it("applies a matching Tier 0 rule to an imported row, bypassing Tiers 1-2", async () => {
      const rule = await createTransactionRule(userA.id, {
        name: "Streamflix -> Entertainment (import)",
        priority: 0,
        isActive: true,
        conditions: [{ field: "merchantName", operator: "contains", value: "Streamflix" }],
        actions: [{ type: "categorize", categorySlug: "entertainment" }],
      });

      const summary = await importTransactions(userA.id, {
        bankAccountId: accountA.id,
        adapterId: "test-adapter",
        rows: [
          {
            lineNumber: 2,
            occurredAt: new Date("2026-03-01T00:00:00.000Z"),
            amountAgorot: agorot(-5490),
            description: "Streamflix monthly",
            merchantName: "Streamflix",
            providerReference: "ref-tier0-1",
            dedupeKeySource: "dedupe-tier0-1",
          },
        ],
      });

      expect(summary.importedCount).toBe(1);
      const [importedId] = summary.importedIds;
      const row = await admin.notableTransaction.findUniqueOrThrow({ where: { id: importedId } });
      expect(row.categoryId).toBe(entertainmentA.id);
      expect(row.needsReview).toBe(false);

      await admin.transactionRule.delete({ where: { id: rule.id } });
    });

    it("a rename action renames an imported row's merchant name", async () => {
      const rule = await createTransactionRule(userA.id, {
        name: "Clean up SQ prefix (import)",
        priority: 0,
        isActive: true,
        conditions: [{ field: "merchantName", operator: "contains", value: "SQ" }],
        actions: [{ type: "rename", value: "Square Point of Sale" }],
      });

      const summary = await importTransactions(userA.id, {
        bankAccountId: accountA.id,
        adapterId: "test-adapter",
        rows: [
          {
            lineNumber: 2,
            occurredAt: new Date("2026-03-02T00:00:00.000Z"),
            amountAgorot: agorot(-800),
            description: "SQ *ANOTHERSHOP456",
            merchantName: "SQ *ANOTHERSHOP456",
            providerReference: "ref-tier0-2",
            dedupeKeySource: "dedupe-tier0-2",
          },
        ],
      });

      expect(summary.importedCount).toBe(1);
      const [importedId] = summary.importedIds;
      const row = await admin.notableTransaction.findUniqueOrThrow({ where: { id: importedId } });
      expect(row.merchantName).toBe("Square Point of Sale");

      await admin.transactionRule.delete({ where: { id: rule.id } });
    });

    it("an imported row matching no rule falls through unaffected", async () => {
      const rule = await createTransactionRule(userA.id, {
        name: "Streamflix only (import)",
        priority: 0,
        isActive: true,
        conditions: [{ field: "merchantName", operator: "equals", value: "Streamflix" }],
        actions: [{ type: "categorize", categorySlug: "entertainment" }],
      });

      const summary = await importTransactions(userA.id, {
        bankAccountId: accountA.id,
        adapterId: "test-adapter",
        rows: [
          {
            lineNumber: 2,
            occurredAt: new Date("2026-03-03T00:00:00.000Z"),
            amountAgorot: agorot(-150),
            description: "Totally unrelated import row",
            merchantName: "Unrelated Merchant",
            providerReference: "ref-tier0-3",
            dedupeKeySource: "dedupe-tier0-3",
          },
        ],
      });

      expect(summary.importedCount).toBe(1);
      const [importedId] = summary.importedIds;
      const row = await admin.notableTransaction.findUniqueOrThrow({ where: { id: importedId } });
      expect(row.categoryId).toBe(uncategorizedA.id);

      await admin.transactionRule.delete({ where: { id: rule.id } });
    });
  });
});
