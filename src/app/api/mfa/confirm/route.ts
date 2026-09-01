import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { confirmTotpSetup } from "../../../../server/dal/mfa";

const RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };

const BodySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "code must be a 6-digit authenticator code"),
});

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "mfa:confirm", RATE_LIMIT);
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
    return jsonBadRequest("Invalid confirmation request", parsed.error.issues);
  }

  try {
    const result = await confirmTotpSetup(user.id, parsed.data.code);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/mfa/confirm failed", error);
    return jsonServerError();
  }
}
