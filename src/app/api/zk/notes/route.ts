import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { jsonServerError, jsonTooManyRequests } from "../../../../server/api/responses";
import { listZkNoteCiphertexts } from "../../../../server/dal/zk-vault";

/**
 * A GET, read-only endpoint returning every currently-"zk1:"-formatted
 * `GoalContribution.note` ciphertext blob — the read half of Passphrase
 * Rotation (AGENTS.md §3m amendment), symmetric with
 * `/api/zk/migrate-legacy`'s existing read-then-client-reencrypt shape.
 * Deliberately skips `guardMutation`'s Origin/CSRF check, same reasoning
 * as `/api/analytics/monte-carlo` — no state changes, so that check
 * doesn't apply, but identity resolution and rate limiting are kept by
 * calling those primitives directly.
 *
 * Returns opaque ciphertext only — nothing here is server-decryptable,
 * so unlike `/api/zk/migrate-legacy` this route needs no "never log the
 * body" discipline of its own; there is no plaintext in this response.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

export async function GET() {
  const user = await getCurrentUser();

  const rate = checkRateLimit(`zk:notes:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  try {
    const notes = await listZkNoteCiphertexts(user.id);
    return NextResponse.json({ ok: true, notes });
  } catch (error) {
    console.error("GET /api/zk/notes failed", error);
    return jsonServerError();
  }
}
