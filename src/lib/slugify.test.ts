import { describe, expect, it } from "vitest";
import { slugify } from "./slugify";

describe("slugify()", () => {
  it("lowercases and trims a plain ASCII name", () => {
    expect(slugify("  Groceries  ")).toBe("groceries");
  });

  it("replaces internal whitespace with a hyphen", () => {
    expect(slugify("Dining Out")).toBe("dining-out");
  });

  it("preserves Hebrew characters rather than stripping them — the whole point of this module", () => {
    // An ASCII-only [a-z0-9] slugifier would reduce this to an empty string.
    expect(slugify("מכולת")).toBe("מכולת");
  });

  it("joins multi-word Hebrew names with a hyphen", () => {
    expect(slugify("רמי לוי")).toBe("רמי-לוי");
  });

  it("strips punctuation, collapsing it to a single hyphen", () => {
    expect(slugify("Coffee & Tea!!")).toBe("coffee-tea");
  });

  it("never leaves a leading or trailing hyphen", () => {
    expect(slugify("-leading and trailing-")).not.toMatch(/^-|-$/);
  });

  it("falls back to a generated slug when nothing letter/number-like survives", () => {
    expect(slugify("!!!")).toMatch(/^category-\d+$/);
  });
});
