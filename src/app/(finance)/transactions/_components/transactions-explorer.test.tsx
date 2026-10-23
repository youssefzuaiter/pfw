import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agorot } from "../../../../lib/money";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));
vi.mock("../../../../lib/embeddings/local-embedder", () => ({ embedTextWithTimeout: async () => undefined }));
vi.mock("./category-select", () => ({ CategorySelect: () => <span>category</span> }));
vi.mock("./ledger-history-modal", () => ({ LedgerHistoryModal: () => null }));
vi.mock("./split-editor-modal", () => ({ SplitEditorModal: () => null }));
vi.mock("./transaction-row-actions", () => ({ TransactionRowActions: () => <span data-testid="row-actions">actions</span> }));

const { TransactionsExplorer } = await import("./transactions-explorer");

function makeRow(id: string, name: string) {
  return {
    id,
    occurredAt: new Date("2026-10-05T12:00:00Z"),
    description: name,
    merchantName: name,
    amount: agorot(-10_000),
    categoryId: "c1",
    categoryName: "Groceries",
    needsReview: false,
    isTransfer: false,
    currency: "ILS" as const,
    nativeAmount: -10_000,
    splits: [],
  };
}

const ROWS = [makeRow("t1", "Alpha Market"), makeRow("t2", "Beta Cafe"), makeRow("t3", "Gamma Fuel")];
const CATEGORIES = [{ id: "c1", name: "Groceries" }, { id: "c2", name: "Dining" }];

describe("selecting transactions", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("ticking rows brings up the bar with the count, and Select all ticks every shown row", () => {
    render(<TransactionsExplorer initialRows={ROWS} categories={CATEGORIES} initialQuery="" />);
    expect(screen.queryByText(/selected$/)).toBeNull();

    const desktop = screen.getAllByRole("table")[0];
    fireEvent.click(within(desktop).getByLabelText("Select Alpha Market"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    fireEvent.click(within(desktop).getByLabelText("Select all shown transactions"));
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    fireEvent.click(within(desktop).getByLabelText("Select all shown transactions"));
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  it("sends only the ticked rows, and clears the selection afterwards", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, changed: 2, changedIds: ["t1", "t3"], skippedSplit: 0, unchanged: 0, notFound: 0 }), { status: 200 });
      }),
    );
    render(<TransactionsExplorer initialRows={ROWS} categories={CATEGORIES} initialQuery="" />);
    const desktop = screen.getAllByRole("table")[0];
    fireEvent.click(within(desktop).getByLabelText("Select Alpha Market"));
    fireEvent.click(within(desktop).getByLabelText("Select Gamma Fuel"));

    fireEvent.change(screen.getByLabelText(/category for the selected/i), { target: { value: "c2" } });
    fireEvent.click(screen.getByRole("button", { name: "Set category" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ ids: ["t1", "t3"], action: { type: "category", categoryId: "c2" } });
    await waitFor(() => expect(screen.queryByText("2 selected")).toBeNull());
  });
});
