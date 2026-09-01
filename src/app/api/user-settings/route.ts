import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../lib/money";
import { getCurrentUser } from "../../../server/auth/current-user";
import { guardMutation } from "../../../server/api/guard-mutation";
import { checkRateLimit } from "../../../server/api/rate-limit";
import { jsonBadRequest, jsonServerError, jsonTooManyRequests } from "../../../server/api/responses";
import {
  getOrCreateUserSettings,
  updateUserSettings,
  type UpdateUserSettingsInput,
  type UserSettingsData,
} from "../../../server/dal/user-settings";

/**
 * Global per-user preferences (Punch List Tier 2, item 1 — see
 * `UserSettings`'s own schema doc comment for scope). GET returns the
 * current row (creating it with defaults on first read); PATCH applies a
 * partial update. GET deliberately skips `guardMutation`'s Origin/CSRF
 * check — same reasoning as `GET /api/tax/simulate`/
 * `GET /api/analytics/monte-carlo` (Section 2.4's CSRF concern is
 * specific to state-changing requests) — but keeps identity resolution
 * and rate limiting by calling those primitives directly; PATCH is a real
 * mutation and goes through the normal `guardMutation` preamble.
 *
 * Monetary fields use the same signed-shekel-string convention as the
 * tax-simulate/monte-carlo/goals routes (`parseShekelsToAgorot` in,
 * `Number(bigint)` out) — never a raw integer agorot count over the wire,
 * matching every other money-carrying JSON body in this app.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

const PatchBodySchema = z.object({
  taxJurisdiction: z.enum(["US", "DE", "INTL"]).optional(),
  taxMethod: z.enum(["FIFO", "LIFO"]).optional(),
  taxOtherOrdinaryIncome: z.string().min(1).optional(),
  taxIncludeNiit: z.boolean().optional(),
  taxChurchTaxRate: z.number().min(0).max(1).optional(),
  taxAnnualAllowance: z.string().min(1).nullable().optional(),
  taxFlatRatePercent: z.number().min(0).max(1).nullable().optional(),
  monteCarloRetirementAge: z.number().int().min(0).max(120).optional(),
  monteCarloTargetAnnualSpend: z.string().min(1).nullable().optional(),
  monteCarloVolatilityMultiplier: z.number().min(0.25).max(3).optional(),
  defaultManualAssetLiquidityTier: z.enum(["LIQUID", "SEMI_LIQUID", "ILLIQUID"]).nullable().optional(),
  preferredCurrencyDisplay: z.enum(["NATIVE", "ILS"]).optional(),
});

function serialize(data: UserSettingsData) {
  return {
    taxJurisdiction: data.taxJurisdiction,
    taxMethod: data.taxMethod,
    taxOtherOrdinaryIncome: Number(data.taxOtherOrdinaryIncomeAgorot) / 100,
    taxIncludeNiit: data.taxIncludeNiit,
    taxChurchTaxRate: data.taxChurchTaxRate,
    taxAnnualAllowance: data.taxAnnualAllowanceAgorot === null ? null : Number(data.taxAnnualAllowanceAgorot) / 100,
    taxFlatRatePercent: data.taxFlatRatePercent,
    monteCarloRetirementAge: data.monteCarloRetirementAge,
    monteCarloTargetAnnualSpend:
      data.monteCarloTargetAnnualSpendAgorot === null ? null : Number(data.monteCarloTargetAnnualSpendAgorot) / 100,
    monteCarloVolatilityMultiplier: data.monteCarloVolatilityMultiplier,
    defaultManualAssetLiquidityTier: data.defaultManualAssetLiquidityTier,
    preferredCurrencyDisplay: data.preferredCurrencyDisplay,
  };
}

export async function GET() {
  const user = await getCurrentUser();
  const rate = checkRateLimit(`user-settings:get:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) return jsonTooManyRequests(rate.resetAt);

  try {
    const settings = await getOrCreateUserSettings(user.id);
    return NextResponse.json(serialize(settings));
  } catch (error) {
    console.error("GET /api/user-settings failed", error);
    return jsonServerError();
  }
}

export async function PATCH(request: NextRequest) {
  const guard = await guardMutation(request, "user-settings:patch", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Invalid JSON body");
  }

  const parsed = PatchBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid settings update", parsed.error.issues);
  }
  const body = parsed.data;

  const patch: UpdateUserSettingsInput = {};
  if (body.taxJurisdiction !== undefined) patch.taxJurisdiction = body.taxJurisdiction;
  if (body.taxMethod !== undefined) patch.taxMethod = body.taxMethod;
  if (body.taxIncludeNiit !== undefined) patch.taxIncludeNiit = body.taxIncludeNiit;
  if (body.taxChurchTaxRate !== undefined) patch.taxChurchTaxRate = body.taxChurchTaxRate;
  if (body.taxFlatRatePercent !== undefined) patch.taxFlatRatePercent = body.taxFlatRatePercent;
  if (body.monteCarloRetirementAge !== undefined) patch.monteCarloRetirementAge = body.monteCarloRetirementAge;
  if (body.monteCarloVolatilityMultiplier !== undefined) {
    patch.monteCarloVolatilityMultiplier = body.monteCarloVolatilityMultiplier;
  }
  if (body.defaultManualAssetLiquidityTier !== undefined) {
    patch.defaultManualAssetLiquidityTier = body.defaultManualAssetLiquidityTier;
  }
  if (body.preferredCurrencyDisplay !== undefined) patch.preferredCurrencyDisplay = body.preferredCurrencyDisplay;

  try {
    if (body.taxOtherOrdinaryIncome !== undefined) {
      const parsedAmount = parseShekelsToAgorot(body.taxOtherOrdinaryIncome);
      if (parsedAmount < 0) return jsonBadRequest("taxOtherOrdinaryIncome must not be negative");
      patch.taxOtherOrdinaryIncomeAgorot = BigInt(parsedAmount);
    }
    if (body.taxAnnualAllowance !== undefined) {
      patch.taxAnnualAllowanceAgorot =
        body.taxAnnualAllowance === null ? null : BigInt(parseShekelsToAgorot(body.taxAnnualAllowance));
    }
    if (body.monteCarloTargetAnnualSpend !== undefined) {
      patch.monteCarloTargetAnnualSpendAgorot =
        body.monteCarloTargetAnnualSpend === null ? null : BigInt(parseShekelsToAgorot(body.monteCarloTargetAnnualSpend));
    }
  } catch {
    return jsonBadRequest("Invalid monetary amount");
  }

  try {
    const settings = await updateUserSettings(user.id, patch);
    return NextResponse.json(serialize(settings));
  } catch (error) {
    console.error("PATCH /api/user-settings failed", error);
    return jsonServerError();
  }
}
