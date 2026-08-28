import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../../../lib/money";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { addGoalContribution } from "../../../../../server/dal/goals";

const BodySchema = z.object({
  // Signed shekel string: "500" for a contribution, "-500" for a withdrawal.
  amount: z.string().min(1),
  contributedAt: z.string().datetime().optional(),
  note: z.string().trim().max(200).optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "goals:contribute");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id: goalId } = await params;

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
  if (amountAgorot === 0) {
    return jsonBadRequest("Amount must not be zero");
  }

  try {
    const contribution = await addGoalContribution(user.id, goalId, {
      amount: BigInt(amountAgorot),
      contributedAt: parsed.data.contributedAt ? new Date(parsed.data.contributedAt) : new Date(),
      note: parsed.data.note,
    });
    if (!contribution) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "GoalContribution",
      entityId: contribution.id,
      action: "CREATE",
      afterData: { goalId, amount: amountAgorot },
    });

    return NextResponse.json(
      { ok: true, contribution: { id: contribution.id, amount: Number(contribution.amount) } },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST /api/goals/[id]/contributions failed", error);
    return jsonServerError();
  }
}
