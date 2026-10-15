import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportingCurrencyProvider } from "./reporting-currency-provider";
import { ShekelEquivalentHint } from "./shekel-equivalent-hint";

/** "≈ $X at today's rate" beside a shekel-only amount input (AGENTS.md §3www). */
const USD = { currency: "USD" as const, ilsPerUnit: 3.7, latestMicros: 3_700_000, rateDay: "2026-10-12", history: [] };

describe("ShekelEquivalentHint", () => {
  it("shows a typed shekel amount in the reporting currency, at today's rate", () => {
    render(
      <ReportingCurrencyProvider value={USD}>
        <ShekelEquivalentHint value="500" />
      </ReportingCurrencyProvider>,
    );
    // ₪500.00 ÷ 3.7 = $135.135… → $135.14
    expect(screen.getByText("≈ $135.14 at today's rate")).toBeInTheDocument();
  });

  it("says nothing for an empty or unparseable amount", () => {
    const { container } = render(
      <ReportingCurrencyProvider value={USD}>
        <ShekelEquivalentHint value="" />
        <ShekelEquivalentHint value="12.345" />
        <ShekelEquivalentHint value="abc" />
      </ReportingCurrencyProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing when totals are shown in shekels", () => {
    const { container } = render(<ShekelEquivalentHint value="500" />);
    expect(container).toBeEmptyDOMElement();
  });
});
