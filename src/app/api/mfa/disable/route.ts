import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { verifyCredentials } from "../../../../server/auth/credentials";
import { disableTotp } from "../../../../server/dal/mfa";

/**
 * Requires the CURRENT password to disable MFA — a real, already-
 * authenticated session (e.g. a stolen but still-live cookie) shouldn't
 * be able to strip a second factor with no further proof, the same
 * re-confirmation instinct a real password-change flow would apply if
 * this app had one. `disableTotp` itself also bumps tokenVersion,
 * invalidating every OTHER outstanding session — see its own doc
 * comment.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };

const BodySchema = z.object({ password: z.string().min(1) });

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "mfa:disable", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Invalid JSON body");
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Password is required", parsed.error.issues);
  }

  try {
    const verified = await verifyCredentials(user.email, parsed.data.password);
    if (!verified) {
      return NextResponse.json({ error: "Incorrect password" }, { status: 400 });
    }

    await disableTotp(user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/mfa/disable failed", error);
    return jsonServerError();
  }
}
