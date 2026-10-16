import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { agorot } from "../../../../lib/money";
import { computeSafeToSpend, type PendingBill } from "../../../../lib/safe-to-spend";
import { SafeToSpendCard } from "./safe-to-spend-card";

const a = agorot;

function bill(overrides: Partial<PendingBill> = {}): PendingBill {
  return {
    merchantKey: "landlord",
    displayName: "Landlord",
    categoryId: "rent",
    occurrences: 1,
    amountEachAgorot: a(400_000),
    totalAgorot: a(400_000),
    dueDate: new Date("2026-10-25T00:00:00Z"),
    overdue: false,
    ...overrides,
  };
}

function card(input: Partial<Parameters<typeof computeSafeToSpend>[0]> = {}) {
  const result = computeSafeToSpend({
    cashAgorot: a(1_000_000),
    cardOwedAgorot: a(0),
    pendingBills: [],
    envelopes: [],
    goalsDue: [],
    ...input,
  });
  return render(<SafeToSpendCard {...result} month="2026-10" />);
}

describe("SafeToSpendCard", () => {
  it("shows the figure as the headline", () => {
    card({ cardOwedAgorot: a(250_000) });
    expect(screen.getByTestId("safe-to-spend-value")).toHaveTextContent("₪7,500.00");
    expect(screen.queryByText("Over-committed")).not.toBeInTheDocument();
  });

  it("shows a negative figure as negative with a badge, never as zero", () => {
    card({ cashAgorot: a(100_000), pendingBills: [bill()] });
    const value = screen.getByTestId("safe-to-spend-value");
    expect(value).toHaveTextContent("-₪3,000.00");
    expect(value).toHaveClass("text-negative");
    expect(screen.getByText("Over-committed")).toBeInTheDocument();
  });

  it("spells the calculation out line by line", () => {
    card({ cardOwedAgorot: a(100_000), envelopes: [{ categoryId: "g", categoryName: "Groceries", balanceAgorot: a(200_000) }] });
    for (const label of [
      "Cash in checking and savings",
      "Credit card balances owed",
      "Envelope money still unspent",
      "Bills still due this month",
      "Debt minimum payments due",
      "Goal contributions due this month",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("How this is calculated")).toBeInTheDocument();
  });

  it("says when a bill is already held by its envelope", () => {
    card({
      envelopes: [{ categoryId: "rent", categoryName: "Rent", balanceAgorot: a(450_000) }],
      pendingBills: [bill()],
    });
    expect(screen.getByText("Paid from its envelope, so it is not deducted again.")).toBeInTheDocument();
  });

  it("says when a bill's charge is late", () => {
    card({ pendingBills: [bill({ overdue: true, dueDate: new Date("2026-10-05T00:00:00Z") })] });
    expect(screen.getByText(/expected Oct 5, not charged yet/)).toBeInTheDocument();
  });

  it("explains an over-budget envelope without adding anything back", () => {
    card({ envelopes: [{ categoryId: "d", categoryName: "Dining", balanceAgorot: a(-30_000) }] });
    const section = screen.getByText("Over budget").parentElement!;
    expect(within(section).getByText("Dining")).toBeInTheDocument();
    expect(within(section).getByText(/never adds anything back/)).toBeInTheDocument();
  });

  it("lists a debt's minimum, and says when a recurring bill already covers it", () => {
    card({
      debtsDue: [
        { debtId: "d1", name: "Student loan", minimumAgorot: a(40_000), paidThisMonthAgorot: a(10_000), dueAgorot: a(30_000), handledByBill: null },
        { debtId: "d2", name: "Car loan", minimumAgorot: a(90_000), paidThisMonthAgorot: a(0), dueAgorot: a(0), handledByBill: "Car loan payment" },
      ],
    });
    expect(screen.getByTestId("safe-to-spend-value")).toHaveTextContent("₪9,700.00");
    const section = screen.getByText("Debt payments this month").parentElement!;
    expect(within(section).getByText("Student loan")).toBeInTheDocument();
    expect(within(section).getByText(/paid as the recurring bill "Car loan payment", so not counted again/)).toBeInTheDocument();
  });

  it("reports income still expected beside the figure without adding it in", () => {
    card({ expectedIncome: [bill({ merchantKey: "employer", displayName: "Employer", totalAgorot: a(800_000) })] });
    expect(screen.getByTestId("safe-to-spend-value")).toHaveTextContent("₪10,000.00");
    const note = screen.getByTestId("safe-to-spend-expected-income");
    expect(note).toHaveTextContent("₪8,000.00 of income still expected this month (Employer, Oct 25)");
    expect(note).toHaveTextContent("you would have ₪18,000.00");
  });

  it("says plainly when savings are kept as a reserve", () => {
    card({ savingsCounted: false, savingsAgorot: a(500_000) });
    expect(screen.getByText("Cash in checking")).toBeInTheDocument();
    expect(screen.queryByText("Cash in checking and savings")).not.toBeInTheDocument();
    expect(screen.getByText(/kept as a reserve and not counted/)).toBeInTheDocument();
  });

  it("omits the bills, goals and over-budget sections when there is nothing to show", () => {
    card();
    expect(screen.queryByText("Debt payments this month")).not.toBeInTheDocument();
    expect(screen.queryByTestId("safe-to-spend-expected-income")).not.toBeInTheDocument();
    expect(screen.queryByText("Bills still to come")).not.toBeInTheDocument();
    expect(screen.queryByText("Goals this month")).not.toBeInTheDocument();
    expect(screen.queryByText("Over budget")).not.toBeInTheDocument();
  });
});
