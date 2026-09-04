import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../../../server/api/guard-mutation";
import { jsonNotFound, jsonServerError } from "../../../../../../server/api/responses";
import { syncBankConnection } from "../../../../../../server/banking/sync-service";

/**
 * User-triggered "Sync now" — an authenticated action, not a public
 * webhook. A real PSD2 aggregator would push data via a webhook this
 * app's deployment could never actually receive (no real consent flow,
 * no real caller); a user-triggered, `guardMutation`-fronted sync avoids
 * inventing an unauthenticated surface nothing legitimate would ever
 * call, and is the version this feature's own live verification can
 * actually exercise end to end.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "banking:connections:sync", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

  try {
    const result = await syncBankConnection(user.id, id);
    if (!result.ok) {
      if (result.error === "connection_not_found") return jsonNotFound();
      return NextResponse.json({ error: result.error, message: result.message }, { status: 502 });
    }
    return NextResponse.json({ ok: true, importedCount: result.importedCount, duplicateCount: result.duplicateCount });
  } catch (error) {
    console.error("POST /api/banking/connections/[id]/sync failed", error);
    return jsonServerError();
  }
}
