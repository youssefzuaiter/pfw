/**
 * One-time/on-demand maintenance script (AGENTS.md §3ee) closing two
 * gaps the Punch List flagged as real: (a) MerchantEmbedding rows still
 * tagged with a superseded `embeddingModel` (every row predating §3bb's
 * model swap, and any future swap), and (b) NotableTransaction rows with
 * no `searchEmbedding` at all — every transaction that existed before
 * §3cc's semantic search shipped, or that was never given one (CSV
 * imports, §3j/§3u's own documented scope cut).
 *
 * Run with: npm run backfill:embeddings
 *
 * ---------------------------------------------------------------------
 * A REAL, DELIBERATE ARCHITECTURAL EXCEPTION, STATED PLAINLY — not
 * glossed over:
 *
 * Every other embedding in this app is computed CLIENT-SIDE ONLY
 * (src/lib/embeddings/local-embedder.ts, guarded by
 * tests/guards/local-embedder-client-only.test.ts) specifically so no
 * financial text is ever processed server-side as part of live request
 * handling (§3u's whole reason for choosing this over the old Python
 * sidecar). This script breaks that pattern on purpose, for a narrow,
 * different reason: a backfill has no "the user's own browser, in the
 * moment" to run in — the data already exists, was entered before this
 * feature did, and needs a real computation to happen SOMEWHERE.
 *
 * This is NOT the same threat model as a live server-side feature:
 *   - Nothing here runs during ordinary request handling — this is an
 *     operator-run maintenance script, the same category as
 *     scripts/sync-crypto-prices.ts, scripts/sync-exchange-rates.ts, and
 *     prisma/seed/ itself (which already needs the RLS-bypassing admin
 *     client for the same structural reason: it has to touch every
 *     user's rows, not just one request's worth).
 *   - No text ever leaves this machine — `@huggingface/transformers`
 *     resolves to its Node/onnxruntime-node backend here (verified live
 *     against this exact platform before writing this script), not a
 *     third-party API call. It's a different EXECUTION BACKEND from the
 *     browser's WASM one, not a different network destination.
 *   - Deliberately kept OUT of src/server/** — this file, not a new
 *     src/server/embeddings/ module, is what imports
 *     @huggingface/transformers directly, for the same reason
 *     prisma/seed/ sits outside that boundary rather than inside it:
 *     the guard test's REAL intent ("the embedding model never runs as
 *     part of the live server") stays intact in spirit, not just in its
 *     literal regex match on `local-embedder`.
 *
 * KNOWN, HONEST CAVEAT: the Node backend (onnxruntime-node) and the
 * browser's WASM backend (onnxruntime-web) are different runtime
 * implementations of the same ONNX graph — floating-point operation
 * ordering can differ enough to produce a bit-level-different (though
 * not meaningfully different for cosine-similarity purposes) vector for
 * the exact same input text than a real browser would compute. Verified
 * this script's output is still correctly 384-dimensional and
 * L2-normalized, not that it's bit-identical to a browser's output —
 * that distinction matters for KNN/cosine-similarity correctness
 * (unaffected) but would matter more if this app ever needed
 * byte-for-byte reproducibility (it doesn't).
 * ---------------------------------------------------------------------
 */
import "dotenv/config";
import { pipeline } from "@huggingface/transformers";
import { CURRENT_EMBEDDING_MODEL_ID } from "../src/lib/embeddings/embedding-model";
import { toPgVectorLiteral } from "../src/lib/vector-math";
import { createAdminClient } from "../src/server/db/admin-client";

type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

async function loadModel(): Promise<FeatureExtractionPipeline> {
  console.log(`Loading ${CURRENT_EMBEDDING_MODEL_ID} (Node/onnxruntime-node backend, q8)...`);
  const extractor = (await pipeline("feature-extraction", CURRENT_EMBEDDING_MODEL_ID, {
    dtype: "q8",
  })) as unknown as FeatureExtractionPipeline;
  console.log("Model loaded.");
  return extractor;
}

async function embed(extractor: FeatureExtractionPipeline, text: string): Promise<number[]> {
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

async function backfillMerchantEmbeddings(admin: ReturnType<typeof createAdminClient>, extractor: FeatureExtractionPipeline) {
  const stale = await admin.merchantEmbedding.findMany({
    where: { embeddingModel: { not: CURRENT_EMBEDDING_MODEL_ID } },
    select: { id: true, userId: true, sampleMerchantName: true, merchantKey: true },
  });

  console.log(`\nMerchantEmbedding: ${stale.length} row(s) tagged with a superseded model.`);
  let succeeded = 0;
  let failed = 0;

  for (const row of stale) {
    try {
      const embedding = await embed(extractor, row.sampleMerchantName);
      await admin.merchantEmbedding.update({
        where: { id: row.id },
        data: { embedding, embeddingModel: CURRENT_EMBEDDING_MODEL_ID },
      });
      succeeded++;
    } catch (error) {
      failed++;
      console.error(`  FAILED merchantKey="${row.merchantKey}" (user ${row.userId}): ${(error as Error).message}`);
    }
  }

  console.log(`MerchantEmbedding: ${succeeded} re-embedded, ${failed} failed.`);
  return { succeeded, failed };
}

async function backfillTransactionSearchEmbeddings(
  admin: ReturnType<typeof createAdminClient>,
  extractor: FeatureExtractionPipeline,
) {
  // Unsupported("vector(384)") has no typed Prisma Client read/write
  // path (same reason src/server/dal/transactions.ts's
  // searchTransactionsSemantic uses raw SQL, §3cc) — this is the one
  // place in the whole app that filters ON that column, so it has to be
  // raw SQL too.
  const missing = await admin.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "NotableTransaction" WHERE "searchEmbedding" IS NULL
  `;

  console.log(`\nNotableTransaction: ${missing.length} row(s) missing a search embedding.`);
  let succeeded = 0;
  let failed = 0;

  for (const { id } of missing) {
    try {
      // admin.notableTransaction.findFirst goes through the SAME
      // encrypted-fields Prisma Client extension the seed script and
      // every other admin-client read already does (§3q's own verified
      // finding) — `description` comes back plaintext here, not
      // ciphertext.
      const transaction = await admin.notableTransaction.findFirst({
        where: { id },
        select: { merchantName: true, description: true },
      });
      if (!transaction) continue; // deleted between the SELECT above and now — skip, not an error

      const merchantText = transaction.merchantName ?? transaction.description;
      const embedding = await embed(extractor, merchantText);
      const vectorLiteral = toPgVectorLiteral(embedding);
      await admin.$executeRaw`UPDATE "NotableTransaction" SET "searchEmbedding" = ${vectorLiteral}::vector WHERE "id" = ${id}`;
      succeeded++;
    } catch (error) {
      failed++;
      console.error(`  FAILED transaction ${id}: ${(error as Error).message}`);
    }
  }

  console.log(`NotableTransaction: ${succeeded} embedded, ${failed} failed.`);
  return { succeeded, failed };
}

async function main() {
  const admin = createAdminClient();
  try {
    const extractor = await loadModel();

    const merchantResult = await backfillMerchantEmbeddings(admin, extractor);
    const transactionResult = await backfillTransactionSearchEmbeddings(admin, extractor);

    const totalFailed = merchantResult.failed + transactionResult.failed;
    console.log(
      `\nDone. ${merchantResult.succeeded + transactionResult.succeeded} embedding(s) written, ${totalFailed} failure(s).`,
    );
    // Idempotent by construction — every query above only ever selects
    // rows still needing work, so re-running this script (e.g. after
    // fixing whatever caused a row to fail) picks up exactly where it
    // left off, nothing more.
    if (totalFailed > 0) process.exitCode = 1;
  } finally {
    await admin.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
