import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "../../../../../server/api/rate-limit";
import { jsonBadRequest, jsonForbidden, jsonNotFound, jsonServerError, jsonTooManyRequests } from "../../../../../server/api/responses";
import { EncodedShareSchema } from "../../../../../server/api/dead-mans-switch-validation";
import { isTrustedOrigin } from "../../../../../server/api/verify-origin";
import { getRecoveryPortalStatus, submitRecoveryShare } from "../../../../../server/dead-mans-switch/recovery-service";

/**
 * The public beneficiary recovery portal's API (AGENTS.md §3t) — the
 * ONE surface in this app reachable by someone who is NOT the
 * authenticated seeded demo user, since a beneficiary holding an invite
 * token is by design a different real-world person. There is
 * deliberately no `guardMutation()` here (it resolves `getCurrentUser()`,
 * which would be the wrong identity entirely for this flow) — Origin
 * verification is still applied by hand (CSRF defense-in-depth still
 * applies to the state-changing POST), and rate limiting is keyed by the
 * token itself rather than a user id, since there is no user id here.
 *
 * `token` never appears in a log line or error response beyond what the
 * URL itself already reveals to whoever holds this specific link.
 */

const RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const limit = checkRateLimit(`dead-mans-switch:recover:status:${token}`, RATE_LIMIT);
  if (!limit.allowed) return jsonTooManyRequests(limit.resetAt);

  try {
    const status = await getRecoveryPortalStatus(token);
    if (!status.found) return jsonNotFound();

    return NextResponse.json(status);
  } catch (error) {
    console.error("GET /api/dead-mans-switch/recover/[token] failed", error);
    return jsonServerError();
  }
}

const BodySchema = z.object({ share: EncodedShareSchema });

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  if (!isTrustedOrigin(request)) return jsonForbidden("Origin mismatch");

  const { token } = await params;

  const limit = checkRateLimit(`dead-mans-switch:recover:submit:${token}`, RATE_LIMIT);
  if (!limit.allowed) return jsonTooManyRequests(limit.resetAt);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }

  try {
    const result = await submitRecoveryShare(token, parsed.data.share);

    if (result.status === "invalid_token") return jsonNotFound();

    if (result.status === "not_triggered" || result.status === "already_recovered") {
      return jsonBadRequest("This vault is not currently open for recovery", { switchStatus: result.status === "already_recovered" ? "RECOVERED" : result.switchStatus });
    }

    if (result.status === "invalid_share_format") {
      return jsonBadRequest("Malformed share value");
    }

    if (result.status === "share_hash_mismatch") {
      return jsonBadRequest("This share does not match the expected value for your invite");
    }

    if (result.status === "key_verification_failed") {
      // See recovery-service.ts's doc comment: should not happen given
      // every stored share already passed its own hash check, so this
      // is treated as an unexpected server error rather than a normal
      // client-facing rejection.
      console.error("POST /api/dead-mans-switch/recover/[token]: key verification failed after threshold reached");
      return jsonServerError();
    }

    if (result.status === "accepted_pending") {
      return NextResponse.json({ status: "accepted_pending", submittedCount: result.submittedCount, thresholdShares: result.thresholdShares });
    }

    // result.status === "recovered"
    return NextResponse.json({ status: "recovered", documents: result.documents });
  } catch (error) {
    console.error("POST /api/dead-mans-switch/recover/[token] failed", error);
    return jsonServerError();
  }
}
