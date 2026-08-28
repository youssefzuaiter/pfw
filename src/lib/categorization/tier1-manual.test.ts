import { describe, expect, it } from "vitest";
import { findManualCorrection } from "./tier1-manual";

describe("findManualCorrection() (Tier 1)", () => {
  it("returns null when there are no occurrences", () => {
    expect(findManualCorrection([])).toBeNull();
  });

  it("returns null when no occurrence was a manual correction", () => {
    expect(
      findManualCorrection([
        { categoryId: "cat-groceries", isManual: false },
        { categoryId: "cat-groceries", isManual: false },
      ]),
    ).toBeNull();
  });

  it("returns the category when all manual corrections agree", () => {
    const result = findManualCorrection([
      { categoryId: "cat-groceries", isManual: true },
      { categoryId: "cat-groceries", isManual: true },
      { categoryId: "cat-groceries", isManual: false }, // ignored — not manual
    ]);
    expect(result).toMatchObject({ categoryId: "cat-groceries", tier: 1 });
    expect(result?.confidence).toBe(1);
  });

  it("returns null when manual corrections disagree below the agreement threshold", () => {
    const result = findManualCorrection([
      { categoryId: "cat-a", isManual: true },
      { categoryId: "cat-b", isManual: true },
    ]);
    expect(result).toBeNull();
  });

  it("returns the majority category when agreement is at/above the threshold", () => {
    const result = findManualCorrection([
      { categoryId: "cat-a", isManual: true },
      { categoryId: "cat-a", isManual: true },
      { categoryId: "cat-a", isManual: true },
      { categoryId: "cat-a", isManual: true },
      { categoryId: "cat-b", isManual: true },
    ]);
    expect(result).toMatchObject({ categoryId: "cat-a", tier: 1 });
    expect(result?.confidence).toBe(0.8);
  });
});
