import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const { CategorySuggestionsPanel, proposeRules } = await import("./category-suggestions-panel");

const SUGGESTIONS = {
  total: 3,
  considered: 3,
  categories: [
    { id: "cat-dining", name: "Dining" },
    { id: "cat-groceries", name: "Groceries" },
  ],
  suggestions: [
    { transactionId: "tx-1", occurredAt: "2026-10-02", label: "MIGROS", amount: "-₺94.25", categoryId: "cat-groceries", categoryName: "Groceries", rule: null },
    { transactionId: "tx-2", occurredAt: "2026-10-01", label: "STARBUCKS", amount: "-₺120.00", categoryId: "cat-dining", categoryName: "Dining", rule: null },
  ],
};

const migrosRule = { field: "description" as const, keyword: "MİGROS" };
const WITH_RULES = {
  total: 3,
  considered: 3,
  categories: SUGGESTIONS.categories,
  suggestions: [
    { transactionId: "tx-1", occurredAt: "2026-10-03", label: "Pos satış MİGROS 4512", amount: "-₺94.25", categoryId: "cat-groceries", categoryName: "Groceries", rule: migrosRule },
    { transactionId: "tx-2", occurredAt: "2026-10-02", label: "STARBUCKS", amount: "-₺120.00", categoryId: "cat-dining", categoryName: "Dining", rule: { field: "merchantName" as const, keyword: "STARBUCKS" } },
    { transactionId: "tx-3", occurredAt: "2026-10-01", label: "Pos satış MİGROS 0007", amount: "-₺31.10", categoryId: "cat-groceries", categoryName: "Groceries", rule: migrosRule },
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
    expect(JSON.parse(init.body)).toEqual({ choices: [{ transactionId: "tx-1", categoryId: "cat-dining" }], rules: [] });
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

  it("offers a merchant seen twice as a ticked rule and one seen once unticked, and sends only the ticked ones (AGENTS.md §3ooo)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(WITH_RULES))
      .mockResolvedValueOnce(respond({ ok: true, updated: 3, skipped: 0, rulesCreated: 1, rulesSkipped: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<CategorySuggestionsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Get suggestions" }));
    const rules = within(await screen.findByRole("group", { name: "Also save as rules" }));
    const migros = rules.getByRole("checkbox", { name: /Description contains “MİGROS” → Groceries \(2 here\)/ });
    const starbucks = rules.getByRole("checkbox", { name: /Merchant contains “STARBUCKS” → Dining \(1 here\)/ });
    expect((migros as HTMLInputElement).checked).toBe(true);
    expect((starbucks as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Apply 3 categories and 1 rule" }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).rules).toEqual([
      { field: "description", keyword: "MİGROS", categoryId: "cat-groceries" },
    ]);
    expect(await screen.findByText("Categorized 3 transactions and saved 1 rule for future imports.")).toBeTruthy();
  });

  it("withdraws a rule once the user sends that merchant's rows to different categories", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(respond(WITH_RULES)));
    render(<CategorySuggestionsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Get suggestions" }));
    const rules = within(await screen.findByRole("group", { name: "Also save as rules" }));
    expect(rules.getByRole("checkbox", { name: /MİGROS/ })).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Category for Pos satış MİGROS 0007" }), { target: { value: "cat-dining" } });
    expect(rules.queryByRole("checkbox", { name: /MİGROS/ })).toBeNull();
    expect(rules.getByRole("checkbox", { name: /STARBUCKS/ })).toBeTruthy();
  });
});

describe("proposeRules", () => {
  it("counts only ticked rows and groups a word regardless of case", () => {
    const suggestions = [
      { ...WITH_RULES.suggestions[0], rule: { field: "description" as const, keyword: "Migros" } },
      { ...WITH_RULES.suggestions[2], rule: { field: "description" as const, keyword: "MIGROS" } },
      WITH_RULES.suggestions[1],
    ];
    const choices = new Map([
      ["tx-1", { checked: true, categoryId: "cat-groceries" }],
      ["tx-3", { checked: true, categoryId: "cat-groceries" }],
      ["tx-2", { checked: false, categoryId: "cat-dining" }],
    ]);
    expect(proposeRules(suggestions, choices)).toEqual([
      { field: "description", keyword: "Migros", key: "description|migros", categoryId: "cat-groceries", rowCount: 2 },
    ]);
  });
});
