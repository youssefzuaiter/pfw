import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../../lib/money";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { jsonBadRequest, jsonServerError, jsonTooManyRequests } from "../../../../server/api/responses";
import { buildMonteCarloAnalytics, serializeMonteCarloAnalytics } from "../../../../server/analytics/build-monte-carlo-data";
import { getOrCreateUserSettings } from "../../../../server/dal/user-settings";
import { agorot } from "../../../../lib/money";

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

  // Saved defaults (Punch List Tier 2, item 1 — `/settings`'s "Monte Carlo
  // widget defaults" panel): an explicit query param (a slider drag on
  // `/analytics`) always wins over the saved row, which itself wins over
  // `buildMonteCarloAnalytics`'s own internal fallback for the one field
  // (`annualSpend`) `UserSettings` leaves nullable. `currentAge` has no
  // saved default and never will — see that DAL function's own doc
  // comment on why this app never stores a DOB.
  const settings = await getOrCreateUserSettings(user.id);

  let annualSpendAgorot: ReturnType<typeof parseShekelsToAgorot> | undefined =
    settings.monteCarloTargetAnnualSpendAgorot !== null
      ? agorot(Number(settings.monteCarloTargetAnnualSpendAgorot))
      : undefined;
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

  // `monteCarloRetirementAge` is a non-nullable column (schema default
  // 65) — there's no way to tell "the user explicitly saved 65" apart
  // from "never touched, still the column default." An EXPLICIT query
  // override (a real slider drag) is trusted as-is, including a
  // deliberate already-retired/decumulation-from-start scenario
  // (src/lib/monte-carlo.ts's own documented, intentional behavior).
  // Falling back to the saved/default value instead re-applies the same
  // `Math.max(currentAge, ...)` safety clamp `buildMonteCarloAnalytics`
  // itself used to apply for its own internal default, so a stale/
  // never-customized 65 can't silently request a nonsensical
  // before-today retirement for someone older than 65 who never
  // touched this setting.
  const retirementAge =
    parsed.data.retirementAge ?? Math.max(parsed.data.currentAge, settings.monteCarloRetirementAge);

  try {
    const analytics = await buildMonteCarloAnalytics(
      user.id,
      parsed.data.currentAge,
      retirementAge,
      annualSpendAgorot,
      parsed.data.volatilityMultiplier ?? settings.monteCarloVolatilityMultiplier,
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
