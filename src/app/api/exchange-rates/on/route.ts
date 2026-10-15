import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { BASE_CURRENCY, isSupportedCurrency, type CurrencyCode } from "../../../../lib/currency";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { jsonBadRequest, jsonServerError, jsonTooManyRequests } from "../../../../server/api/responses";
import { lockRateFor, NoRateForDayError } from "../../../../server/currency/lock-rate";

const RATE_LIMIT = { maxRequests: 60, windowMs: 60_000 };

const QuerySchema = z.object({
  currency: z.custom<CurrencyCode>((value) => typeof value === "string" && isSupportedCurrency(value), "Unsupported currency"),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
});

/**
 * The rate a transaction dated `day` in `currency` would be locked at
 * (AGENTS.md §3www), so the entry form can show the exact shekel figure
 * before anything is saved. Read-only, so no Origin check (Section 2.4);
 * identity and rate limiting are still applied. The create route looks
 * the rate up again itself and never trusts the one the form was shown.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  const limited = await checkRateLimit(`exchange-rates:on:${user.id}`, RATE_LIMIT);
  if (!limited.allowed) return jsonTooManyRequests(limited.resetAt);

  const parsed = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return jsonBadRequest("Invalid query parameters", parsed.error.issues);
  const { currency, day } = parsed.data;
  if (Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return jsonBadRequest("Invalid day");

  if (currency === BASE_CURRENCY) {
    return NextResponse.json({ currency, day, rate: "1.000000", micros: 1_000_000, rateDay: day });
  }

  try {
    const locked = await lockRateFor(currency, day);
    return NextResponse.json(locked);
  } catch (error) {
    if (error instanceof NoRateForDayError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 422 });
    }
    console.error("GET /api/exchange-rates/on failed", error);
    return jsonServerError();
  }
}
