import { describe, expect, it } from "vitest";
import { cosineSimilarity, parsePgVectorLiteral, toPgVectorLiteral } from "./vector-math";

describe("cosineSimilarity()", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns -1 for exactly opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns 0 when either vector is all zeros (avoids NaN from a 0/0 division)", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0);
  });

  it("is scale-invariant", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("rejects mismatched vector lengths", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(RangeError);
  });
});

describe("toPgVectorLiteral()", () => {
  it("formats a simple vector as a bracketed, comma-separated literal", () => {
    expect(toPgVectorLiteral([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });

  it("formats negative numbers and integers correctly", () => {
    expect(toPgVectorLiteral([-1, 0, 1])).toBe("[-1,0,1]");
  });

  it("formats an empty vector", () => {
    expect(toPgVectorLiteral([])).toBe("[]");
  });

  it("round-trips a realistic 384-dimension vector's exact string form", () => {
    const vector = Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.01);
    const literal = toPgVectorLiteral(vector);
    expect(literal.startsWith("[")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
    expect(literal.split(",")).toHaveLength(384);
  });

  it("rejects NaN", () => {
    expect(() => toPgVectorLiteral([0.1, NaN, 0.3])).toThrow(RangeError);
  });

  it("rejects Infinity and -Infinity", () => {
    expect(() => toPgVectorLiteral([Infinity, 0])).toThrow(RangeError);
    expect(() => toPgVectorLiteral([-Infinity, 0])).toThrow(RangeError);
  });

  it("a finite number's string form can never smuggle a SQL metacharacter — every valid output is digits, a decimal point, a minus sign, or scientific-notation e/+/-", () => {
    const vector = [1.5, -2.25, 0, 1e21, -1e-21];
    const literal = toPgVectorLiteral(vector);
    expect(literal).toMatch(/^\[[0-9.eE+,-]*\]$/);
  });
});

describe("parsePgVectorLiteral()", () => {
  it("round-trips a simple vector through toPgVectorLiteral", () => {
    const vector = [0.1, 0.2, 0.3, -1, 0];
    expect(parsePgVectorLiteral(toPgVectorLiteral(vector))).toEqual(vector);
  });

  it("round-trips a realistic 384-dimension vector", () => {
    const vector = Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.01);
    const parsed = parsePgVectorLiteral(toPgVectorLiteral(vector));
    expect(parsed).toHaveLength(384);
    parsed.forEach((value, i) => expect(value).toBeCloseTo(vector[i], 10));
  });

  it("parses an empty vector", () => {
    expect(parsePgVectorLiteral("[]")).toEqual([]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parsePgVectorLiteral("  [1,2,3]  ")).toEqual([1, 2, 3]);
  });

  it("rejects a string with no brackets", () => {
    expect(() => parsePgVectorLiteral("1,2,3")).toThrow(RangeError);
  });

  it("rejects a non-numeric element", () => {
    expect(() => parsePgVectorLiteral("[1,not-a-number,3]")).toThrow(RangeError);
  });
});
