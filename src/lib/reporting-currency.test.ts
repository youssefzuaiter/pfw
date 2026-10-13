import { describe, expect, it } from "vitest";
import { agorot, formatAgorot } from "./money";
import {
  ILS_REPORTING,
  describeReportingRate,
  formatReportingAmount,
  formatReportingMinorUnits,
  isConvertedReporting,
  toReportingMinorUnits,
  type ReportingContext,
} from "./reporting-currency";

const USD: ReportingContext = { currency: "USD", ilsPerUnit: 3.7, rateDay: "2026-10-12" };

describe("reporting currency", () => {
  it("is exactly formatAgorot for ILS, whatever the amount", () => {
    for (const value of [0, 1, -1, 12_550, -1_234_567, 999_999_999]) {
      expect(formatReportingAmount(agorot(value), ILS_REPORTING)).toBe(formatAgorot(agorot(value)));
      expect(formatReportingAmount(agorot(value), ILS_REPORTING, { showPositiveSign: true })).toBe(
        formatAgorot(agorot(value), { showPositiveSign: true }),
      );
    }
    expect(isConvertedReporting(ILS_REPORTING)).toBe(false);
    expect(describeReportingRate(ILS_REPORTING)).toBeNull();
  });

  it("converts at ILS per unit and shows the currency's own symbol", () => {
    // ₪370.00 at ₪3.70 per $1 is exactly $100.00.
    expect(formatReportingAmount(agorot(37_000), USD)).toBe("$100.00");
    expect(toReportingMinorUnits(agorot(37_000), USD)).toBe(10_000);
    expect(formatReportingAmount(agorot(-1_234_567), USD)).toBe("-$3,336.67");
    expect(formatReportingAmount(agorot(37_000), USD, { showPositiveSign: true })).toBe("+$100.00");
    expect(formatReportingAmount(agorot(0), USD, { showPositiveSign: true })).toBe("$0.00");
    expect(isConvertedReporting(USD)).toBe(true);
  });

  it("rounds half away from zero, the same both ways", () => {
    // At ₪2 per €1, every odd agorot amount lands exactly on half a cent.
    const exactHalf: ReportingContext = { currency: "EUR", ilsPerUnit: 2, rateDay: null };
    expect(toReportingMinorUnits(agorot(1), exactHalf)).toBe(1);
    expect(toReportingMinorUnits(agorot(-1), exactHalf)).toBe(-1);
    expect(toReportingMinorUnits(agorot(3), exactHalf)).toBe(2);
    expect(toReportingMinorUnits(agorot(-3), exactHalf)).toBe(-2);
  });

  it("formats minor units that are already in the reporting currency, rounding any fraction", () => {
    expect(formatReportingMinorUnits(10_000, USD)).toBe("$100.00");
    expect(formatReportingMinorUnits(-250.4, USD)).toBe("-$2.50");
    expect(formatReportingMinorUnits(12_550, ILS_REPORTING)).toBe("₪125.50");
    expect(formatReportingMinorUnits(15, { currency: "TRY", ilsPerUnit: 0.09, rateDay: null })).toBe("₺0.15");
  });

  it("says which rate it used, and says so when the rate is only a fallback", () => {
    expect(describeReportingRate(USD)).toBe("₪3.7000 per $1, rate of 2026-10-12");
    expect(describeReportingRate({ currency: "TRY", ilsPerUnit: 0.0623, rateDay: null })).toBe(
      "₪0.0623 per ₺1, an approximate rate (none synced yet)",
    );
  });
});
