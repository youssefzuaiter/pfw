import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { agorot, parseShekelsToAgorot } from "../../../../lib/money";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { jsonBadRequest, jsonServerError, jsonTooManyRequests } from "../../../../server/api/responses";
import { buildTaxSimulation, serializeTaxSimulation } from "../../../../server/tax/build-tax-data";
import { getOrCreateUserSettings } from "../../../../server/dal/user-settings";
import {
  DE_DEFAULT_ANNUAL_ALLOWANCE_AGOROT,
  INTL_DEFAULT_ANNUAL_ALLOWANCE_AGOROT,
  INTL_DEFAULT_FLAT_RATE,
} from "../../../../lib/tax-rules";

/**
 * A GET, read-only compute endpoint over the user's own existing trade
 * history — no state changes, so this deliberately skips `guardMutation`'s
 * Origin/CSRF check (Section 2.4's CSRF concern is specific to
 * state-changing requests) but keeps identity resolution and rate
 * limiting by calling those primitives directly, same pattern as
 * `GET /api/analytics/monte-carlo`.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

const QuerySchema = z.object({
  method: z.enum(["FIFO", "LIFO"]).optional(),
  jurisdiction: z.enum(["US", "DE", "INTL"]).optional(),
  // Signed-shekel-string convention, same as the monte-carlo/goals routes.
  otherOrdinaryIncome: z.string().min(1).optional(),
  includeNiit: z.enum(["true", "false"]).optional(),
  churchTaxRate: z.coerce.number().min(0).max(1).optional(),
  annualAllowance: z.string().min(1).optional(),
  flatRatePercent: z.coerce.number().min(0).max(1).optional(),
});

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();

  const rate = checkRateLimit(`tax:simulate:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  const parsed = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return jsonBadRequest("Invalid query parameters", parsed.error.issues);
  }

  // Saved defaults (Punch List Tier 2, item 1 — `/settings`'s "Tax
  // simulator defaults" panel): an explicit query param always wins (a
  // slider drag on `/trading/tax` is a per-request override, never a
  // silent write to the saved row), falling back to whatever the user
  // saved, falling back to this route's own original hardcoded defaults
  // for the two fields `UserSettings` itself leaves nullable.
  const settings = await getOrCreateUserSettings(user.id);

  let otherOrdinaryIncomeAgorot = agorot(Number(settings.taxOtherOrdinaryIncomeAgorot));
  if (parsed.data.otherOrdinaryIncome !== undefined) {
    try {
      otherOrdinaryIncomeAgorot = parseShekelsToAgorot(parsed.data.otherOrdinaryIncome);
    } catch {
      return jsonBadRequest("Invalid otherOrdinaryIncome");
    }
    if (otherOrdinaryIncomeAgorot < 0) {
      return jsonBadRequest("otherOrdinaryIncome must not be negative");
    }
  }

  let annualAllowanceAgorot: number | undefined =
    settings.taxAnnualAllowanceAgorot !== null ? Number(settings.taxAnnualAllowanceAgorot) : undefined;
  if (parsed.data.annualAllowance !== undefined) {
    try {
      annualAllowanceAgorot = parseShekelsToAgorot(parsed.data.annualAllowance);
    } catch {
      return jsonBadRequest("Invalid annualAllowance");
    }
    if (annualAllowanceAgorot < 0) {
      return jsonBadRequest("annualAllowance must not be negative");
    }
  }

  const jurisdiction = parsed.data.jurisdiction ?? settings.taxJurisdiction;
  const includeNiit =
    parsed.data.includeNiit !== undefined ? parsed.data.includeNiit === "true" : settings.taxIncludeNiit;

  try {
    const data = await buildTaxSimulation(
      user.id,
      parsed.data.method ?? settings.taxMethod,
      jurisdiction,
      otherOrdinaryIncomeAgorot,
      includeNiit,
      parsed.data.churchTaxRate ?? settings.taxChurchTaxRate,
      agorot(
        annualAllowanceAgorot ??
          (jurisdiction === "DE" ? DE_DEFAULT_ANNUAL_ALLOWANCE_AGOROT : INTL_DEFAULT_ANNUAL_ALLOWANCE_AGOROT),
      ),
      parsed.data.flatRatePercent ?? settings.taxFlatRatePercent ?? INTL_DEFAULT_FLAT_RATE,
    );

    return NextResponse.json(serializeTaxSimulation(data));
  } catch (error) {
    if (error instanceof RangeError) {
      return jsonBadRequest(error.message);
    }
    console.error("GET /api/tax/simulate failed", error);
    return jsonServerError();
  }
}
