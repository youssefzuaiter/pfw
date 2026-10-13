import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The suggestions route's wiring: it never reaches Claude without a key or
 * without rows, it maps Claude's slugs back to the user's own category ids,
 * and every failure mode is a clear status rather than a crash. The data
 * read, the suggester and the guard are mocked; each has its own tests.
 */
vi.mock("../../../../server/api/guard-mutation", () => ({ guardMutation: vi.fn() }));
vi.mock("../../../../server/env", () => ({ getAnthropicApiKey: vi.fn() }));
vi.mock("../../../../server/dal/category-suggestions", () => ({ listUncategorizedForSuggestions: vi.fn() }));
vi.mock("../../../../server/categorization/claude-category-suggester", () => ({
  MAX_ROWS_PER_REQUEST: 200,
  suggestCategories: vi.fn(),
}));

import { POST } from "./route";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { getAnthropicApiKey } from "../../../../server/env";
import { listUncategorizedForSuggestions } from "../../../../server/dal/category-suggestions";
import { suggestCategories } from "../../../../server/categorization/claude-category-suggester";

const CATEGORIES = [
  { id: "cat-groceries", slug: "groceries", name: "Groceries" },
  { id: "cat-dining", slug: "dining", name: "Dining" },
];

const ROWS = [
  { id: "tx-1", occurredAt: new Date("2026-10-02T09:00:00Z"), merchantName: "MIGROS", description: "Pos satış", nativeAmount: -9_425n, currency: "TRY" },
  { id: "tx-2", occurredAt: new Date("2026-10-01T09:00:00Z"), merchantName: null, description: "Havale", nativeAmount: -50_000n, currency: "TRY" },
];

function request(): NextRequest {
  return new NextRequest("http://localhost:3000/api/transactions/category-suggestions", { method: "POST" });
}

describe("POST /api/transactions/category-suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(guardMutation).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getAnthropicApiKey).mockReturnValue("test-key-not-real");
    vi.mocked(listUncategorizedForSuggestions).mockResolvedValue({ total: 2, rows: ROWS, categories: CATEGORIES } as never);
  });

  it("returns the guard's response untouched (a forged origin, a rate limit)", async () => {
    const refused = new Response(null, { status: 403 });
    vi.mocked(guardMutation).mockResolvedValue({ response: refused } as never);
    expect(await POST(request())).toBe(refused);
    expect(suggestCategories).not.toHaveBeenCalled();
  });

  it("answers 503 without calling Claude when no API key is configured", async () => {
    vi.mocked(getAnthropicApiKey).mockImplementation(() => {
      throw new Error("Missing required server-only environment variable: ANTHROPIC_API_KEY");
    });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/ANTHROPIC_API_KEY/);
    expect(listUncategorizedForSuggestions).not.toHaveBeenCalled();
  });

  it("does not call Claude when nothing is uncategorized", async () => {
    vi.mocked(listUncategorizedForSuggestions).mockResolvedValue({ total: 0, rows: [], categories: CATEGORIES } as never);
    const response = await POST(request());
    expect(await response.json()).toEqual({
      total: 0,
      considered: 0,
      suggestions: [],
      categories: [
        { id: "cat-groceries", name: "Groceries" },
        { id: "cat-dining", name: "Dining" },
      ],
    });
    expect(suggestCategories).not.toHaveBeenCalled();
  });

  it("sends opaque refs and formatted amounts, and maps the answer back to the user's category ids", async () => {
    vi.mocked(suggestCategories).mockResolvedValue({ ok: true, suggestions: new Map([["t0", "groceries"]]) });

    const response = await POST(request());
    expect(response.status).toBe(200);
    const body = await response.json();

    const [, sentRows, sentCategories] = vi.mocked(suggestCategories).mock.calls[0];
    expect(sentRows).toEqual([
      { ref: "t0", merchant: "MIGROS", description: "Pos satış", amount: "-₺94.25", date: "2026-10-02" },
      { ref: "t1", merchant: null, description: "Havale", amount: "-₺500.00", date: "2026-10-01" },
    ]);
    expect(sentCategories).toEqual([
      { slug: "groceries", name: "Groceries" },
      { slug: "dining", name: "Dining" },
    ]);
    expect(body.considered).toBe(2);
    expect(body.suggestions).toEqual([
      {
        transactionId: "tx-1",
        occurredAt: "2026-10-02",
        label: "MIGROS",
        amount: "-₺94.25",
        categoryId: "cat-groceries",
        categoryName: "Groceries",
      },
    ]);
  });

  it("answers 502 when Claude declines or cannot be read", async () => {
    vi.mocked(suggestCategories).mockResolvedValue({ ok: false, error: "refused" });
    expect((await POST(request())).status).toBe(502);

    vi.mocked(suggestCategories).mockResolvedValue({ ok: false, error: "unparseable" });
    expect((await POST(request())).status).toBe(502);
  });

  it("answers 502, not 500, when the Anthropic API itself fails", async () => {
    vi.mocked(suggestCategories).mockRejectedValue(new Anthropic.APIError(529, undefined, "overloaded", new Headers()));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/could not be reached/);
  });
});
