import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORY_RULES, matchCategoryRule } from "./tier2-rules";

describe("matchCategoryRule() (Tier 2)", () => {
  it("matches a Hebrew merchant keyword to its category slug", () => {
    expect(matchCategoryRule("רמי לוי סניף מרכז")).toEqual({
      categorySlug: "groceries",
      keyword: "רמי לוי",
    });
  });

  it("matches a Latin-script merchant keyword", () => {
    expect(matchCategoryRule("NETFLIX.COM")).toMatchObject({ categorySlug: "entertainment" });
  });

  it("returns null when nothing matches", () => {
    expect(matchCategoryRule("חנות מקומית לא ידועה")).toBeNull();
  });

  it("does not match a substring that isn't a whole word", () => {
    // "פז" (a transport/fuel merchant keyword) must not match inside
    // "לפזר" ("to scatter"), which contains the same three letters
    // embedded mid-word, not as a standalone word.
    expect(matchCategoryRule("לפזר")).toBeNull();
  });

  it("respects rule priority order — the first matching rule wins", () => {
    const customRules = [
      { categorySlug: "first", keywords: ["קפה"] },
      { categorySlug: "second", keywords: ["קפה"] },
    ];
    expect(matchCategoryRule("בית קפה", customRules)).toEqual({ categorySlug: "first", keyword: "קפה" });
  });

  it("every default rule's keywords are non-empty and unique per rule", () => {
    for (const rule of DEFAULT_CATEGORY_RULES) {
      expect(rule.keywords.length).toBeGreaterThan(0);
      expect(new Set(rule.keywords).size).toBe(rule.keywords.length);
    }
  });
});
