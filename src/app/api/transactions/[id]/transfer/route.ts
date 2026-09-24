import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { setTransactionTransfer } from "../../../../../server/dal/transactions";

const BodySchema = z.object({ isTransfer: z.boolean() });

/**
 * Marks one transaction as money moved between the user's own accounts.
 *
 * The row stays in the ledger — it happened, and the balance moved — but
 * every aggregate answering "what did I earn or spend" skips it. No
 * ledger commit: the chain records what a transaction IS (amount, date,
 * category, description), and this changes only how figures are rolled
 * up, not the transaction itself.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "transactions:transfer");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON.");
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return jsonBadRequest(parsed.error.issues[0]?.message ?? "Invalid request body.");

  try {
    const result = await setTransactionTransfer(user.id, id, parsed.data.isTransfer);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      action: "UPDATE",
      entityType: "NotableTransaction",
      entityId: id,
      afterData: { isTransfer: parsed.data.isTransfer },
    });

    return NextResponse.json({ ok: true, isTransfer: parsed.data.isTransfer });
  } catch (error) {
    console.error("transaction transfer toggle failed", error);
    return jsonServerError();
  }
}
