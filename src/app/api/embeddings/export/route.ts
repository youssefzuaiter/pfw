import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { jsonServerError, jsonTooManyRequests } from "../../../../server/api/responses";
import { listSearchEmbeddingsForExport } from "../../../../server/dal/transactions";

/**
 * A GET, read-only export of the current user's own search-embedding
 * vectors — the server-side half of the Local RAG retrieval pipeline
 * (client-side plan doc: browser caches these in IndexedDB, runs KNN
 * entirely client-side, sends only matching transaction ids to the
 * copilot route). No state changes, so this deliberately skips
 * `guardMutation`'s Origin/CSRF check — same pattern as
 * `GET /api/tax/simulate` / `GET /api/analytics/monte-carlo` — but keeps
 * identity resolution and rate limiting by calling those primitives
 * directly.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 20 };

export async function GET() {
  const user = await getCurrentUser();

  const rate = checkRateLimit(`embeddings:export:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  try {
    const transactions = await listSearchEmbeddingsForExport(user.id);
    return NextResponse.json({ transactions, count: transactions.length });
  } catch (error) {
    console.error("GET /api/embeddings/export failed", error);
    return jsonServerError();
  }
}
