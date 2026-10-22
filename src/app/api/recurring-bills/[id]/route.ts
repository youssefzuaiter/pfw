import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { parseRecurringBillBody } from "../../../../server/api/recurring-bill-validation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { deleteRecurringBill, updateRecurringBill } from "../../../../server/dal/recurring-bills";

/** Replaces a bill's details. A bill that does not exist and one that is someone else's answer the same 404 (Section 2.2). */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "recurring-bills:patch");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = parseRecurringBillBody(rawBody);
  if (!parsed.ok) return jsonBadRequest(parsed.message, parsed.issues);

  try {
    const result = await updateRecurringBill(user.id, id, parsed.data);
    if (result === null) return jsonNotFound();
    if (!result.ok) return jsonBadRequest("That category does not exist");

    await recordAuditLog(user.id, {
      entityType: "RecurringBill",
      entityId: id,
      action: "UPDATE",
      afterData: { name: result.bill.name, currency: result.bill.currency, cadence: result.bill.cadence },
    });

    return NextResponse.json({ ok: true, bill: { ...result.bill, anchorDate: parsed.data.anchorDate } });
  } catch (error) {
    console.error("PATCH /api/recurring-bills/[id] failed", error);
    return jsonServerError();
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "recurring-bills:delete");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

  try {
    const deleted = await deleteRecurringBill(user.id, id);
    if (!deleted) return jsonNotFound();

    await recordAuditLog(user.id, { entityType: "RecurringBill", entityId: id, action: "DELETE" });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/recurring-bills/[id] failed", error);
    return jsonServerError();
  }
}
