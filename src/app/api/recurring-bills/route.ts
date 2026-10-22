import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../server/api/guard-mutation";
import { parseRecurringBillBody } from "../../../server/api/recurring-bill-validation";
import { jsonBadRequest, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { createRecurringBill } from "../../../server/dal/recurring-bills";

/**
 * Add a subscription or bill by hand (AGENTS.md §3cccc). `guardMutation`
 * resolves the caller from the session, so a bill can only be created for
 * oneself. The category, when given, must be the caller's own.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "recurring-bills:create");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = parseRecurringBillBody(rawBody);
  if (!parsed.ok) return jsonBadRequest(parsed.message, parsed.issues);

  try {
    const result = await createRecurringBill(user.id, parsed.data);
    if (!result.ok) return jsonBadRequest("That category does not exist");

    await recordAuditLog(user.id, {
      entityType: "RecurringBill",
      entityId: result.bill.id,
      action: "CREATE",
      afterData: { name: result.bill.name, currency: result.bill.currency, cadence: result.bill.cadence },
    });

    return NextResponse.json({ ok: true, bill: { ...result.bill, anchorDate: parsed.data.anchorDate } }, { status: 201 });
  } catch (error) {
    console.error("POST /api/recurring-bills failed", error);
    return jsonServerError();
  }
}
