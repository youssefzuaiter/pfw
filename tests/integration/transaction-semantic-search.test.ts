import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { createTransaction, searchTransactionsSemantic, updateTransactionCategory } from "../../src/server/dal/transactions";

const DIMENSIONS = 384;

/**
 * Same dominant-spike construction `tests/integration/merchant-embeddings.test.ts`
 * already established (and the same reasoning for why NOT a sinusoid —
 * see that file's own comment on the real bug a phase-shifted-sine
 * fixture generator caused) — two different seeds are verifiably, not
 * just probabilistically, near-orthogonal (cosine similarity ≈ 0.04, far
 * below this feature's 0.75 floor / 0.25 cosine-distance ceiling).
 */
function vector(seed: number): number[] {
  const raw = new Array(DIMENSIONS).fill(0.01);
  raw[seed % DIMENSIONS] = 1;
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return raw.map((v) => v / norm);
}

/** A tiny perturbation of `base` — cosine similarity to `base` stays ~0.999+, simulating a real embedding model's output for near-duplicate merchant/description text. */
function nearVector(base: readonly number[]): number[] {
  const raw = base.map((v) => (v > 0.5 ? v : v + 0.0005));
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return raw.map((v) => v / norm);
}

/**
 * Integration coverage for the pgvector-backed semantic transaction
 * search (AGENTS.md §3cc): the write path (createTransaction/
 * updateTransactionCategory populating NotableTransaction.searchEmbedding
 * via raw SQL) and the read path (searchTransactionsSemantic's cosine-
 * distance ranking, filters, and IDOR isolation) against a real Postgres
 * with the vector extension actually enabled.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("Semantic transaction search", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let accountA: { id: string };
  let diningA: { id: string };
  let groceriesA: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `semsearch-test-a-${Date.now()}@pfw.local`, displayName: "Semantic Search Test A" },
    });
    userB = await admin.user.create({
      data: { email: `semsearch-test-b-${Date.now()}@pfw.local`, displayName: "Semantic Search Test B" },
    });
    accountA = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "1111", accountType: "CHECKING", nativeBalance: 10_000n },
    });
    // createTransaction's categorization cascade requires this to
    // exist for the user, but nothing in this file asserts against it
    // directly, so it's not bound to a variable.
    await admin.category.create({
      data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    diningA = await admin.category.create({ data: { userId: userA.id, slug: "dining", name: "Dining" } });
    groceriesA = await admin.category.create({ data: { userId: userA.id, slug: "groceries", name: "Groceries" } });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  describe("write path", () => {
    it("createTransaction with an embedding populates searchEmbedding", async () => {
      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -1200n,
        occurredAt: new Date(),
        description: "Search Index Cafe",
        merchantName: "Search Index Cafe",
        embedding: vector(1),
      });

      const [row] = await admin.$queryRaw<{ has_embedding: boolean }[]>`
        SELECT "searchEmbedding" IS NOT NULL AS has_embedding FROM "NotableTransaction" WHERE "id" = ${created.id}
      `;
      expect(row.has_embedding).toBe(true);
    });

    it("createTransaction WITHOUT an embedding leaves searchEmbedding null", async () => {
      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -800n,
        occurredAt: new Date(),
        description: "No Index Diner",
        merchantName: "No Index Diner",
      });

      const [row] = await admin.$queryRaw<{ has_embedding: boolean }[]>`
        SELECT "searchEmbedding" IS NOT NULL AS has_embedding FROM "NotableTransaction" WHERE "id" = ${created.id}
      `;
      expect(row.has_embedding).toBe(false);
    });

    it("updateTransactionCategory with an embedding populates searchEmbedding on an existing row", async () => {
      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -1500n,
        occurredAt: new Date(),
        description: "Recategorized Later Cafe",
        merchantName: "Recategorized Later Cafe",
      });

      const [before] = await admin.$queryRaw<{ has_embedding: boolean }[]>`
        SELECT "searchEmbedding" IS NOT NULL AS has_embedding FROM "NotableTransaction" WHERE "id" = ${created.id}
      `;
      expect(before.has_embedding).toBe(false);

      await updateTransactionCategory(userA.id, created.id, diningA.id, vector(2));

      const [after] = await admin.$queryRaw<{ has_embedding: boolean }[]>`
        SELECT "searchEmbedding" IS NOT NULL AS has_embedding FROM "NotableTransaction" WHERE "id" = ${created.id}
      `;
      expect(after.has_embedding).toBe(true);
    });
  });

  describe("searchTransactionsSemantic", () => {
    it("finds a transaction by a near-identical query vector and excludes an unrelated one", async () => {
      const targetEmbedding = vector(10);
      const target = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -3000n,
        occurredAt: new Date(),
        description: "Aroma Espresso Search Target",
        merchantName: "Aroma Espresso Search Target",
        embedding: targetEmbedding,
      });
      const unrelated = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -900n,
        occurredAt: new Date(),
        description: "Completely Unrelated Search Noise",
        merchantName: "Completely Unrelated Search Noise",
        embedding: vector(11),
      });

      const results = await searchTransactionsSemantic(userA.id, nearVector(targetEmbedding));
      const ids = results.map((r) => r.id);
      expect(ids).toContain(target.id);
      expect(ids).not.toContain(unrelated.id);
    });

    it("orders results most-similar-first, not by any incidental table order", async () => {
      const reference = vector(20);
      const veryClose = nearVector(reference);
      // A second-closest match: same dominant spike index as the
      // reference but a larger perturbation, so it's still well above
      // the 0.75 similarity floor while being measurably less similar
      // than `veryClose`.
      const raw = reference.map((v) => (v > 0.5 ? v : v + 0.02));
      const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
      const somewhatClose = raw.map((v) => v / norm);

      const far = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -100n,
        occurredAt: new Date(),
        description: "Ordering Test Far",
        merchantName: "Ordering Test Far",
        embedding: somewhatClose,
      });
      const near = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -200n,
        occurredAt: new Date(),
        description: "Ordering Test Near",
        merchantName: "Ordering Test Near",
        embedding: veryClose,
      });

      const results = await searchTransactionsSemantic(userA.id, reference);
      const nearIndex = results.findIndex((r) => r.id === near.id);
      const farIndex = results.findIndex((r) => r.id === far.id);
      expect(nearIndex).toBeGreaterThanOrEqual(0);
      expect(farIndex).toBeGreaterThanOrEqual(0);
      expect(nearIndex).toBeLessThan(farIndex);
    });

    it("never returns a transaction that has no stored searchEmbedding", async () => {
      const reference = vector(30);
      const noEmbedding = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -400n,
        occurredAt: new Date(),
        description: "No Embedding At All",
        merchantName: "No Embedding At All",
        // no `embedding` field
      });

      // Give it the SAME description text, but only ONE of the two gets
      // an embedding — proves absence of a stored vector, not text
      // content, is what excludes a row.
      const withEmbedding = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -400n,
        occurredAt: new Date(),
        description: "No Embedding At All (indexed twin)",
        merchantName: "No Embedding At All",
        embedding: reference,
      });

      const results = await searchTransactionsSemantic(userA.id, nearVector(reference));
      const ids = results.map((r) => r.id);
      expect(ids).toContain(withEmbedding.id);
      expect(ids).not.toContain(noEmbedding.id);
    });

    it("respects a categoryId filter alongside the vector ranking", async () => {
      const reference = vector(40);
      const dining = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -500n,
        occurredAt: new Date(),
        description: "Category Filter Test Dining",
        merchantName: "Category Filter Test Dining",
        embedding: reference,
      });
      await updateTransactionCategory(userA.id, dining.id, diningA.id, reference);

      const groceries = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -500n,
        occurredAt: new Date(),
        description: "Category Filter Test Groceries",
        merchantName: "Category Filter Test Groceries",
        embedding: reference,
      });
      await updateTransactionCategory(userA.id, groceries.id, groceriesA.id, reference);

      const results = await searchTransactionsSemantic(userA.id, nearVector(reference), { categoryId: diningA.id });
      const ids = results.map((r) => r.id);
      expect(ids).toContain(dining.id);
      expect(ids).not.toContain(groceries.id);
    });

    it("does not leak user A's transactions into user B's search results (IDOR)", async () => {
      const sharedEmbedding = vector(50);
      const transactionA = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -600n,
        occurredAt: new Date(),
        description: "IDOR Test Shared Description",
        merchantName: "IDOR Test Shared Description",
        embedding: sharedEmbedding,
      });

      const resultsForB = await searchTransactionsSemantic(userB.id, nearVector(sharedEmbedding));
      expect(resultsForB.map((r) => r.id)).not.toContain(transactionA.id);
    });
  });
});
