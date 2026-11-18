import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidMonthKey } from "../../../../lib/date-month";
import { formatAgorot, parseShekelsToAgorot, agorot } from "../../../../lib/money";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { allocationFits, reserveIncrease } from "../../../../lib/envelope-math";
import { allocateToEnvelope, getBudgetPosition, getEnvelopeBalances } from "../../../../server/dal/envelopes";

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
 * Enforces the Zero-Sum Rule (AGENTS.md §3rrrr): the cash this request
 * newly sets aside can never exceed what is available to budget (cash in
 * the accounts, less card debt, less what is already in envelopes). The
 * change is measured on the envelope's balance, not the typed amount:
 * lifting an overdrawn envelope back to zero sets nothing aside, because
 * the overspend already left the account. Reducing an allocation, or
 * leaving it unchanged, is always valid however tight `available` is.
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
    const [position, balances] = await Promise.all([
      getBudgetPosition(user.id, parsed.data.month),
      getEnvelopeBalances(user.id, parsed.data.month),
    ]);
    const available = position.availableAgorot;

    const envelope = balances.find((b) => b.categoryId === parsed.data.categoryId);
    const existingThisMonth = envelope?.allocatedThisMonthAgorot ?? agorot(0);
    const delta = amountAgorot - existingThisMonth;
    const setAside = reserveIncrease(envelope?.balanceAgorot ?? 0, delta);

    if (!allocationFits(setAside, available)) {
      return jsonBadRequest(
        `This would set aside more than the cash you have free (${formatAgorot(available)} available to budget, ${formatAgorot(agorot(setAside))} more requested)`,
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
