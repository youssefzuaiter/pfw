import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DebtPaymentMatchRow } from "./debt-payment-matches-panel";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const { DebtPaymentMatchesPanel } = await import("./debt-payment-matches-panel");

const rows: DebtPaymentMatchRow[] = [
  { debtId: "d1", transactionId: "t1", debtName: "Car loan", label: "VW FINANCE", date: "2026-10-05", amountFormatted: "₪500.00" },
  { debtId: "d2", transactionId: "t2", debtName: "Mortgage", label: "LEUMI MORTGAGE", date: "2026-10-06", amountFormatted: "₪2,000.00" },
];

describe("DebtPaymentMatchesPanel", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("lists each payment with the debt it pays, all ticked, and says what recording does", () => {
    render(<DebtPaymentMatchesPanel rows={rows} />);
    expect(screen.getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("VW FINANCE")).toBeInTheDocument();
    expect(screen.getByText(/pays Car loan/)).toBeInTheDocument();
    expect(screen.getByText(/lowers that debt/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record 2 payments" })).toBeEnabled();
  });

  it("sends exactly the ticked payments, then says how many were recorded and refreshes", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, applied: 1, skipped: 0 }), { status: 200 });
      }),
    );
    render(<DebtPaymentMatchesPanel rows={rows} />);
    fireEvent.click(screen.getByLabelText(/Record LEUMI MORTGAGE/));
    fireEvent.click(screen.getByRole("button", { name: "Record 1 payment" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ items: [{ debtId: "d1", transactionId: "t1" }] });
    expect(await screen.findByText(/Recorded 1 payment\./)).toBeInTheDocument();
    expect(refreshMock).toHaveBeenCalled();
  });

  it("says when some no longer matched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, applied: 1, skipped: 1 }), { status: 200 })));
    render(<DebtPaymentMatchesPanel rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "Record 2 payments" }));
    expect(await screen.findByText(/1 no longer matched and were left alone/)).toBeInTheDocument();
  });

  it("turns Record off with nothing ticked, and shows a server error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 })));
    render(<DebtPaymentMatchesPanel rows={rows} />);
    fireEvent.click(screen.getByLabelText(/Record VW FINANCE/));
    fireEvent.click(screen.getByLabelText(/Record LEUMI MORTGAGE/));
    expect(screen.getByRole("button", { name: "Record 0 payments" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Record VW FINANCE/));
    fireEvent.click(screen.getByRole("button", { name: "Record 1 payment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests");
  });
});
