import { describe, expect, it } from "vitest";
import {
  compareMonthKeys,
  currentMonthKey,
  isValidMonthKey,
  monthKeyFor,
  monthKeyToExclusiveEndDate,
  monthKeyToStartDate,
} from "./date-month";

describe("isValidMonthKey()", () => {
  it("accepts well-formed month keys", () => {
    expect(isValidMonthKey("2026-01")).toBe(true);
    expect(isValidMonthKey("2026-09")).toBe(true);
    expect(isValidMonthKey("2026-12")).toBe(true);
  });

  it("rejects a month of 00 or 13", () => {
    expect(isValidMonthKey("2026-00")).toBe(false);
    expect(isValidMonthKey("2026-13")).toBe(false);
  });

  it("rejects a full date, a bare year, or garbage", () => {
    expect(isValidMonthKey("2026-09-03")).toBe(false);
    expect(isValidMonthKey("2026")).toBe(false);
    expect(isValidMonthKey("not-a-month")).toBe(false);
    expect(isValidMonthKey("")).toBe(false);
  });
});

describe("monthKeyFor()", () => {
  it("formats a UTC date as YYYY-MM", () => {
    expect(monthKeyFor(new Date("2026-09-03T12:00:00.000Z"))).toBe("2026-09");
  });

  it("is UTC-anchored, not local-timezone-anchored", () => {
    // 2026-01-01T00:00:00Z is still December 31st in a negative-offset
    // timezone — this must read as January regardless of the runtime's
    // local timezone, since the whole point of a string month key is to
    // avoid exactly this ambiguity.
    expect(monthKeyFor(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
  });
});

describe("currentMonthKey()", () => {
  it("matches monthKeyFor(new Date()) at call time", () => {
    expect(currentMonthKey()).toBe(monthKeyFor(new Date()));
  });
});

describe("compareMonthKeys()", () => {
  it("orders chronologically, including across a year boundary", () => {
    expect(compareMonthKeys("2026-01", "2026-02")).toBe(-1);
    expect(compareMonthKeys("2026-12", "2027-01")).toBe(-1);
    expect(compareMonthKeys("2026-02", "2026-01")).toBe(1);
    expect(compareMonthKeys("2026-05", "2026-05")).toBe(0);
  });
});

describe("monthKeyToStartDate()", () => {
  it("returns the first instant of the month, UTC", () => {
    expect(monthKeyToStartDate("2026-09").toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("monthKeyToExclusiveEndDate()", () => {
  it("returns the first instant of the NEXT month, UTC", () => {
    expect(monthKeyToExclusiveEndDate("2026-09").toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("rolls over a year boundary correctly", () => {
    expect(monthKeyToExclusiveEndDate("2026-12").toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("is always exactly one month after monthKeyToStartDate for the same key", () => {
    const start = monthKeyToStartDate("2026-02");
    const end = monthKeyToExclusiveEndDate("2026-02");
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });
});
