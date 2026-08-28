import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../../../lib/money";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { recordDebtPayment } from "../../../../../server/dal/debts";

const BodySchema = z.object({
  amount: z.string().min(1),
  paidAt: z.string().datetime().optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "debts:pay");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id: debtId } = await params;

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

  let amountAgorot: ReturnType<typeof parseShekelsToAgorot>;
  try {
    amountAgorot = parseShekelsToAgorot(parsed.data.amount);
  } catch {
    return jsonBadRequest("Invalid amount");
  }
  if (amountAgorot <= 0) {
    return jsonBadRequest("Payment amount must be positive");
  }

  try {
    const updated = await recordDebtPayment(user.id, debtId, {
      amount: BigInt(amountAgorot),
      paidAt: parsed.data.paidAt ? new Date(parsed.data.paidAt) : new Date(),
    });
    if (!updated) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "Debt",
      entityId: debtId,
      action: "UPDATE",
      afterData: { paymentAmount: amountAgorot, newBalance: Number(updated.currentBalance) },
    });

    return NextResponse.json(
      {
        ok: true,
        debt: {
          id: updated.id,
          currentBalance: Number(updated.currentBalance),
          paymentCount: updated.payments.length,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST /api/debts/[id]/payments failed", error);
    return jsonServerError();
  }
}
