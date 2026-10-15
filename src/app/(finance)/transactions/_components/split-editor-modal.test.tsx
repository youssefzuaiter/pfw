import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const { SplitEditorModal } = await import("./split-editor-modal");

/** The split editor (AGENTS.md §3xxx): Save stays off until the parts add up exactly. */
const CATEGORIES = [
  { id: "groceries", name: "Groceries" },
  { id: "household", name: "Household" },
];

function open(props: Partial<Parameters<typeof SplitEditorModal>[0]> = {}) {
  render(
    <SplitEditorModal
      transactionId="tx-1"
      label="Migros"
      currency="ILS"
      nativeTotal={-12_550}
      categoryId="groceries"
      splits={[]}
      categories={CATEGORIES}
      triggerLabel="Split"
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: props.triggerLabel ?? "Split" }));
}

describe("SplitEditorModal", () => {
  beforeEach(() => {
    refreshMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
  });

  it("starts with the whole amount on the current category and Save off until the parts add up", () => {
    open();
    expect(screen.getByLabelText("Amount 1 (₪)")).toHaveValue("125.50");
    fireEvent.change(screen.getByLabelText("Amount 1 (₪)"), { target: { value: "100.00" } });
    fireEvent.change(screen.getByLabelText("Category 2"), { target: { value: "household" } });
    fireEvent.change(screen.getByLabelText("Amount 2 (₪)"), { target: { value: "25.49" } });
    expect(screen.getByText("₪0.01 left to assign.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save split" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Amount 2 (₪)"), { target: { value: "25.51" } });
    expect(screen.getByText("₪0.01 more than the transaction.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save split" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Amount 2 (₪)"), { target: { value: "25.50" } });
    expect(screen.getByText("Adds up exactly.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save split" })).toBeEnabled();
  });

  it("puts what is left on a line, and sends the parts as typed", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Amount 1 (₪)"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Category 2"), { target: { value: "household" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Rest here" })[1]);
    expect(screen.getByLabelText("Amount 2 (₪)")).toHaveValue("25.50");

    fireEvent.click(screen.getByRole("button", { name: "Save split" }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/transactions/tx-1/splits");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      splits: [
        { categoryId: "groceries", amount: "100" },
        { categoryId: "household", amount: "25.50" },
      ],
    });
  });

  it("won't save the same category twice", () => {
    open();
    fireEvent.change(screen.getByLabelText("Amount 1 (₪)"), { target: { value: "100.00" } });
    fireEvent.change(screen.getByLabelText("Category 2"), { target: { value: "groceries" } });
    fireEvent.change(screen.getByLabelText("Amount 2 (₪)"), { target: { value: "25.50" } });
    expect(screen.getByText(/Each category can appear only once/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save split" })).toBeDisabled();
  });

  it("shows the server's message and stays open when the split is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "The parts add up to ₪125.49." }) })));
    open();
    fireEvent.change(screen.getByLabelText("Amount 1 (₪)"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Category 2"), { target: { value: "household" } });
    fireEvent.change(screen.getByLabelText("Amount 2 (₪)"), { target: { value: "25.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save split" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The parts add up to ₪125.49.");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("opens an existing split in the transaction's own currency and can remove it", async () => {
    open({
      currency: "TRY",
      nativeTotal: -10_000,
      triggerLabel: "Edit split",
      splits: [
        { categoryId: "groceries", categoryName: "Groceries", amountAgorot: -415, nativeAmount: -6_667 },
        { categoryId: "household", categoryName: "Household", amountAgorot: -208, nativeAmount: -3_333 },
      ],
    });
    expect(screen.getByLabelText("Amount 1 (₺)")).toHaveValue("66.67");
    expect(screen.getByText("Adds up exactly.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove split" }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(JSON.parse(String((vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ splits: [] });
  });
});
