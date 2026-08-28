import { describe, expect, it } from "vitest";
import { generateTransactionReviewInsights } from "./transaction-review-queue";

describe("generateTransactionReviewInsights()", () => {
  it("produces nothing when there is nothing to review", () => {
    expect(generateTransactionReviewInsights(0)).toHaveLength(0);
  });

  it("is informational for a small count", () => {
    const insights = generateTransactionReviewInsights(3);
    expect(insights[0].severity).toBe("info");
    expect(insights[0].title).toBe("3 transactions need review");
  });

  it("uses correct singular grammar for a count of 1", () => {
    const insights = generateTransactionReviewInsights(1);
    expect(insights[0].title).toBe("1 transaction needs review");
  });

  it("escalates to warning at the count threshold", () => {
    const insights = generateTransactionReviewInsights(10);
    expect(insights[0].severity).toBe("warning");
  });
});
