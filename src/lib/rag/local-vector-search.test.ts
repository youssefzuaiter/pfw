import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_SIMILARITY, DEFAULT_TOP_K, rankTransactionsBySimilarity } from "./local-vector-search";
import type { CachedVector } from "./local-vector-store";

function spike(index: number, dimensions = 8): number[] {
  const vector = new Array(dimensions).fill(0.01);
  vector[index] = 1;
  return vector;
}

describe("rankTransactionsBySimilarity()", () => {
  it("ranks an identical vector as the top match", () => {
    const query = spike(0);
    const vectors: CachedVector[] = [
      { transactionId: "same", embedding: spike(0) },
      { transactionId: "unrelated", embedding: spike(4) },
    ];

    const ranked = rankTransactionsBySimilarity(query, vectors);
    expect(ranked[0].transactionId).toBe("same");
    expect(ranked[0].similarity).toBeCloseTo(1, 5);
  });

  it("excludes a near-orthogonal (unrelated) vector below the similarity floor", () => {
    const query = spike(0);
    const vectors: CachedVector[] = [{ transactionId: "unrelated", embedding: spike(4) }];

    expect(rankTransactionsBySimilarity(query, vectors)).toEqual([]);
  });

  it("orders multiple matches most-similar-first", () => {
    const query = [1, 0, 0];
    const vectors: CachedVector[] = [
      { transactionId: "close", embedding: [0.9, 0.1, 0] },
      { transactionId: "closer", embedding: [0.99, 0.01, 0] },
      { transactionId: "closest", embedding: [1, 0, 0] },
    ];

    const ranked = rankTransactionsBySimilarity(query, vectors, { minSimilarity: 0 });
    expect(ranked.map((r) => r.transactionId)).toEqual(["closest", "closer", "close"]);
  });

  it("caps results at topK even when more rows clear the similarity floor", () => {
    const query = [1, 0];
    const vectors: CachedVector[] = Array.from({ length: 20 }, (_, i) => ({
      transactionId: `t${i}`,
      embedding: [1, 0],
    }));

    expect(rankTransactionsBySimilarity(query, vectors, { topK: 3 }).length).toBe(3);
  });

  it("defaults to DEFAULT_TOP_K and DEFAULT_MIN_SIMILARITY when no options are given", () => {
    const query = spike(0);
    const vectors: CachedVector[] = Array.from({ length: DEFAULT_TOP_K + 5 }, (_, i) => ({
      transactionId: `t${i}`,
      embedding: spike(0),
    }));

    const ranked = rankTransactionsBySimilarity(query, vectors);
    expect(ranked.length).toBe(DEFAULT_TOP_K);
    expect(ranked.every((r) => r.similarity >= DEFAULT_MIN_SIMILARITY)).toBe(true);
  });

  it("skips a cached vector whose dimensionality doesn't match the query, rather than throwing", () => {
    const query = spike(0, 8);
    const vectors: CachedVector[] = [
      { transactionId: "wrong-dims", embedding: [1, 0, 0] },
      { transactionId: "matches", embedding: spike(0, 8) },
    ];

    const ranked = rankTransactionsBySimilarity(query, vectors);
    expect(ranked.map((r) => r.transactionId)).toEqual(["matches"]);
  });

  it("returns an empty array for an empty cache", () => {
    expect(rankTransactionsBySimilarity(spike(0), [])).toEqual([]);
  });
});
