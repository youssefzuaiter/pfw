import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../lib/money";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { createDebt } from "../../../server/dal/debts";

const DEBT_TYPES = ["CREDIT_CARD", "MORTGAGE", "PERSONAL_LOAN", "AUTO_LOAN", "STUDENT_LOAN", "OTHER"] as const;

const BodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  debtType: z.enum(DEBT_TYPES),
  currentBalance: z.string().min(1),
  aprPercent: z.string().min(1),
  minimumPayment: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "debts:create");
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

  let currentBalanceAgorot: ReturnType<typeof parseShekelsToAgorot>;
  let minimumPaymentAgorot: ReturnType<typeof parseShekelsToAgorot>;
  let aprBps: number;
  try {
    currentBalanceAgorot = parseShekelsToAgorot(parsed.data.currentBalance);
    minimumPaymentAgorot = parseShekelsToAgorot(parsed.data.minimumPayment);
    const aprPercent = Number.parseFloat(parsed.data.aprPercent);
    if (!Number.isFinite(aprPercent)) throw new RangeError("Invalid APR");
    aprBps = Math.round(aprPercent * 100);
  } catch {
    return jsonBadRequest("Invalid balance, payment, or APR value");
  }
  if (currentBalanceAgorot <= 0 || minimumPaymentAgorot <= 0 || aprBps < 0) {
    return jsonBadRequest("Balance and minimum payment must be positive; APR must not be negative");
  }

  try {
    const debt = await createDebt(user.id, {
      name: parsed.data.name,
      debtType: parsed.data.debtType,
      currentBalance: BigInt(currentBalanceAgorot),
      aprBps,
      minimumPayment: BigInt(minimumPaymentAgorot),
    });

    await recordAuditLog(user.id, {
      entityType: "Debt",
      entityId: debt.id,
      action: "CREATE",
      afterData: { name: debt.name, currentBalance: currentBalanceAgorot, aprBps },
    });

    return NextResponse.json(
      {
        ok: true,
        debt: {
          id: debt.id,
          name: debt.name,
          debtType: debt.debtType,
          currentBalance: Number(debt.currentBalance),
          aprBps: debt.aprBps,
          minimumPayment: Number(debt.minimumPayment),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST /api/debts failed", error);
    return jsonServerError();
  }
}
