import "server-only";
import type { EmbeddingCorrection } from "../../lib/categorization/types";
import { withUserScope } from "../db/with-user-scope";

/**
 * DAL for the Self-Learning Vector Categorization Engine's reference
 * vector database (AGENTS.md §3u) — `MerchantEmbedding` rows, one per
 * (user, merchant), each holding that merchant's most recently confirmed
 * category and its client-computed embedding. This is the "feedback
 * loop": every manual recategorization or confident manual-entry
 * categorization upserts here, so the NEXT lookalike transaction's Tier 3
 * KNN vote (src/lib/categorization/tier3-knn.ts) sees it.
 */

export type UpsertMerchantEmbeddingInput = {
  merchantKey: string;
  sampleMerchantName: string;
  categoryId: string;
  embedding: readonly number[];
};

export type UpsertMerchantEmbeddingResult = { ok: true } | { ok: false; error: "category_not_found" };

/**
 * Upsert, not insert-only — this table holds ONE row per (user,
 * merchant): the merchant's most recently confirmed category. Correcting
 * the same merchant a second time (the user changed their mind, or an
 * earlier correction was wrong) simply overwrites the prior row rather
 * than accumulating a growing history of superseded corrections, which
 * would force every future KNN lookup to somehow weight "newest wins"
 * itself. `sampleMerchantName` and `embedding` are refreshed too, not
 * just `categoryId` — a later, better-formed merchant string (e.g. a
 * cleaner OCR read) should replace a noisier earlier one as the
 * reference vector for this merchant.
 */
export async function upsertMerchantEmbedding(
  userId: string,
  input: UpsertMerchantEmbeddingInput,
): Promise<UpsertMerchantEmbeddingResult> {
  return withUserScope(userId, async (tx) => {
    const category = await tx.category.findFirst({ where: { id: input.categoryId, userId } });
    if (!category) return { ok: false, error: "category_not_found" };

    await tx.merchantEmbedding.upsert({
      where: { userId_merchantKey: { userId, merchantKey: input.merchantKey } },
      create: {
        userId,
        merchantKey: input.merchantKey,
        sampleMerchantName: input.sampleMerchantName,
        categoryId: input.categoryId,
        embedding: [...input.embedding],
      },
      update: {
        sampleMerchantName: input.sampleMerchantName,
        categoryId: input.categoryId,
        embedding: [...input.embedding],
      },
    });

    return { ok: true };
  });
}

/**
 * Every one of this user's stored corrections, in the shape Tier 3's
 * `knnCategorize` wants. Deliberately no filtering/pagination — this
 * app's scale (a personal ledger with, at most, a few hundred distinct
 * merchants) makes an in-memory KNN scan over all of them the right
 * trade-off, the same reasoning `listTransactions`' post-decryption
 * `search` filter already documents for this app's size.
 */
export async function listEmbeddingCorrections(userId: string): Promise<EmbeddingCorrection[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.merchantEmbedding.findMany({ where: { userId }, select: { categoryId: true, embedding: true } }),
  );
  return rows.map((row) => ({ categoryId: row.categoryId, embedding: row.embedding }));
}
