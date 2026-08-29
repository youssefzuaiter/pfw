import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../../lib/money";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { jsonBadRequest, jsonServerError, jsonTooManyRequests } from "../../../../server/api/responses";
import { buildMonteCarloAnalytics, serializeMonteCarloAnalytics } from "../../../../server/analytics/build-monte-carlo-data";

/**
 * A GET, read-only compute endpoint — no state changes, so this
 * deliberately skips `guardMutation`'s Origin/CSRF check (Section 2.4's
 * CSRF concern is specific to state-changing requests) but keeps the
 * same identity-never-trusts-the-client and rate-limiting halves by
 * calling their primitives directly. Rate limited a bit tighter than a
 * typical read (30/min is the mutation default; this runs 5,000
 * simulated paths per call) even though that's still cheap in absolute
 * terms — defense-in-depth against a client hammering it in a loop.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 20 };

const QuerySchema = z.object({
  currentAge: z.coerce.number().int().min(0).max(120),
  retirementAge: z.coerce.number().int().min(0).max(120).optional(),
  // Signed-shekel-string convention, same as the goals contribution route.
  annualSpend: z.string().min(1).optional(),
  // A multiplier on the default volatility assumptions, not a raw stdDev —
  // see build-monte-carlo-data.ts for how it's applied.
  volatilityMultiplier: z.coerce.number().min(0.25).max(3).optional(),
});

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();

  const rate = checkRateLimit(`analytics:monte-carlo:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  const parsed = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return jsonBadRequest("Invalid query parameters", parsed.error.issues);
  }

  let annualSpendAgorot: ReturnType<typeof parseShekelsToAgorot> | undefined;
  if (parsed.data.annualSpend !== undefined) {
    try {
      annualSpendAgorot = parseShekelsToAgorot(parsed.data.annualSpend);
    } catch {
      return jsonBadRequest("Invalid annualSpend");
    }
    if (annualSpendAgorot < 0) {
      return jsonBadRequest("annualSpend must not be negative");
    }
  }

  try {
    const analytics = await buildMonteCarloAnalytics(
      user.id,
      parsed.data.currentAge,
      parsed.data.retirementAge,
      annualSpendAgorot,
      parsed.data.volatilityMultiplier,
    );

    return NextResponse.json(serializeMonteCarloAnalytics(analytics));
  } catch (error) {
    if (error instanceof RangeError) {
      return jsonBadRequest(error.message);
    }
    console.error("GET /api/analytics/monte-carlo failed", error);
    return jsonServerError();
  }
}
