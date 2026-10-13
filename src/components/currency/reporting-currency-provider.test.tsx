import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { nativeAmount } from "../../lib/currency";
import { setCurrencyDisplayMode } from "../../lib/hooks/use-currency-display-mode";
import { agorot } from "../../lib/money";
import type { ReportingContext } from "../../lib/reporting-currency";
import { CurrencyAmount } from "./currency-amount";
import { CurrencyToggle } from "./currency-toggle";
import { ReportingAmount, ReportingCurrencyProvider, ReportingRateNote } from "./reporting-currency-provider";

const USD: ReportingContext = { currency: "USD", ilsPerUnit: 3.7, rateDay: "2026-10-12" };

function inUsd(node: React.ReactNode) {
  return render(<ReportingCurrencyProvider value={USD}>{node}</ReportingCurrencyProvider>);
}

describe("reporting currency in components", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows shekels with no provider, exactly as before", () => {
    render(
      <p>
        <ReportingAmount value={12_550} />
      </p>,
    );
    expect(screen.getByText("₪125.50")).toBeInTheDocument();
  });

  it("converts an ILS amount into the provided currency", () => {
    inUsd(
      <p>
        <ReportingAmount value={-37_000} showPositiveSign />
      </p>,
    );
    expect(screen.getByText("-$100.00")).toBeInTheDocument();
  });

  it("states the rate when it converts, and nothing in shekels", () => {
    const { container } = render(<ReportingRateNote />);
    expect(container).toBeEmptyDOMElement();
    inUsd(<ReportingRateNote />);
    expect(screen.getByText(/Totals shown in US dollars at ₪3\.7000 per \$1, rate of 2026-10-12\./)).toBeInTheDocument();
  });

  it("shows an amount already in the reporting currency once, exactly as recorded", () => {
    // ₪370.01 would convert to $100.00; the recorded native figure must win, not a round trip.
    inUsd(<CurrencyAmount agorotValue={agorot(37_001)} nativeValue={nativeAmount(10_003)} currency="USD" />);
    const paragraphs = screen.getAllByText(/./, { selector: "p" });
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toHaveTextContent("$100.03");
  });

  it("pairs a shekel amount with its converted figure, converted first by default", () => {
    inUsd(<CurrencyAmount agorotValue={agorot(37_000)} nativeValue={nativeAmount(37_000)} currency="ILS" />);
    const [primary, secondary] = screen.getAllByText(/./, { selector: "p" });
    expect(primary).toHaveTextContent("$100.00");
    expect(secondary).toHaveTextContent("₪370.00");
  });

  it("puts the native figure first in native mode, and converts the other side into the reporting currency", () => {
    setCurrencyDisplayMode("native");
    inUsd(<CurrencyAmount agorotValue={agorot(3_700)} nativeValue={nativeAmount(41_111)} currency="TRY" />);
    const [primary, secondary] = screen.getAllByText(/./, { selector: "p" });
    expect(primary).toHaveTextContent("₺411.11");
    expect(secondary).toHaveTextContent("$10.00");
  });

  it("lets an inner provider pin a subtree back to shekels (the trading screens)", () => {
    inUsd(
      <ReportingCurrencyProvider value={{ currency: "ILS", ilsPerUnit: 1, rateDay: null }}>
        <p>
          <ReportingAmount value={37_000} />
        </p>
      </ReportingCurrencyProvider>,
    );
    expect(screen.getByText("₪370.00")).toBeInTheDocument();
  });

  it("names the reporting currency on the toggle", () => {
    inUsd(<CurrencyToggle />);
    expect(screen.getByRole("button")).toHaveTextContent("Showing: $ (USD)");
  });
});
