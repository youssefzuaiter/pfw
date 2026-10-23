import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferMatchView } from "./transfer-matches-panel";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const { TransferMatchesPanel } = await import("./transfer-matches-panel");

function match(overrides: Partial<TransferMatchView> = {}): TransferMatchView {
  return {
    outId: "o1",
    inId: "i1",
    outAccount: "Checking",
    inAccount: "Savings",
    outLabel: "Moved",
    inLabel: "Received",
    outDate: "2026-10-03",
    inDate: "2026-10-04",
    outCurrency: "ILS",
    inCurrency: "ILS",
    outNative: -50_000,
    inNative: 50_000,
    dayGap: 1,
    crossCurrency: false,
    ambiguous: false,
    preselected: true,
    ...overrides,
  };
}

type Call = { url: string; body: Record<string, unknown> };
function installFetch(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify(responses[url] ?? { ok: true }), { status: 200 });
    }),
  );
  return calls;
}

describe("TransferMatchesPanel", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("explains an empty result", () => {
    render(<TransferMatchesPanel matches={[]} />);
    expect(screen.getByText(/No transfers found/)).toBeInTheDocument();
  });

  it("ticks only the clear same-currency pairs to start with", () => {
    render(
      <TransferMatchesPanel
        matches={[
          match(),
          match({ outId: "o2", inId: "i2", ambiguous: true, preselected: false }),
          match({ outId: "o3", inId: "i3", crossCurrency: true, preselected: false }),
        ]}
      />,
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, false, false]);
    expect(screen.getByRole("button", { name: "Mark 1 pair as transfers" })).toBeEnabled();
    expect(screen.getByText("Could match more than one row")).toBeInTheDocument();
    expect(screen.getByText("Different currencies")).toBeInTheDocument();
  });

  it("shows each side with its currency and sign", () => {
    render(<TransferMatchesPanel matches={[match({ outCurrency: "TRY", outNative: -450_000, inCurrency: "USD", inNative: 8_700, crossCurrency: true, preselected: false })]} />);
    expect(screen.getByText("-₺4,500.00")).toBeInTheDocument();
    expect(screen.getByText("+$87.00")).toBeInTheDocument();
  });

  it("sends exactly the ticked pairs, then offers to undo the rows it marked", async () => {
    const calls = installFetch({
      "/api/transactions/transfer-matches/apply": { ok: true, applied: 2, skipped: 0, changedIds: ["o1", "i1", "o2", "i2"] },
    });
    render(<TransferMatchesPanel matches={[match(), match({ outId: "o2", inId: "i2", ambiguous: true, preselected: false }), match({ outId: "o3", inId: "i3", preselected: true })]} />);
    // Tick the second, untick the third.
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[1]);
    fireEvent.click(boxes[2]);
    fireEvent.click(screen.getByRole("button", { name: "Mark 2 pairs as transfers" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ pairs: [{ outId: "o1", inId: "i1" }, { outId: "o2", inId: "i2" }] });
    expect(await screen.findByText("Marked 2 pairs as transfers.")).toBeInTheDocument();
    expect(refreshMock).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({
      url: "/api/transactions/bulk",
      body: { ids: ["o1", "i1", "o2", "i2"], action: { type: "transfer", isTransfer: false } },
    });
    expect(await screen.findByText("Those transfers were unmarked.")).toBeInTheDocument();
  });

  it("says how many no longer matched", async () => {
    installFetch({ "/api/transactions/transfer-matches/apply": { ok: true, applied: 1, skipped: 1, changedIds: ["o1", "i1"] } });
    render(<TransferMatchesPanel matches={[match(), match({ outId: "o2", inId: "i2" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark 2 pairs as transfers" }));
    expect(await screen.findByText(/1 no longer matched and were left alone/)).toBeInTheDocument();
  });

  it("keeps Apply off with nothing ticked and has Tick all / Clear ones only / Tick none", () => {
    render(<TransferMatchesPanel matches={[match(), match({ outId: "o2", inId: "i2", ambiguous: true, preselected: false })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Tick none" }));
    expect(screen.getByRole("button", { name: "Mark 0 pairs as transfers" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Tick all" }));
    expect(screen.getByRole("button", { name: "Mark 2 pairs as transfers" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear ones only" }));
    expect(screen.getByRole("button", { name: "Mark 1 pair as transfers" })).toBeEnabled();
  });

  it("shows a server error and stays usable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 })));
    render(<TransferMatchesPanel matches={[match()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark 1 pair as transfers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests");
    expect(screen.getByRole("button", { name: "Mark 1 pair as transfers" })).toBeEnabled();
  });
});
