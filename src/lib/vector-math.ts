/** Small vector-math helpers shared by the KNN categorizer and the embedding sidecar client. */

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(`Cannot compare vectors of different lengths: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Formats an embedding as pgvector's text literal (`[0.1,0.2,...]`) for
 * a `::vector` cast inside a raw SQL query (AGENTS.md §3cc) — Prisma's
 * `Unsupported("vector(n)")` type has no typed read/write path, so this
 * is the one place an embedding ever becomes SQL text in this app.
 *
 * Safe by construction, not merely by caller convention: every element
 * is checked finite HERE, not just trusted from upstream validation — a
 * finite JS number's string form can never contain a SQL metacharacter,
 * so there is no injection surface once that check holds, regardless of
 * what already ran before this. Hand-written rather than pulling in the
 * `pgvector` npm package's own formatting helper — this app's
 * established habit for a mechanical, obviously-correct primitive like
 * this one, the same call already made for the CSV tokenizer, the
 * Levenshtein distance, and the Box-Muller transform (never extended to
 * genuine cryptography, where §3x instead moved TOWARD an audited
 * library — a different risk class entirely).
 */
export function toPgVectorLiteral(embedding: readonly number[]): string {
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new RangeError("Embedding contains a non-finite value — cannot format as a pgvector literal");
    }
  }
  return `[${embedding.join(",")}]`;
}
