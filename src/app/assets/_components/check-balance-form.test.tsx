import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const { CheckBalanceForm } = await import("./check-balance-form");

type Call = { url: string; method: string; body: Record<string, unknown> };

function installFetch(responses: { url: string; status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) });
      const match = responses.find((r) => r.url === url)!;
      return new Response(JSON.stringify(match.body), { status: match.status ?? 200 });
    }),
  );
  return calls;
}

function ok(result: Partial<{ expectedNative: number; bankNative: number; gapNative: number; status: string; causes: unknown[] }>, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    accountLabel: "Main",
    day: "2026-10-16",
    result: { expectedNative: 100_000, bankNative: 100_000, gapNative: 0, status: "matches", causes: [], ...result },
    rows: [],
    movementCount: 3,
    approximate: false,
    ...extra,
  };
}

async function open(balance = "1000.00") {
  render(<CheckBalanceForm accountId="a1" isCard={false} currency="ILS" />);
  fireEvent.click(screen.getByRole("button", { name: "Check against bank" }));
  fireEvent.change(screen.getByLabelText(/Balance your bank shows/), { target: { value: balance } });
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
}

describe("CheckBalanceForm", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("sends the figure and the day, and says when they match", async () => {
    const calls = installFetch([{ url: "/api/bank-accounts/a1/check", body: ok({}) }]);
    await open();
    expect(await screen.findByText("They match. Nothing to fix.")).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ url: "/api/bank-accounts/a1/check", method: "POST", body: { balance: "1000.00" } });
    expect(calls[0].body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.queryByRole("button", { name: /Use the bank/ })).toBeNull();
  });

  it("shows the difference, the likely reasons with their rows, and an approximate note", async () => {
    installFetch([
      {
        url: "/api/bank-accounts/a1/check",
        body: ok(
          { expectedNative: 100_000, bankNative: 120_000, gapNative: 20_000, status: "bank-higher", causes: [{ kind: "duplicate", rowId: "r1", twinId: "r2" }, { kind: "missing-or-start" }] },
          {
            rows: [
              { id: "r1", day: "2026-10-03", label: "Cafe Roma", deltaNative: -20_000 },
              { id: "r2", day: "2026-10-04", label: "Cafe Roma", deltaNative: -20_000 },
            ],
            approximate: true,
          },
        ),
      },
    ]);
    await open("1200");
    expect(await screen.findByText(/Difference ₪200.00: your bank shows more than PFW/)).toBeInTheDocument();
    expect(screen.getByText(/looks like a duplicate of/)).toBeInTheDocument();
    expect(screen.getByText(/Cafe Roma on 2026-10-03 \(₪200.00\)/)).toBeInTheDocument();
    expect(screen.getByText(/A transaction of exactly this size may be missing/)).toBeInTheDocument();
    expect(screen.getByText(/entered in another currency/)).toBeInTheDocument();
  });

  it("says owed for a card, and which way", async () => {
    installFetch([{ url: "/api/bank-accounts/a1/check", body: ok({ expectedNative: 50_000, bankNative: 40_000, gapNative: -10_000, status: "bank-lower", causes: [{ kind: "missing-or-start" }] }) }]);
    render(<CheckBalanceForm accountId="a1" isCard currency="ILS" />);
    fireEvent.click(screen.getByRole("button", { name: "Check against bank" }));
    fireEvent.change(screen.getByLabelText(/Amount owed your bank shows/), { target: { value: "400" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/your bank shows less owed than PFW/)).toBeInTheDocument();
  });

  it("uses the bank's balance through the existing update, as of the checked day", async () => {
    const calls = installFetch([
      { url: "/api/bank-accounts/a1/check", body: ok({ bankNative: 120_000, gapNative: 20_000, status: "bank-higher", causes: [{ kind: "missing-or-start" }] }) },
      { url: "/api/bank-accounts/a1", body: { ok: true } },
    ]);
    await open("1200.00");
    fireEvent.click(await screen.findByRole("button", { name: /Use the bank/ }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ url: "/api/bank-accounts/a1", method: "PATCH", body: { nativeBalance: "1200.00", balanceAsOf: "2026-10-16" } });
    expect(await screen.findByText(/counts transactions from the day after 2026-10-16/)).toBeInTheDocument();
    expect(refreshMock).toHaveBeenCalled();
  });

  it("shows the server's reason, such as a day before the balance was entered", async () => {
    installFetch([{ url: "/api/bank-accounts/a1/check", status: 400, body: { error: "The balance you entered was for 2026-10-01." } }]);
    await open();
    expect(await screen.findByRole("alert")).toHaveTextContent("The balance you entered was for 2026-10-01.");
  });
});
