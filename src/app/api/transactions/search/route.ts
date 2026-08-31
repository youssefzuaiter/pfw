import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { EmbeddingSchema } from "../../../../server/api/embedding-validation";
import { jsonBadRequest, jsonServerError, jsonTooManyRequests } from "../../../../server/api/responses";
import { listTransactions, searchTransactionsSemantic } from "../../../../server/dal/transactions";

/**
 * Read-only compute endpoint (AGENTS.md §3cc) — same "GET-shaped, skips
 * guardMutation's Origin/CSRF check, keeps identity+rate-limit directly"
 * posture as GET /api/analytics/monte-carlo (§3n) and GET /api/tax/simulate
 * (§3r), just a POST here specifically because a 384-float query
 * embedding doesn't fit cleanly into a query string. Nothing this route
 * touches ever mutates a row.
 *
 * `embedding` is OPTIONAL, not required, even though this route's whole
 * point is semantic search — a client that couldn't compute one in time
 * (an unsupported browser, a cold Worker/model download racing past
 * `embedTextWithTimeout`'s 3s budget, §3u) still gets a real answer via
 * `listTransactions`'s existing substring match, rather than an error.
 * This is the one place the two search implementations meet: the UI
 * (`src/app/transactions/_components/semantic-search.tsx`) always calls
 * THIS endpoint, never `listTransactions` directly, so it never has to
 * know which path actually served a given response.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

const BodySchema = z.object({
  query: z.string().min(1).max(200),
  embedding: EmbeddingSchema,
  categoryId: z.string().min(1).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

type SearchRow = {
  id: string;
  occurredAt: Date;
  description: string;
  merchantName: string | null;
  amount: bigint;
  categoryId: string;
  category: { name: string };
  needsReview: boolean;
};

function serializeRow(row: SearchRow) {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    description: row.description,
    merchantName: row.merchantName,
    // BigInt never crosses a JSON boundary raw — NextResponse.json()
    // throws on one (AGENTS.md §3d's documented bug class). This is
    // always a safe-integer agorot figure in practice, same assumption
    // every other serialized money field in this app already makes.
    amount: Number(row.amount),
    categoryId: row.categoryId,
    categoryName: row.category.name,
    needsReview: row.needsReview,
  };
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();

  const rate = checkRateLimit(`transactions:semantic-search:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonBadRequest("Invalid JSON body");
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonBadRequest("Invalid search request", parsed.error.issues);
  }

  const { query, embedding, categoryId, dateFrom, dateTo, limit } = parsed.data;

  try {
    const rows: SearchRow[] = embedding
      ? await searchTransactionsSemantic(user.id, embedding, { categoryId, dateFrom, dateTo, limit })
      : await listTransactions(user.id, { search: query, categoryId, dateFrom, dateTo, sort: "date_desc" });

    return NextResponse.json({ mode: embedding ? "semantic" : "substring", results: rows.map(serializeRow) });
  } catch (error) {
    console.error("POST /api/transactions/search failed", error);
    return jsonServerError();
  }
}
