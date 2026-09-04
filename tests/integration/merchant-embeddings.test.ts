import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURRENT_EMBEDDING_MODEL_ID } from "../../src/lib/embeddings/embedding-model";
import { createAdminClient } from "../../src/server/db/admin-client";
import { listEmbeddingCorrections, upsertMerchantEmbedding } from "../../src/server/dal/merchant-embeddings";
import { createTransaction, updateTransactionCategory } from "../../src/server/dal/transactions";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

const DIMENSIONS = 384;

/**
 * A deterministic, normalized 384-dim vector with a single dominant
 * "spike" at index `seed % DIMENSIONS` and a small uniform baseline
 * everywhere else — deliberately NOT a sinusoid-based construction,
 * which a first draft of this file used and which turned out to NOT
 * reliably separate different seeds (two phase-shifted sine waves
 * sampled at 384 points can still correlate well above the 0.75
 * similarity threshold depending on the shift, which caused a real,
 * confusing test failure — an IDOR test appeared to fail because two
 * "unrelated" vectors from different seeds were accidentally similar
 * enough to cross-match). Two spikes at DIFFERENT indices are
 * guaranteed near-orthogonal (cosine similarity ~0.01²×383 ≈ 0.04, far
 * below the KNN's default 0.75 floor); the seeds used in this file
 * (1, 2, 3, 4, 5, 10, 11, 20, 30, 999) all land on distinct indices mod
 * 384, so every `vector(seed)` here is verifiably far from every other.
 */
function vector(seed: number): number[] {
  const raw = new Array(DIMENSIONS).fill(0.01);
  raw[seed % DIMENSIONS] = 1;
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return raw.map((v) => v / norm);
}

/** A vector very close to `base` (tiny perturbation of the non-spike baseline only, so the dominant spike — and therefore cosine similarity to `base`, ~0.999+ — is essentially unchanged) — simulates two slightly different renderings of "the same merchant" (e.g. an appended transaction ID) that a real embedding model would still place near each other. */
function nearVector(base: readonly number[]): number[] {
  const raw = base.map((v) => (v > 0.5 ? v : v + 0.0005));
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return raw.map((v) => v / norm);
}

/**
 * Postgres/the `pg` driver round-trips a `Float[]` (double precision)
 * array through its text wire protocol, which loses precision in the
 * last one or two bits of the mantissa — confirmed by hand: a stored
 * `-0.059349860328365214` reads back as `-0.05934986032836521`, a
 * ~1e-16 relative difference. Harmless for cosine-similarity purposes
 * (this is the same order of magnitude as IEEE754 double rounding
 * error itself), but means a real embedding is never `toEqual`-exact
 * after a round trip through the database — assert closeness instead.
 */
function expectVectorClose(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 10);
  }
}

/**
 * Integration coverage for the Self-Learning Vector Categorization
 * Engine's server-side half (AGENTS.md §3u) — the reference vector DAL,
 * the feedback loop (`updateTransactionCategory` upserting a
 * correction), and Tier 3 actually firing inside `createTransaction`
 * when a client-supplied embedding is present. The embedding model
 * itself (`src/lib/embeddings/local-embedder.ts`) is client-only and
 * never touches these code paths — every vector here is a synthetic,
 * deterministic stand-in with the real model's shape (384 dimensions,
 * normalized), same convention `tests/integration/dead-mans-switch-vault-cipher.test.ts`
 * uses for crypto material it can't practically generate via a real
 * browser inside a test run.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("Self-Learning Vector Categorization Engine", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let accountA: { id: string };
  let uncategorizedA: { id: string };
  let diningA: { id: string };
  let groceriesA: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `merchant-embed-test-a-${Date.now()}@pfw.local`, displayName: "Embed Test A" },
    });
    userB = await admin.user.create({
      data: { email: `merchant-embed-test-b-${Date.now()}@pfw.local`, displayName: "Embed Test B" },
    });
    accountA = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "1234", accountType: "CHECKING", nativeBalance: 10_000n },
    });
    uncategorizedA = await admin.category.create({
      data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    diningA = await admin.category.create({ data: { userId: userA.id, slug: "dining", name: "Dining" } });
    groceriesA = await admin.category.create({ data: { userId: userA.id, slug: "groceries", name: "Groceries" } });
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [userA.id, userB.id]);
    await admin.$disconnect();
  });

  describe("upsertMerchantEmbedding / listEmbeddingCorrections", () => {
    it("creates a new correction and lists it back", async () => {
      const embedding = vector(1);
      const result = await upsertMerchantEmbedding(userA.id, {
        merchantKey: "cafe aroma",
        sampleMerchantName: "Cafe Aroma",
        categoryId: diningA.id,
        embedding,
      });
      expect(result).toEqual({ ok: true });

      const corrections = await listEmbeddingCorrections(userA.id);
      const match = corrections.find((c) => c.categoryId === diningA.id);
      expect(match).toBeDefined();
      expectVectorClose(match!.embedding, embedding);
    });

    it("upserting the same merchant again OVERWRITES the row rather than adding a second one", async () => {
      await upsertMerchantEmbedding(userA.id, {
        merchantKey: "shufersal",
        sampleMerchantName: "Shufersal",
        categoryId: diningA.id, // deliberately "wrong" at first
        embedding: vector(2),
      });
      await upsertMerchantEmbedding(userA.id, {
        merchantKey: "shufersal",
        sampleMerchantName: "Shufersal Deal",
        categoryId: groceriesA.id, // corrected
        embedding: vector(3),
      });

      const row = await admin.merchantEmbedding.findUniqueOrThrow({
        where: { userId_merchantKey: { userId: userA.id, merchantKey: "shufersal" } },
      });
      expect(row.categoryId).toBe(groceriesA.id);
      expect(row.sampleMerchantName).toBe("Shufersal Deal");

      const allRows = await admin.merchantEmbedding.findMany({ where: { userId: userA.id, merchantKey: "shufersal" } });
      expect(allRows).toHaveLength(1);
    });

    it("rejects a category that isn't the caller's (IDOR), without writing anything", async () => {
      const result = await upsertMerchantEmbedding(userB.id, {
        merchantKey: "some-merchant",
        sampleMerchantName: "Some Merchant",
        categoryId: diningA.id, // belongs to userA
        embedding: vector(4),
      });
      expect(result).toEqual({ ok: false, error: "category_not_found" });

      const row = await admin.merchantEmbedding.findUnique({
        where: { userId_merchantKey: { userId: userB.id, merchantKey: "some-merchant" } },
      });
      expect(row).toBeNull();
    });

    it("does not leak one user's corrections into another user's list (IDOR)", async () => {
      const userBCategory = await admin.category.create({ data: { userId: userB.id, slug: "misc", name: "Misc" } });
      await upsertMerchantEmbedding(userB.id, {
        merchantKey: "user-b-only-merchant",
        sampleMerchantName: "User B Only",
        categoryId: userBCategory.id,
        embedding: vector(5),
      });

      const userACorrections = await listEmbeddingCorrections(userA.id);
      expect(userACorrections.map((c) => c.categoryId)).not.toContain(userBCategory.id);
    });
  });

  describe("embeddingModel versioning (AGENTS.md §3aa)", () => {
    it("upsertMerchantEmbedding always stamps the row with the current model id", async () => {
      await upsertMerchantEmbedding(userA.id, {
        merchantKey: "model-tag-check",
        sampleMerchantName: "Model Tag Check",
        categoryId: diningA.id,
        embedding: vector(40),
      });

      const row = await admin.merchantEmbedding.findUniqueOrThrow({
        where: { userId_merchantKey: { userId: userA.id, merchantKey: "model-tag-check" } },
      });
      expect(row.embeddingModel).toBe(CURRENT_EMBEDDING_MODEL_ID);
    });

    it("listEmbeddingCorrections excludes a row tagged with a different (e.g. legacy/pre-migration) model", async () => {
      // Written directly via the admin client, bypassing upsertMerchantEmbedding
      // entirely — simulates a real pre-existing row from before model
      // versioning existed (which the migration backfills to
      // 'legacy-unversioned') or from a since-retired model, neither of
      // which upsertMerchantEmbedding would ever write today.
      await admin.merchantEmbedding.create({
        data: {
          userId: userA.id,
          merchantKey: "stale-model-merchant",
          sampleMerchantName: "Stale Model Merchant",
          categoryId: diningA.id,
          embedding: vector(41),
          embeddingModel: "legacy-unversioned",
        },
      });

      const corrections = await listEmbeddingCorrections(userA.id);
      // The row exists in the table (confirmed directly) but must never
      // surface through the DAL function Tier 3 actually reads from.
      const stillThere = await admin.merchantEmbedding.findUnique({
        where: { userId_merchantKey: { userId: userA.id, merchantKey: "stale-model-merchant" } },
      });
      expect(stillThere).not.toBeNull();
      expect(corrections.some((c) => c.categoryId === diningA.id && c.embedding[41] > 0.9)).toBe(false);
    });

    it("createTransaction's Tier 3 lookup never matches against a different-model row, even a near-identical vector", async () => {
      const referenceEmbedding = vector(50);
      await admin.merchantEmbedding.create({
        data: {
          userId: userA.id,
          merchantKey: "cross-model-merchant",
          sampleMerchantName: "Cross Model Merchant",
          categoryId: groceriesA.id,
          embedding: referenceEmbedding,
          embeddingModel: "some-retired-model-id",
        },
      });

      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -1100n,
        occurredAt: new Date(),
        description: "Cross Model Merchant #77",
        merchantName: "Cross Model Merchant #77",
        // A near-identical vector to the stored one — under the OLD,
        // unfiltered behavior this would have matched groceriesA with
        // high confidence; the model-version filter must stop that.
        embedding: nearVector(referenceEmbedding),
      });

      expect(created.categoryId).not.toBe(groceriesA.id);
      expect(created.categoryId).toBe(uncategorizedA.id);
    });
  });

  describe("updateTransactionCategory feedback loop", () => {
    it("upserts a MerchantEmbedding row when an embedding is supplied alongside a correction", async () => {
      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -1500n,
        occurredAt: new Date(),
        description: "Feedback Loop Cafe",
        merchantName: "Feedback Loop Cafe",
      });
      expect(created.categoryId).toBe(uncategorizedA.id); // no signal yet

      const embedding = vector(10);
      const updated = await updateTransactionCategory(userA.id, created.id, diningA.id, embedding);
      expect(updated?.categoryId).toBe(diningA.id);

      const row = await admin.merchantEmbedding.findUniqueOrThrow({
        where: { userId_merchantKey: { userId: userA.id, merchantKey: "feedback loop cafe" } },
      });
      expect(row.categoryId).toBe(diningA.id);
      expectVectorClose(row.embedding, embedding);
    });

    it("does NOT write to MerchantEmbedding when no embedding is supplied", async () => {
      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -1200n,
        occurredAt: new Date(),
        description: "No Embedding Diner",
        merchantName: "No Embedding Diner",
      });
      await updateTransactionCategory(userA.id, created.id, diningA.id); // no embedding argument

      const row = await admin.merchantEmbedding.findUnique({
        where: { userId_merchantKey: { userId: userA.id, merchantKey: "no embedding diner" } },
      });
      expect(row).toBeNull();
    });

    it("a correction on a nonexistent/foreign transaction still returns null and writes nothing (IDOR)", async () => {
      const result = await updateTransactionCategory(userB.id, "does-not-exist", diningA.id, vector(11));
      expect(result).toBeNull();
    });
  });

  describe("createTransaction — Tier 3 similarity match", () => {
    it("assigns the category of a similar prior correction instead of falling back to Uncategorized", async () => {
      const referenceEmbedding = vector(20);
      await upsertMerchantEmbedding(userA.id, {
        merchantKey: "aroma espresso bar",
        sampleMerchantName: "Aroma Espresso Bar",
        categoryId: diningA.id,
        embedding: referenceEmbedding,
      });

      // A DIFFERENT merchant string (so Tier 1's exact-match path can't
      // fire) whose embedding is deliberately close to the stored one —
      // simulating what a real model would produce for a near-duplicate
      // merchant descriptor (e.g. a trailing transaction ID).
      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -3200n,
        occurredAt: new Date(),
        description: "Aroma Espresso Bar #4471",
        merchantName: "Aroma Espresso Bar #4471",
        embedding: nearVector(referenceEmbedding),
      });

      expect(created.categoryId).toBe(diningA.id);
      expect(created.needsReview).toBe(false);
    });

    it("falls back to Uncategorized when an embedding is supplied but no correction is similar enough", async () => {
      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -900n,
        occurredAt: new Date(),
        description: "Completely Unrelated New Merchant Zzz",
        merchantName: "Completely Unrelated New Merchant Zzz",
        embedding: vector(999), // far from every stored correction
      });

      expect(created.categoryId).toBe(uncategorizedA.id);
      expect(created.needsReview).toBe(true);
    });

    it("without an embedding, Tier 3 is skipped entirely and the existing Tier 1-2-only behavior is unchanged", async () => {
      // Same merchant as the Tier-3 test above, but no embedding this
      // time and a merchant string that never exactly matched a Tier 1
      // occurrence — must NOT accidentally categorize via Tier 3.
      const created = await createTransaction(userA.id, {
        bankAccountId: accountA.id,
        amountAgorot: -1000n,
        occurredAt: new Date(),
        description: "Aroma Espresso Bar #9999",
        merchantName: "Aroma Espresso Bar #9999",
      });

      expect(created.categoryId).toBe(uncategorizedA.id);
      expect(created.needsReview).toBe(true);
    });

    it("does not leak user A's corrections into user B's Tier 3 lookup (IDOR)", async () => {
      const referenceEmbedding = vector(30);
      await upsertMerchantEmbedding(userA.id, {
        merchantKey: "shared-name-merchant",
        sampleMerchantName: "Shared Name Merchant",
        categoryId: diningA.id,
        embedding: referenceEmbedding,
      });

      const accountB = await admin.bankAccount.create({
        data: { userId: userB.id, institutionName: "Test Bank", last4: "5678", accountType: "CHECKING", nativeBalance: 5_000n },
      });
      const uncategorizedB = await admin.category.create({
        data: { userId: userB.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
      });

      const created = await createTransaction(userB.id, {
        bankAccountId: accountB.id,
        amountAgorot: -700n,
        occurredAt: new Date(),
        description: "Shared Name Merchant",
        merchantName: "Shared Name Merchant",
        embedding: nearVector(referenceEmbedding), // would match userA's correction if IDOR leaked
      });

      expect(created.categoryId).toBe(uncategorizedB.id);
    });
  });
});
