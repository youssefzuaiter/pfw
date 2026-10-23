import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const { BulkActionBar, MAX_BULK_SELECTION } = await import("./bulk-action-bar");

const CATEGORIES = [
  { id: "c-groc", name: "Groceries" },
  { id: "c-dine", name: "Dining" },
];

type Call = { url: string; body: { ids: string[]; action: Record<string, unknown> } };

function installFetch(responses: Array<{ status?: number; body: Record<string, unknown> }>) {
  const calls: Call[] = [];
  let index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      const next = responses[Math.min(index++, responses.length - 1)];
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
    }),
  );
  return calls;
}

const OK = { ok: true, changed: 2, changedIds: ["t1", "t2"], skippedSplit: 0, unchanged: 0, notFound: 0 };

describe("BulkActionBar", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("shows nothing to act on until something is selected", () => {
    render(<BulkActionBar selectedIds={[]} categories={CATEGORIES} onClear={() => {}} />);
    expect(screen.queryByRole("region", { name: /selected transactions/i })).toBeNull();
  });

  it("sets one category on every selected row, then clears the selection and refreshes", async () => {
    const calls = installFetch([{ body: OK }]);
    const onClear = vi.fn();
    render(<BulkActionBar selectedIds={["t1", "t2"]} categories={CATEGORIES} onClear={onClear} />);
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set category" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/category for the selected/i), { target: { value: "c-dine" } });
    fireEvent.click(screen.getByRole("button", { name: "Set category" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: "/api/transactions/bulk", body: { ids: ["t1", "t2"], action: { type: "category", categoryId: "c-dine" } } });
    await waitFor(() => expect(onClear).toHaveBeenCalled());
    expect(refreshMock).toHaveBeenCalled();
    expect(await screen.findByText("Changed the category of 2 transactions.")).toBeInTheDocument();
  });

  it("marks and unmarks transfers", async () => {
    const calls = installFetch([{ body: OK }, { body: OK }]);
    render(<BulkActionBar selectedIds={["t1", "t2"]} categories={CATEGORIES} onClear={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark as transfer" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body.action).toEqual({ type: "transfer", isTransfer: true });
    fireEvent.click(screen.getByRole("button", { name: "Not a transfer" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body.action).toEqual({ type: "transfer", isTransfer: false });
  });

  it("asks before deleting, and Undo restores exactly the rows that were deleted", async () => {
    const calls = installFetch([{ body: { ...OK, changedIds: ["t2"], changed: 1, notFound: 1 } }, { body: { ...OK, changedIds: ["t2"], changed: 1 } }]);
    render(<BulkActionBar selectedIds={["t1", "t2"]} categories={CATEGORIES} onClear={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(calls).toHaveLength(0);
    expect(screen.getByText("Delete 2 transactions?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByText("Delete 2 transactions?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body.action).toEqual({ type: "delete" });
    expect(await screen.findByText("Deleted 1 transaction. 1 not found.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    // Only the row actually deleted, not the one that was not found.
    expect(calls[1].body).toEqual({ ids: ["t2"], action: { type: "restore" } });
    expect(await screen.findByText("Restored 1 transaction.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("says what it skipped", async () => {
    installFetch([{ body: { ...OK, changed: 3, changedIds: ["a", "b", "c"], skippedSplit: 2, unchanged: 1 } }]);
    render(<BulkActionBar selectedIds={["a", "b", "c", "d", "e", "f"]} categories={CATEGORIES} onClear={() => {}} />);
    fireEvent.change(screen.getByLabelText(/category for the selected/i), { target: { value: "c-groc" } });
    fireEvent.click(screen.getByRole("button", { name: "Set category" }));
    // The spinner is also a status element while it works, so wait for the message itself.
    expect(
      await screen.findByText("Changed the category of 3 transactions. 1 already was that way. 2 split transactions skipped: edit those in the split editor."),
    ).toBeInTheDocument();
  });

  it("shows the server's message and keeps the selection when a request fails", async () => {
    installFetch([{ status: 400, body: { error: "That category does not exist." } }]);
    const onClear = vi.fn();
    render(<BulkActionBar selectedIds={["t1"]} categories={CATEGORIES} onClear={onClear} />);
    fireEvent.change(screen.getByLabelText(/category for the selected/i), { target: { value: "c-groc" } });
    fireEvent.click(screen.getByRole("button", { name: "Set category" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That category does not exist.");
    expect(onClear).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("refuses a selection over the limit without asking the server", () => {
    const calls = installFetch([{ body: OK }]);
    const ids = Array.from({ length: MAX_BULK_SELECTION + 1 }, (_, i) => `t${i}`);
    render(<BulkActionBar selectedIds={ids} categories={CATEGORIES} onClear={() => {}} />);
    expect(screen.getByText(`Select at most ${MAX_BULK_SELECTION} at a time.`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark as transfer" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(calls).toHaveLength(0);
  });
});
