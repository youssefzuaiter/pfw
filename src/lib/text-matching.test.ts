import { describe, expect, it } from "vitest";
import {
  buildWholeWordRegex,
  containsWholeWord,
  findFirstWholeWordMatch,
  normalizeMerchantKey,
} from "./text-matching";

describe("the Hebrew \\b bug this module fixes", () => {
  it("demonstrates that a plain ASCII \\b regex cannot match a Hebrew word at all", () => {
    // This is the exact bug: \b is defined over ASCII \w, Hebrew letters
    // aren't \w, so neither edge of the word is ever a "boundary".
    const brokenRegex = /\bקפה\b/;
    expect(brokenRegex.test("קפה קפה אספרסו בר")).toBe(false);
    expect(brokenRegex.test("קפה")).toBe(false);
  });

  it("the fixed matcher correctly finds the same Hebrew word", () => {
    expect(containsWholeWord("קפה קפה אספרסו בר", "קפה")).toBe(true);
    expect(containsWholeWord("קפה", "קפה")).toBe(true);
  });
});

describe("containsWholeWord()", () => {
  it("matches a whole word surrounded by spaces", () => {
    expect(containsWholeWord("רמי לוי סניף מרכז", "לוי")).toBe(true);
  });

  it("does not match a substring that isn't a whole word", () => {
    expect(containsWholeWord("שופרסל דיל", "רסל")).toBe(false);
  });

  it("matches at the start and end of the string", () => {
    expect(containsWholeWord("נטפליקס", "נטפליקס")).toBe(true);
  });

  it("is case-insensitive for Latin script", () => {
    expect(containsWholeWord("IKEA TEL AVIV", "ikea")).toBe(true);
  });

  it("does not match across punctuation-joined non-word text incorrectly", () => {
    expect(containsWholeWord("aaa-bbb", "aaa")).toBe(true);
    expect(containsWholeWord("aaabbb", "aaa")).toBe(false);
  });

  it("escapes regex-special characters in the search term", () => {
    expect(containsWholeWord("Wolt (delivery)", "(delivery)")).toBe(true);
    expect(() => containsWholeWord("a.b", "a.b")).not.toThrow();
  });
});

describe("findFirstWholeWordMatch()", () => {
  it("returns the first matching term", () => {
    expect(findFirstWholeWordMatch("רמי לוי סניף מרכז", ["שופרסל", "רמי לוי", "ויקטורי"])).toBe("רמי לוי");
  });

  it("returns undefined when nothing matches", () => {
    expect(findFirstWholeWordMatch("מסעדה לא ידועה", ["שופרסל", "רמי לוי"])).toBeUndefined();
  });
});

describe("buildWholeWordRegex()", () => {
  it("always includes the u flag even if not requested", () => {
    expect(buildWholeWordRegex("קפה", "").flags).toContain("u");
  });

  it("preserves caller-requested flags alongside u", () => {
    const regex = buildWholeWordRegex("קפה", "gi");
    expect(regex.flags).toContain("g");
    expect(regex.flags).toContain("i");
    expect(regex.flags).toContain("u");
  });
});

describe("normalizeMerchantKey()", () => {
  it("trims and lowercases", () => {
    expect(normalizeMerchantKey("  IKEA  ")).toBe("ikea");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeMerchantKey("רמי   לוי")).toBe("רמי לוי");
  });

  it("is stable under repeated normalization", () => {
    const once = normalizeMerchantKey("  Netflix   Inc  ");
    expect(normalizeMerchantKey(once)).toBe(once);
  });
});
