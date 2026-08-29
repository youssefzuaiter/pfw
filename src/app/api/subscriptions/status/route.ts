import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { setSubscriptionStatus } from "../../../../server/dal/subscriptions";

const BodySchema = z.object({
  merchantKey: z.string().trim().min(1).max(200),
  status: z.enum(["ACTIVE", "REVIEWED", "CANCELLED"]),
});

/**
 * The subscription radar's one-click cancel/review toggle (AGENTS.md
 * §3p). `merchantKey` is taken in the body, not a URL path segment —
 * it's the radar's canonical fuzzy-cluster key, which can contain
 * spaces and punctuation that would need awkward URL-encoding as a path
 * param for no real benefit here.
 */
export async function PATCH(request: NextRequest) {
  const guard = await guardMutation(request, "subscriptions:status");
  if ("response" in guard) return guard.response;
  const { user } = guard;

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
    const updated = await setSubscriptionStatus(user.id, parsed.data);

    await recordAuditLog(user.id, {
      entityType: "SubscriptionTracking",
      entityId: updated.id,
      action: "UPDATE",
      afterData: { merchantKey: parsed.data.merchantKey, status: parsed.data.status },
    });

    return NextResponse.json({ ok: true, status: updated.status });
  } catch (error) {
    console.error("PATCH /api/subscriptions/status failed", error);
    return jsonServerError();
  }
}
