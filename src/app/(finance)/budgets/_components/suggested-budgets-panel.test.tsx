import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestedBudgetRow } from "./suggested-budgets-panel";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const { SuggestedBudgetsPanel } = await import("./suggested-budgets-panel");

const rows: SuggestedBudgetRow[] = [
  { categoryId: "g", categoryName: "Groceries", averageFormatted: "₪1,610.00", suggestedValue: "1610.00" },
  { categoryId: "d", categoryName: "Dining", averageFormatted: "₪1,005.00", suggestedValue: "1010.00" },
];

function installFetch(response: Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return response;
    }),
  );
  return calls;
}

describe("SuggestedBudgetsPanel", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("lists every suggestion ticked, with the total against what is available", () => {
    render(<SuggestedBudgetsPanel month="2026-10" monthsUsed={3} availableAgorot={500_000} rows={rows} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("₪2,620.00")).toBeInTheDocument();
    expect(screen.getByText(/over the last 3 months with activity/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set 2 envelopes" })).toBeEnabled();
  });

  it("turns Apply off and says so when the total is more than is available", () => {
    render(<SuggestedBudgetsPanel month="2026-10" monthsUsed={3} availableAgorot={200_000} rows={rows} />);
    expect(screen.getByRole("button", { name: "Set 2 envelopes" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Untick some or lower an amount");
    // Unticking one brings it back under.
    fireEvent.click(screen.getByLabelText("Set a budget for Groceries"));
    expect(screen.getByRole("button", { name: "Set 1 envelope" })).toBeEnabled();
  });

  it("recomputes the total from edited amounts, and refuses a bad or zero amount", () => {
    render(<SuggestedBudgetsPanel month="2026-10" monthsUsed={1} availableAgorot={500_000} rows={rows} />);
    fireEvent.change(screen.getByLabelText(/Amount for Groceries/), { target: { value: "1000" } });
    expect(screen.getByText("₪2,010.00")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Amount for Dining/), { target: { value: "abc" } });
    expect(screen.getByRole("button", { name: "Set 2 envelopes" })).toBeDisabled();
    expect(screen.getByText(/Enter an amount above zero/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Amount for Dining/), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Set 2 envelopes" })).toBeDisabled();
    // An unticked bad amount does not block the rest.
    fireEvent.click(screen.getByLabelText("Set a budget for Dining"));
    expect(screen.getByRole("button", { name: "Set 1 envelope" })).toBeEnabled();
    expect(screen.getByText(/last 1 month with activity/)).toBeInTheDocument();
  });

  it("sends exactly the ticked envelopes with their edited amounts, then says what it did", async () => {
    const calls = installFetch(new Response(JSON.stringify({ ok: true, applied: 1, totalAgorot: 100_000 }), { status: 200 }));
    render(<SuggestedBudgetsPanel month="2026-10" monthsUsed={3} availableAgorot={500_000} rows={rows} />);
    fireEvent.click(screen.getByLabelText("Set a budget for Dining"));
    fireEvent.change(screen.getByLabelText(/Amount for Groceries/), { target: { value: " 1000.00 " } });
    fireEvent.click(screen.getByRole("button", { name: "Set 1 envelope" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: "/api/envelopes/suggestions/apply", body: { month: "2026-10", items: [{ categoryId: "g", amount: "1000.00" }] } });
    expect(await screen.findByText(/Set 1 envelope for 2026-10/)).toBeInTheDocument();
    expect(refreshMock).toHaveBeenCalled();
  });

  it("shows the server's reason and stays usable", async () => {
    installFetch(new Response(JSON.stringify({ error: "These add up to more than is available." }), { status: 400 }));
    render(<SuggestedBudgetsPanel month="2026-10" monthsUsed={3} availableAgorot={500_000} rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "Set 2 envelopes" }));
    expect(await screen.findByText("These add up to more than is available.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set 2 envelopes" })).toBeEnabled();
  });
});
