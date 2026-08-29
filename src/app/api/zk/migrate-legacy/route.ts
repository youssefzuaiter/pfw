import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { getZkVaultStatus, findLegacyNoteContributions } from "../../../../server/dal/zk-vault";

/**
 * Returns every `GoalContribution.note` still in the OLD server-side
 * "v1:..." format, decrypted, so the client can immediately re-encrypt
 * each one under the new zero-knowledge key and PATCH it back via
 * `/api/goals/contributions/[id]` (AGENTS.md §3m).
 *
 * SECURITY: this is the one route in the whole app that deliberately
 * returns decrypted free-text note content in a response body — see
 * `findLegacyNoteContributions`'s doc comment for why that's an
 * unavoidable, one-time consequence of migrating pre-existing
 * server-encrypted data into a scheme the server can never decrypt
 * again, not an oversight. The `console.error` below logs the error
 * object only, never `error`'s message-adjacent request/response data —
 * a decrypted note must never reach a log line, a Sentry breadcrumb, or
 * anywhere else this response body doesn't already go.
 *
 * Requires the vault to already be set up: migrating notes into a key
 * that doesn't exist yet wouldn't make sense, and gating on it here
 * (rather than trusting the client to call these two routes in order)
 * keeps this route safe to call on its own.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "zk:migrate-legacy");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  try {
    const status = await getZkVaultStatus(user.id);
    if (!status.isSetUp) {
      return jsonBadRequest("Set up the zero-knowledge vault before migrating legacy notes");
    }

    const legacyNotes = await findLegacyNoteContributions(user.id);
    return NextResponse.json({ ok: true, notes: legacyNotes });
  } catch (error) {
    console.error("POST /api/zk/migrate-legacy failed", error);
    return jsonServerError();
  }
}
