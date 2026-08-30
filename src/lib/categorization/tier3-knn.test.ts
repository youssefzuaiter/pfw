import { describe, expect, it } from "vitest";
import { knnCategorize } from "./tier3-knn";

describe("knnCategorize() (Tier 3)", () => {
  it("returns null with no corrections", () => {
    expect(knnCategorize([1, 0, 0], [])).toBeNull();
  });

  it("picks the category of the single most similar neighbor", () => {
    const result = knnCategorize([1, 0, 0], [
      { categoryId: "cat-a", embedding: [1, 0, 0] },
      { categoryId: "cat-b", embedding: [0, 1, 0] },
    ]);
    expect(result).toMatchObject({ categoryId: "cat-a", tier: 3 });
    expect(result?.confidence).toBeCloseTo(1, 5);
  });

  it("returns null when no neighbor clears the similarity floor", () => {
    const result = knnCategorize([1, 0, 0], [{ categoryId: "cat-a", embedding: [0, 1, 0] }]);
    expect(result).toBeNull();
  });

  it("computes confidence as the winning category's share of total similarity weight", () => {
    // cat-a: one neighbor at similarity 1.0. cat-b: one neighbor at
    // similarity ~0.9701 ([0.8, 0.2] vs [1, 0]). Confidence should be
    // cat-a's weight over the sum of both, not a plain vote count (which
    // would report a meaningless 1/2 = 0.5 for a 2-way tie in count).
    const result = knnCategorize([1, 0], [
      { categoryId: "cat-a", embedding: [1, 0] },
      { categoryId: "cat-b", embedding: [0.8, 0.2] },
    ]);
    const simB = 0.8 / Math.sqrt(0.8 ** 2 + 0.2 ** 2);
    expect(result?.categoryId).toBe("cat-a");
    expect(result?.confidence).toBeCloseTo(1 / (1 + simB), 10);
    expect(result?.confidence).toBeGreaterThan(0.5);
  });

  it("only considers the top k neighbors — without the k cap, sheer numbers would win instead", () => {
    // Each of these 10 neighbors is individually *almost* as similar to
    // the target as the single exact match, but not quite. With no cap,
    // their combined weight (10 x ~0.9999) would swamp the one exact
    // match's weight (1 x 1.0) in the vote. k=1 must restrict the
    // neighbor pool to just the single nearest one before voting, not
    // merely rank the winner correctly among all of them.
    const almostAsSimilarNeighbors = Array.from({ length: 10 }, () => ({
      categoryId: "cat-many-but-slightly-off",
      embedding: [0.76, 0.01],
    }));
    const result = knnCategorize(
      [1, 0],
      [{ categoryId: "cat-exact-match", embedding: [1, 0] }, ...almostAsSimilarNeighbors],
      { k: 1 },
    );
    expect(result?.categoryId).toBe("cat-exact-match");
  });

  it("accumulates weight across more than 2 same-category neighbors, not just pairwise", () => {
    // Three cat-a neighbors, each similarity 1.0 (weight 3.0 total), vs
    // one cat-b neighbor at similarity ~0.98. cat-a must win by summed
    // weight, and confidence must reflect the full 3-vs-1 split, not
    // just the top-ranked neighbor of each category.
    const result = knnCategorize(
      [1, 0],
      [
        { categoryId: "cat-a", embedding: [1, 0] },
        { categoryId: "cat-a", embedding: [1, 0] },
        { categoryId: "cat-a", embedding: [1, 0] },
        { categoryId: "cat-b", embedding: [0.99, 0.14] },
      ],
      { k: 4 },
    );
    expect(result?.categoryId).toBe("cat-a");
    expect(result?.confidence).toBeGreaterThan(0.75);
  });

  it("respects the exact minSimilarity boundary — inclusive at the threshold, exclusive just below it", () => {
    // Construct a neighbor at EXACTLY similarity 0.75 by using the same
    // vector scaled — cosine similarity of a vector with itself is
    // always 1, so instead pick an angle whose cosine is precisely 0.75.
    const target = [1, 0];
    const exactlyAtThreshold = [0.75, Math.sqrt(1 - 0.75 ** 2)]; // unit vector, cos(angle) = 0.75 exactly
    const included = knnCategorize(target, [{ categoryId: "cat-a", embedding: exactlyAtThreshold }], {
      minSimilarity: 0.75,
    });
    expect(included?.categoryId).toBe("cat-a");

    const justBelow = knnCategorize(target, [{ categoryId: "cat-a", embedding: exactlyAtThreshold }], {
      minSimilarity: 0.750001,
    });
    expect(justBelow).toBeNull();
  });

  it("excludes a neighbor with negative (opposite-direction) similarity", () => {
    const result = knnCategorize([1, 0], [{ categoryId: "cat-opposite", embedding: [-1, 0] }]);
    expect(result).toBeNull();
  });

  it("a custom minSimilarity below the default admits a more distant neighbor", () => {
    const distantNeighbor = { categoryId: "cat-far", embedding: [0.5, Math.sqrt(1 - 0.25)] }; // cos = 0.5
    expect(knnCategorize([1, 0], [distantNeighbor])).toBeNull(); // rejected under the default 0.75 floor
    expect(knnCategorize([1, 0], [distantNeighbor], { minSimilarity: 0.4 })?.categoryId).toBe("cat-far");
  });

  it("k larger than the available corrections uses all of them without error", () => {
    const result = knnCategorize(
      [1, 0],
      [
        { categoryId: "cat-a", embedding: [1, 0] },
        { categoryId: "cat-b", embedding: [0, 1] },
      ],
      { k: 50 },
    );
    expect(result?.categoryId).toBe("cat-a");
  });

  it("an exact tie in summed weight resolves deterministically to one winner, not a crash or undefined behavior", () => {
    // Two categories each with exactly one neighbor at identical
    // similarity — Map iteration order (insertion order for string
    // keys) makes this deterministic; the point of this test is that it
    // reliably returns ONE consistent category across repeated runs; not
    // which specific one wins.
    const runs = Array.from({ length: 5 }, () =>
      knnCategorize(
        [1, 0],
        [
          { categoryId: "cat-a", embedding: [1, 0] },
          { categoryId: "cat-b", embedding: [1, 0] },
        ],
      )?.categoryId,
    );
    expect(new Set(runs).size).toBe(1); // same winner every time
    expect(["cat-a", "cat-b"]).toContain(runs[0]);
  });

  it("throws (via cosineSimilarity) for a target/correction dimension mismatch, rather than silently comparing mismatched vectors", () => {
    expect(() => knnCategorize([1, 0, 0], [{ categoryId: "cat-a", embedding: [1, 0] }])).toThrow(RangeError);
  });

  it("real 384-dimension-shaped vectors round-trip through the same logic as the toy examples above", () => {
    // Not a real model output — just confirms nothing about the KNN math
    // itself is accidentally coupled to small toy dimensions.
    const dims = 384;
    const base = Array.from({ length: dims }, (_, i) => Math.sin(i));
    const norm = Math.sqrt(base.reduce((sum, v) => sum + v * v, 0));
    const target = base.map((v) => v / norm);
    const identical = { categoryId: "cat-a", embedding: [...target] };
    const orthogonalish = { categoryId: "cat-b", embedding: Array.from({ length: dims }, (_, i) => Math.cos(i)) };

    const result = knnCategorize(target, [identical, orthogonalish]);
    expect(result?.categoryId).toBe("cat-a");
    expect(result?.confidence).toBeGreaterThan(0.9);
  });
});
