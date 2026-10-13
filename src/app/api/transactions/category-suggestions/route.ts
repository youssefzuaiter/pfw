import Anthropic from "@anthropic-ai/sdk";
import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonServerError } from "../../../../server/api/responses";
import { listUncategorizedForSuggestions } from "../../../../server/dal/category-suggestions";
import { getAnthropicApiKey } from "../../../../server/env";
import {
  MAX_ROWS_PER_REQUEST,
  suggestCategories,
  type SuggestionRow,
} from "../../../../server/categorization/claude-category-suggester";
import { formatNativeAmount, nativeAmount } from "../../../../lib/currency";

/**
 * Suggests a category for each uncategorized transaction, using Claude
 * (AGENTS.md §3kkk). Writes nothing: the user reviews the list and applies
 * what they accept through POST /api/transactions/category-suggestions/apply.
 *
 * A POST behind the full mutation guard even though it changes no data:
 * every call spends money on the Anthropic API and sends transaction text
 * off-site, so it gets the Origin check and a tight rate limit (5 per 10
 * minutes per user), not the read-only routes' looser treatment.
 *
 * 503 when ANTHROPIC_API_KEY is not set, so the panel can say why instead
 * of failing generically; 502 when Claude declines or answers unparseably.
 */
const RATE_LIMIT = { windowMs: 10 * 60_000, maxRequests: 5 };

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "transactions:category-suggestions", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let apiKey: string;
  try {
    apiKey = getAnthropicApiKey();
  } catch {
    return NextResponse.json(
      { error: "AI suggestions are not set up on this deployment (ANTHROPIC_API_KEY is missing)." },
      { status: 503 },
    );
  }

  try {
    const data = await listUncategorizedForSuggestions(user.id, MAX_ROWS_PER_REQUEST);
    const categories = data.categories.map((category) => ({ id: category.id, name: category.name }));
    if (data.rows.length === 0 || data.categories.length === 0) {
      return NextResponse.json({ total: data.total, considered: 0, suggestions: [], categories });
    }

    const rows = data.rows.map((row, index) => ({
      transactionId: row.id,
      input: {
        ref: `t${index}`,
        merchant: row.merchantName,
        description: row.description,
        amount: formatNativeAmount(nativeAmount(Number(row.nativeAmount)), row.currency),
        date: row.occurredAt.toISOString().slice(0, 10),
      } satisfies SuggestionRow,
    }));

    const result = await suggestCategories(
      new Anthropic({ apiKey }),
      rows.map((row) => row.input),
      data.categories.map(({ slug, name }) => ({ slug, name })),
    );
    if (!result.ok) {
      const message =
        result.error === "refused" ? "Claude declined this request." : "Claude's answer could not be read. Try again.";
      return NextResponse.json({ error: message }, { status: 502 });
    }

    const categoryBySlug = new Map(data.categories.map((category) => [category.slug, category]));
    const suggestions = rows.flatMap(({ transactionId, input }) => {
      const slug = result.suggestions.get(input.ref);
      const category = slug ? categoryBySlug.get(slug) : undefined;
      if (!category) return [];
      return [
        {
          transactionId,
          occurredAt: input.date,
          label: input.merchant ?? input.description,
          amount: input.amount,
          categoryId: category.id,
          categoryName: category.name,
        },
      ];
    });

    return NextResponse.json({ total: data.total, considered: rows.length, suggestions, categories });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(`POST /api/transactions/category-suggestions: Anthropic API error ${error.status}`);
      return NextResponse.json({ error: "Claude could not be reached. Try again later." }, { status: 502 });
    }
    console.error("POST /api/transactions/category-suggestions failed", error);
    return jsonServerError();
  }
}
