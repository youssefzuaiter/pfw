import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidMonthKey } from "../../../../lib/date-month";
import { formatAgorot, parseShekelsToAgorot, agorot } from "../../../../lib/money";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { allocateToEnvelope, getAvailableToBudget, getEnvelopeBalances } from "../../../../server/dal/envelopes";

const BodySchema = z.object({
  categoryId: z.string().min(1),
  month: z.string().refine(isValidMonthKey, { message: "month must be in YYYY-MM format" }),
  // A shekel-amount string ("500.00"), parsed server-side via the one
  // audited money utility — never trust a client to have done its own
  // float math for a monetary value, same convention every other
  // money-bearing route in this app already follows.
  amount: z.string().min(1),
});

/**
 * Sets a category's allocation for a given month — the same handler for
 * both POST (a new allocation) and PATCH (adjusting an existing one),
 * since `allocateToEnvelope` is a set-not-increment upsert either way;
 * there's no meaningful behavioral difference between the two verbs
 * here, only which one reads more naturally for a given caller.
 *
 * Enforces the Zero-Sum Rule: the DELTA this request introduces
 * (`amount` minus whatever this category was already allocated for this
 * exact month, zero if none) can never exceed `getAvailableToBudget` —
 * i.e. total allocations across every category, up to and including
 * this month, can never exceed real income received up to and including
 * this month. Checking the delta (not a raw comparison against the new
 * total) is what makes REDUCING an existing allocation, or leaving it
 * unchanged, always valid regardless of how tight `available` already
 * is.
 */
async function handleAllocate(request: NextRequest) {
  const guard = await guardMutation(request, "envelopes:allocate");
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

  let amountAgorot: ReturnType<typeof parseShekelsToAgorot>;
  try {
    amountAgorot = parseShekelsToAgorot(parsed.data.amount);
  } catch {
    return jsonBadRequest("Invalid amount");
  }
  if (amountAgorot < 0) {
    return jsonBadRequest("amount must not be negative");
  }

  try {
    const [available, balances] = await Promise.all([
      getAvailableToBudget(user.id, parsed.data.month),
      getEnvelopeBalances(user.id, parsed.data.month),
    ]);

    const existingThisMonth =
      balances.find((b) => b.categoryId === parsed.data.categoryId)?.allocatedThisMonthAgorot ?? agorot(0);
    const delta = amountAgorot - existingThisMonth;

    if (delta > available) {
      return jsonBadRequest(
        `This would exceed what's available to budget (${formatAgorot(available)} available, ${formatAgorot(agorot(delta))} more requested)`,
      );
    }

    const result = await allocateToEnvelope(user.id, parsed.data.categoryId, amountAgorot, parsed.data.month);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "EnvelopeAllocation",
      entityId: `${result.categoryId}:${result.month}`,
      action: "UPDATE",
      afterData: { categoryId: result.categoryId, month: result.month, amountAgorot: result.amountAgorot },
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("allocate envelope failed", error);
    return jsonServerError();
  }
}

export async function POST(request: NextRequest) {
  return handleAllocate(request);
}

export async function PATCH(request: NextRequest) {
  return handleAllocate(request);
}
