import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseDecimalToNativeAmount } from "../../../../../lib/currency";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../../server/api/responses";
import { checkAccountBalance } from "../../../../../server/dal/balance-check";

const BodySchema = z.object({
  /** What the bank shows, a plain decimal string. For a card: what is owed. */
  balance: z.string().trim().min(1).max(24),
  /** The day that figure is for, `YYYY-MM-DD`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "day must be a YYYY-MM-DD date"),
});

/**
 * Compares the balance the bank shows with the balance the app works out for
 * the same day, and points at the likely reason for any gap (AGENTS.md §3oooo).
 * Changes nothing, but sits behind the mutation guard like the other POST
 * routes (an Origin check, a rate limit): it reads the whole of an account's
 * movement.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "bank-accounts:check");
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

  const day = new Date(`${parsed.data.day}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== parsed.data.day) return jsonBadRequest("Invalid day.");

  let bankNative: number;
  try {
    bankNative = parseDecimalToNativeAmount(parsed.data.balance);
  } catch {
    return jsonBadRequest("That is not a valid balance.");
  }
  if (bankNative < 0) return jsonBadRequest("The balance must not be negative.");

  try {
    const outcome = await checkAccountBalance(user.id, id, { bankNative, day });
    if (!outcome.ok) {
      if (outcome.error === "not_found") return jsonNotFound();
      if (outcome.error === "in_future") return jsonBadRequest("That day has not happened yet.");
      return jsonBadRequest(`The balance you entered was for ${outcome.earliest}. Pick that day or a later one, or use Update balance.`);
    }
    return NextResponse.json(outcome);
  } catch (error) {
    console.error("POST /api/bank-accounts/[id]/check failed", error);
    return jsonServerError();
  }
}
