import { describe, expect, it } from "vitest";
import { SeededRng, getMonthlySeed, hashStringToSeed, monthKeyFor } from "./rng";

describe("hashStringToSeed()", () => {
  it("is deterministic", () => {
    expect(hashStringToSeed("pfw-seed-2026-08")).toBe(hashStringToSeed("pfw-seed-2026-08"));
  });

  it("differs for different inputs", () => {
    expect(hashStringToSeed("pfw-seed-2026-08")).not.toBe(hashStringToSeed("pfw-seed-2026-09"));
  });
});

describe("SeededRng", () => {
  it("produces the exact same sequence for the same seed", () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    const sequenceA = Array.from({ length: 20 }, () => a.float());
    const sequenceB = Array.from({ length: 20 }, () => b.float());
    expect(sequenceA).toEqual(sequenceB);
  });

  it("produces a different sequence for a different seed", () => {
    const a = new SeededRng(1);
    const b = new SeededRng(2);
    const sequenceA = Array.from({ length: 20 }, () => a.float());
    const sequenceB = Array.from({ length: 20 }, () => b.float());
    expect(sequenceA).not.toEqual(sequenceB);
  });

  it("int() stays within [min, max] inclusive", () => {
    const rng = new SeededRng(7);
    for (let i = 0; i < 200; i++) {
      const value = rng.int(3, 5);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(5);
    }
  });

  it("pick() only returns items from the input", () => {
    const rng = new SeededRng(9);
    const items = ["a", "b", "c"];
    for (let i = 0; i < 50; i++) {
      expect(items).toContain(rng.pick(items));
    }
  });

  it("pick() rejects an empty array", () => {
    expect(() => new SeededRng(1).pick([])).toThrow(RangeError);
  });

  it("shuffle() is a permutation and doesn't mutate the input", () => {
    const rng = new SeededRng(3);
    const items = [1, 2, 3, 4, 5];
    const shuffled = rng.shuffle(items);
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect([...shuffled].sort()).toEqual([...items].sort());
  });
});

describe("monthKeyFor() / getMonthlySeed()", () => {
  it("produces the same key for two dates in the same UTC month", () => {
    expect(monthKeyFor(new Date("2026-08-01T00:00:00Z"))).toBe(monthKeyFor(new Date("2026-08-27T23:59:00Z")));
  });

  it("produces a different key across a month boundary", () => {
    expect(monthKeyFor(new Date("2026-08-31T23:59:59Z"))).not.toBe(monthKeyFor(new Date("2026-09-01T00:00:00Z")));
  });

  it("getMonthlySeed is reproducible within the same month", () => {
    expect(getMonthlySeed(new Date("2026-08-01T00:00:00Z"))).toBe(getMonthlySeed(new Date("2026-08-27T12:00:00Z")));
  });

  it("getMonthlySeed differs across months", () => {
    expect(getMonthlySeed(new Date("2026-08-15T00:00:00Z"))).not.toBe(
      getMonthlySeed(new Date("2026-09-15T00:00:00Z")),
    );
  });
});
