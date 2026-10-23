import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CashFlowChart } from "./cash-flow-chart";

const days = [
  { date: new Date("2026-10-17T00:00:00Z"), balance: 100_000 },
  { date: new Date("2026-10-18T00:00:00Z"), balance: 90_000 },
];
const minimum = { date: new Date("2026-10-18T00:00:00Z"), balance: 90_000 };

describe("CashFlowChart", () => {
  it("says what the bills you added contribute", () => {
    render(<CashFlowChart days={days} minimum={minimum} bills={{ count: 2, totalAgorot: 40_000 }} />);
    expect(screen.getByText(/Includes 2 charges from the bills you added/)).toBeInTheDocument();
    expect(screen.getByText("₪400.00")).toBeInTheDocument();
  });

  it("uses the singular for one charge", () => {
    render(<CashFlowChart days={days} minimum={minimum} bills={{ count: 1, totalAgorot: 20_000 }} />);
    expect(screen.getByText(/Includes 1 charge from the bills you added/)).toBeInTheDocument();
  });

  it("says nothing about bills when none are included", () => {
    render(<CashFlowChart days={days} minimum={minimum} bills={{ count: 0, totalAgorot: 0 }} />);
    expect(screen.queryByText(/bills you added/)).toBeNull();
    expect(screen.getByText(/Lowest projected balance/)).toBeInTheDocument();
  });
});
