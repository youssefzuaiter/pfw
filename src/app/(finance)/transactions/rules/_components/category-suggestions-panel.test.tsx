import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const { CategorySuggestionsPanel } = await import("./category-suggestions-panel");

const SUGGESTIONS = {
  total: 3,
  considered: 3,
  categories: [
    { id: "cat-dining", name: "Dining" },
    { id: "cat-groceries", name: "Groceries" },
  ],
  suggestions: [
    { transactionId: "tx-1", occurredAt: "2026-10-02", label: "MIGROS", amount: "-₺94.25", categoryId: "cat-groceries", categoryName: "Groceries" },
    { transactionId: "tx-2", occurredAt: "2026-10-01", label: "STARBUCKS", amount: "-₺120.00", categoryId: "cat-dining", categoryName: "Dining" },
  ],
};

function respond(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

describe("CategorySuggestionsPanel", () => {
  beforeEach(() => {
    refreshMock.mockReset();
  });

  it("says what is sent to Anthropic before anything is sent", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<CategorySuggestionsPanel />);
    expect(screen.getByText(/to Anthropic.s Claude\. Nothing changes until you apply/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies only the ticked rows, with any category the user changed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(SUGGESTIONS))
      .mockResolvedValueOnce(respond({ ok: true, updated: 1, skipped: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<CategorySuggestionsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Get suggestions" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("MIGROS")).toBeTruthy();
    expect(screen.getByText("1 with no confident match")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Apply a category to STARBUCKS" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Category for MIGROS" }), { target: { value: "cat-dining" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 category" }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/transactions/category-suggestions/apply");
    expect(JSON.parse(init.body)).toEqual({ choices: [{ transactionId: "tx-1", categoryId: "cat-dining" }] });
    expect(await screen.findByText("Categorized 1 transaction.")).toBeTruthy();
  });

  it("shows the server's reason when suggestions are not set up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(respond({ error: "AI suggestions are not set up on this deployment (ANTHROPIC_API_KEY is missing)." }, false)),
    );
    render(<CategorySuggestionsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Get suggestions" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/ANTHROPIC_API_KEY is missing/);
  });

  it("says so when nothing is uncategorized", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ total: 0, considered: 0, suggestions: [], categories: [] })));
    render(<CategorySuggestionsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Get suggestions" }));
    expect(await screen.findByText("Nothing is uncategorized.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
  });
});
