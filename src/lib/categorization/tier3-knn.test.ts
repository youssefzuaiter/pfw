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
});
