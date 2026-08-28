import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getMockPriceAgorot, isKnownMockSymbol } from "../../../lib/mock-market-data";
import { guardMutation } from "../../../server/api/guard-mutation";
import { getIdempotentResponse, storeIdempotentResponse } from "../../../server/api/idempotency";
import { jsonBadRequest, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { executeTrade, findTradeByIdempotencyKey, listTrades } from "../../../server/dal/portfolio";

type TradeRecord = NonNullable<Awaited<ReturnType<typeof listTrades>>>[number];

const BodySchema = z.object({
  symbol: z.string().trim().min(1).max(10),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.string().min(1),
});

/** Up to 8 decimal places, matching the schema's Decimal(20, 8) — no scientific notation, no negatives. */
const QUANTITY_PATTERN = /^\d+(\.\d{1,8})?$/;

function parseQuantity(raw: string): number | null {
  if (!QUANTITY_PATTERN.test(raw.trim())) return null;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function serializeTrade(trade: TradeRecord) {
  return {
    id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    quantity: trade.quantity.toString(),
    priceAgorot: Number(trade.priceAgorot),
    totalAgorot: Number(trade.totalAgorot),
    realizedPnlAgorot: trade.realizedPnlAgorot !== null ? Number(trade.realizedPnlAgorot) : null,
    executedAt: trade.executedAt.toISOString(),
  };
}

/**
 * Trade submission — a "balance mutation" per Section 2.4, so
 * Idempotency-Key is REQUIRED (unlike the optional header on the
 * transaction recategorize route). Execution price is always looked up
 * server-side from the mock feed; the client never supplies a price,
 * which would otherwise let it dictate its own P&L.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "trades:execute", { windowMs: 60_000, maxRequests: 20 });
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!idempotencyKey) {
    return jsonBadRequest("Idempotency-Key header is required for trade submissions");
  }

  const cached = getIdempotentResponse(user.id, idempotencyKey);
  if (cached) {
    return NextResponse.json(cached.body, { status: cached.status });
  }

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

  const symbol = parsed.data.symbol.toUpperCase();
  if (!isKnownMockSymbol(symbol)) {
    return jsonBadRequest(`Unknown symbol: ${symbol}`);
  }

  const quantity = parseQuantity(parsed.data.quantity);
  if (quantity === null) {
    return jsonBadRequest("Invalid quantity");
  }

  try {
    // Durable check ahead of execution: the in-memory cache above is only
    // a fast path and doesn't survive a server restart, but the DB's
    // (userId, idempotencyKey) unique constraint does.
    const existingTrade = await findTradeByIdempotencyKey(user.id, idempotencyKey);
    if (existingTrade) {
      const body = { ok: true, trade: serializeTrade(existingTrade) };
      storeIdempotentResponse(user.id, idempotencyKey, 201, body);
      return NextResponse.json(body, { status: 201 });
    }

    const executedAt = new Date();
    const priceAgorot = getMockPriceAgorot(symbol, executedAt);

    const result = await executeTrade(user.id, {
      symbol,
      side: parsed.data.side,
      quantity,
      priceAgorot,
      executedAt,
      idempotencyKey,
    });

    if (!result.ok) {
      return jsonBadRequest("Insufficient shares for this sale");
    }

    await recordAuditLog(user.id, {
      entityType: "Trade",
      entityId: result.trade.id,
      action: "CREATE",
      afterData: { symbol, side: parsed.data.side, quantity, priceAgorot: Number(priceAgorot) },
    });

    const responseBody = { ok: true, trade: serializeTrade(result.trade) };
    storeIdempotentResponse(user.id, idempotencyKey, 201, responseBody);

    return NextResponse.json(responseBody, { status: 201 });
  } catch (error) {
    // A duplicate-key race (two concurrent submissions with the same
    // Idempotency-Key) surfaces here as a unique constraint violation —
    // treat it the same as the durable check above finding a match.
    const existingTrade = await findTradeByIdempotencyKey(user.id, idempotencyKey).catch(() => null);
    if (existingTrade) {
      const body = { ok: true, trade: serializeTrade(existingTrade) };
      return NextResponse.json(body, { status: 201 });
    }
    console.error("POST /api/trades failed", error);
    return jsonServerError();
  }
}
