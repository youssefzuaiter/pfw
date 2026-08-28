import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { archiveCategory, deleteCategoryWithReassignment, renameCategory, unarchiveCategory } from "../../../../server/dal/categories";

const PatchBodySchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  archived: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "categories:patch");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = PatchBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }
  if (parsed.data.name === undefined && parsed.data.archived === undefined) {
    return jsonBadRequest("Provide at least one of: name, archived");
  }

  try {
    let updated = null;

    if (parsed.data.name !== undefined) {
      updated = await renameCategory(user.id, id, parsed.data.name);
      if (!updated) return jsonNotFound();
    }

    if (parsed.data.archived !== undefined) {
      updated = parsed.data.archived ? await archiveCategory(user.id, id) : await unarchiveCategory(user.id, id);
      if (!updated) return jsonNotFound();
    }

    await recordAuditLog(user.id, {
      entityType: "Category",
      entityId: id,
      action: "UPDATE",
      afterData: parsed.data,
    });

    return NextResponse.json({ ok: true, category: updated });
  } catch (error) {
    console.error("PATCH /api/categories/[id] failed", error);
    return jsonServerError();
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "categories:delete");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

  try {
    const result = await deleteCategoryWithReassignment(user.id, id);
    if (!result.ok) {
      // "is_uncategorized" is also reported as 404 — the permanent
      // Uncategorized category isn't a resource that can not-exist from
      // the client's point of view, so the same "acts like it's not
      // there" response applies (Section 2.2).
      return jsonNotFound();
    }

    await recordAuditLog(user.id, {
      entityType: "Category",
      entityId: id,
      action: "DELETE",
      beforeData: { reassignedTransactionCount: result.reassignedCount },
    });

    return NextResponse.json({ ok: true, reassignedCount: result.reassignedCount });
  } catch (error) {
    console.error("DELETE /api/categories/[id] failed", error);
    return jsonServerError();
  }
}
