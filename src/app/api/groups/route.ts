import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { createSharedGroup } from "../../../server/dal/shared-groups";

const BodySchema = z.object({
  name: z.string().trim().min(1).max(100),
});

/** Creates a new Household Space and adds the caller as its OWNER — see `createSharedGroup`'s doc comment. */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "groups:create");
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
    const group = await createSharedGroup(user.id, parsed.data.name);

    await recordAuditLog(user.id, {
      entityType: "SharedGroup",
      entityId: group.id,
      action: "CREATE",
      afterData: { name: group.name },
    });

    return NextResponse.json({ ok: true, group: { id: group.id, name: group.name } }, { status: 201 });
  } catch (error) {
    console.error("POST /api/groups failed", error);
    return jsonServerError();
  }
}
