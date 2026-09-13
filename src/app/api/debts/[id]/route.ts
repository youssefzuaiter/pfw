import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { deleteDebt } from "../../../../server/dal/debts";

/**
 * Hard delete — removes the debt and every one of its recorded payments
 * with it, via the schema's own cascade. "Not found" covers both
 * "doesn't exist" and "belongs to someone else" (Section 2.2's IDOR shape).
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "debts:delete");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

  try {
    const result = await deleteDebt(user.id, id);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "Debt",
      entityId: id,
      action: "DELETE",
      beforeData: { name: result.name },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/debts/[id] failed", error);
    return jsonServerError();
  }
}
