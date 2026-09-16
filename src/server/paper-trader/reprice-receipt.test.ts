import { describe, expect, it } from "vitest";
import { DRIFT_WARNING_RATIO, repriceReceipt } from "./reprice-receipt";

describe("repriceReceipt()", () => {
  it("books the native price at OUR rate, ignoring the trader's rate for money", () => {
    // $347.59 (34759 cents) at a synced 3.35 ILS/USD, while the trader
    // claims its fixed 3.7 — the agorot figure must come from 3.35.
    const result = repriceReceipt({ nativePriceMinorUnits: 34759, currency: "USD", ourRate: 3.35, traderRate: 3.7 });
    expect(result.nativePriceAmount).toBe(34759);
    expect(result.priceAgorot).toBe(Math.round(34759 * 3.35)); // 116443
    expect(result.exchangeRate).toBe(3.35);
  });

  it("flags drift beyond the threshold so an operator can see the trader's rate is stale", () => {
    const result = repriceReceipt({ nativePriceMinorUnits: 10_000, currency: "USD", ourRate: 3.35, traderRate: 3.7 });
    expect(result.driftWarning).toContain("3.7");
    expect(result.driftWarning).toContain("3.35");
  });

  it("stays quiet when the trader's rate is within the drift threshold", () => {
    const ourRate = 3.5;
    const traderRate = ourRate * (1 + DRIFT_WARNING_RATIO / 2);
    const result = repriceReceipt({ nativePriceMinorUnits: 10_000, currency: "USD", ourRate, traderRate });
    expect(result.driftWarning).toBeNull();
  });

  it("treats an ILS receipt as identity — no conversion, rate 1, never a drift warning", () => {
    const result = repriceReceipt({ nativePriceMinorUnits: 12550, currency: "ILS", ourRate: 1, traderRate: 3.7 });
    expect(result.priceAgorot).toBe(12550);
    expect(result.exchangeRate).toBe(1);
    expect(result.driftWarning).toBeNull();
  });

  it("does not let a malformed trader rate produce a warning or affect the booked price", () => {
    const result = repriceReceipt({ nativePriceMinorUnits: 10_000, currency: "EUR", ourRate: 4.0, traderRate: Number.NaN });
    expect(result.priceAgorot).toBe(40_000);
    expect(result.driftWarning).toBeNull();
  });

  it("rejects a non-positive synced rate loudly rather than booking at zero", () => {
    expect(() => repriceReceipt({ nativePriceMinorUnits: 10_000, currency: "USD", ourRate: 0, traderRate: 3.7 })).toThrow();
  });
});
