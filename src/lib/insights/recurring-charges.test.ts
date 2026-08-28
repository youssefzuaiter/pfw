import { describe, expect, it } from "vitest";
import { agorot } from "../money";
import { generateRecurringChargeInsights } from "./recurring-charges";

describe("generateRecurringChargeInsights()", () => {
  it("maps a recurring detection result into an informational insight", () => {
    const insights = generateRecurringChargeInsights(
      [
        {
          merchantKey: "netflix",
          isRecurring: true,
          distinctMonths: 3,
          coefficientOfVariation: 0,
          averageAmount: agorot(4990),
          averageIntervalDays: 30,
        },
      ],
      (key) => (key === "netflix" ? "Netflix" : key),
    );
    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({ type: "recurring_charge_detected", severity: "info", relatedEntityId: "netflix" });
    expect(insights[0].title).toContain("Netflix");
  });

  it("filters out non-recurring results", () => {
    const insights = generateRecurringChargeInsights(
      [
        {
          merchantKey: "one-off",
          isRecurring: false,
          distinctMonths: 1,
          coefficientOfVariation: 0.5,
          averageAmount: agorot(1000),
          averageIntervalDays: null,
        },
      ],
      (key) => key,
    );
    expect(insights).toHaveLength(0);
  });
});
