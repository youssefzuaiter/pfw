import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { nativeAmount } from "../../lib/currency";
import { setCurrencyDisplayMode } from "../../lib/hooks/use-currency-display-mode";
import { agorot } from "../../lib/money";
import type { ReportingContext } from "../../lib/reporting-currency";
import { CurrencyAmount } from "./currency-amount";
import { CurrencyToggle } from "./currency-toggle";
import { ReportingAmount, ReportingCurrencyProvider, ReportingFlowAmount, ReportingRateNote } from "./reporting-currency-provider";

// Today's rate 3.7; Friday 28 August 2026 at 3.0 (AGENTS.md §3vvv).
const USD: ReportingContext = {
  currency: "USD",
  ilsPerUnit: 3.7,
  latestMicros: 3_700_000,
  rateDay: "2026-10-12",
  history: [
    { day: "2026-08-28", micros: 3_000_000 },
    { day: "2026-10-12", micros: 3_700_000 },
  ],
};

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
    expect(screen.getByText(/Totals shown in US dollars; today’s rate is ₪3\.7000 per \$1, rate of 2026-10-12\./)).toBeInTheDocument();
    expect(screen.getByText(/use the rate of their own day/)).toBeInTheDocument();
    expect(screen.getByText(/Rates are stored from 2026-08-28/)).toBeInTheDocument();
  });

  it("converts a transaction at the rate of its own day, the weekend at Friday's, and a dated figure the same way", () => {
    inUsd(
      <>
        <p data-testid="friday">
          <ReportingFlowAmount amount={-30_000} occurredAt="2026-08-28T10:00:00Z" />
        </p>
        <p data-testid="sunday">
          <ReportingFlowAmount amount={-30_000} occurredAt={new Date("2026-08-30T23:59:59Z")} />
        </p>
        <p data-testid="native">
          <ReportingFlowAmount amount={-30_000} occurredAt="2026-08-28" currency="USD" nativeAmount={-10_007} />
        </p>
        <p data-testid="snapshot">
          <ReportingAmount value={30_000} on="2026-08-29" />
        </p>
        <p data-testid="today">
          <ReportingAmount value={37_000} />
        </p>
      </>,
    );
    expect(screen.getByTestId("friday")).toHaveTextContent("-$100.00");
    expect(screen.getByTestId("sunday")).toHaveTextContent("-$100.00");
    expect(screen.getByTestId("native")).toHaveTextContent("-$100.07");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("$100.00");
    expect(screen.getByTestId("today")).toHaveTextContent("$100.00");
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
      <ReportingCurrencyProvider value={{ currency: "ILS", ilsPerUnit: 1, latestMicros: 1_000_000, rateDay: null, history: [] }}>
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
