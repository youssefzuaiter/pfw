import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonForbidden, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { setResourceSharing } from "../../../../server/dal/shared-groups";

const ENTITY_TYPE_BY_RESOURCE_TYPE: Record<"budget" | "bankAccount" | "category", string> = {
  budget: "Budget",
  bankAccount: "BankAccount",
  category: "Category",
};

const BodySchema = z.object({
  resourceType: z.enum(["budget", "bankAccount", "category"]),
  resourceId: z.string().min(1),
  // `null` un-shares the resource; a group id shares (or re-shares) it.
  sharedGroupId: z.string().min(1).nullable(),
});

/**
 * Sets or clears a Budget/BankAccount/Category's `sharedGroupId` — the
 * one route that can make a personal resource visible to a household, or
 * take it back. One shared route for all three resource types rather
 * than three near-identical ones (they'd differ only in which DAL table
 * gets touched, already factored into `setResourceSharing`).
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "groups:share");
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
    const result = await setResourceSharing(
      user.id,
      parsed.data.resourceType,
      parsed.data.resourceId,
      parsed.data.sharedGroupId,
    );

    if (!result.ok) {
      if (result.error === "resource_not_found") return jsonNotFound();
      // "not_group_member": the caller can see their own resource fine,
      // they just aren't in the household they're trying to share it
      // into — a request-level policy violation on an otherwise-visible
      // resource, so 403 is correct here (contrast the IDOR case above),
      // same reasoning `responses.ts`'s `jsonForbidden` doc comment gives.
      return jsonForbidden("You're not a member of that household");
    }

    await recordAuditLog(user.id, {
      entityType: ENTITY_TYPE_BY_RESOURCE_TYPE[parsed.data.resourceType],
      entityId: parsed.data.resourceId,
      action: "UPDATE",
      afterData: { sharedGroupId: parsed.data.sharedGroupId },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/groups/share failed", error);
    return jsonServerError();
  }
}
