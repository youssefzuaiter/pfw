import { describe, expect, it } from "vitest";
import { formatAge, formatBps, formatDuration, formatSignedBps, formatUsdDecimal, formatUtcDateTime } from "./core-format";

describe("formatUtcDateTime", () => {
  it("is explicit about the zone, since the core trades on New York's clock and its owner reads in another", () => {
    expect(formatUtcDateTime(new Date("2026-10-05T13:05:00Z"))).toBe("Oct 5, 2026, 13:05 UTC");
    expect(formatUtcDateTime(new Date("2026-01-02T00:00:00Z"))).toBe("Jan 2, 2026, 00:00 UTC");
  });

  it("never throws on a date that is not one", () => {
    expect(formatUtcDateTime(new Date("nope"))).toBe("—");
  });
});

describe("formatAge", () => {
  it.each([
    [0, "just now"],
    [59, "just now"],
    [60, "1 min"],
    [3_599, "59 min"],
    [3_600, "1 h"],
    [86_399, "23 h"],
    [86_400, "1 d"],
    [3 * 86_400 + 5, "3 d"],
  ])("%d seconds is %s", (seconds, expected) => {
    expect(formatAge(seconds)).toBe(expected);
  });
});

describe("formatBps", () => {
  it("shows basis points as a percentage with two places", () => {
    expect(formatBps(1900)).toBe("19.00%");
    expect(formatBps(499)).toBe("4.99%");
    expect(formatBps(0)).toBe("0.00%");
    expect(formatBps(-100)).toBe("-1.00%");
    expect(formatBps(null)).toBe("—");
  });
});

describe("formatSignedBps", () => {
  it("shows a difference in percentage points, with its sign", () => {
    expect(formatSignedBps(100)).toBe("+1.00 pp");
    expect(formatSignedBps(-1)).toBe("-0.01 pp");
    expect(formatSignedBps(0)).toBe("0.00 pp");
    expect(formatSignedBps(null)).toBe("—");
  });
});

describe("formatUsdDecimal", () => {
  it("shows a dollar amount from the router with grouping, at least two places and at most four", () => {
    expect(formatUsdDecimal("1899.81")).toBe("$1,899.81");
    expect(formatUsdDecimal("91.00")).toBe("$91.00");
    expect(formatUsdDecimal("91")).toBe("$91.00");
    expect(formatUsdDecimal("102.6912")).toBe("$102.6912");
    expect(formatUsdDecimal("102.691200")).toBe("$102.6912");
    expect(formatUsdDecimal("1234567.5")).toBe("$1,234,567.50");
  });

  it("rounds a price finer than four places rather than cutting it", () => {
    expect(formatUsdDecimal("102.69125")).toBe("$102.6913");
    expect(formatUsdDecimal("0.00004")).toBe("$0.00");
  });

  it("puts the sign before the symbol", () => {
    expect(formatUsdDecimal("-3.5")).toBe("-$3.50");
  });

  it("returns text it cannot read as it was, so a label never throws", () => {
    expect(formatUsdDecimal("")).toBe("");
    expect(formatUsdDecimal("n/a")).toBe("n/a");
  });
});

describe("formatDuration", () => {
  it("is a span of time, in seconds until a minute and then the largest whole unit", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(6.4)).toBe("6 s");
    expect(formatDuration(59.4)).toBe("59 s");
    expect(formatDuration(59.6)).toBe("1 min"); // rounds up into the next unit, never "60 s"
    expect(formatDuration(90)).toBe("1 min");
    expect(formatDuration(7_200)).toBe("2 h");
  });
});
