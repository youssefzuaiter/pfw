import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { deleteBudget } from "../../../../server/dal/budgets";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "budgets:delete");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

  try {
    const deleted = await deleteBudget(user.id, id);
    if (!deleted) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "Budget",
      entityId: id,
      action: "DELETE",
      beforeData: { categoryId: deleted.categoryId, monthlyLimit: Number(deleted.monthlyLimit) },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/budgets/[id] failed", error);
    return jsonServerError();
  }
}
