import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { nativeAmount } from "../../../../lib/currency";
import { agorot } from "../../../../lib/money";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "../../../../lib/webhook-signature";
import { jsonBadRequest, jsonForbidden, jsonServerError } from "../../../../server/api/responses";
import { recordPendingPaperTrade, settlePaperTradeReceipt } from "../../../../server/dal/paper-trades";
import { findTradeByIdempotencyKey } from "../../../../server/dal/portfolio";
import { getPaperTradingUserId, getWebhookSecret } from "../../../../server/env";

/**
 * Signed trade receipts from the Tier-0 paper-trading agent (the local
 * FastAPI service that submits the Alpaca sandbox orders).
 *
 * No user session exists here — the agent is a separate process with no
 * cookies — so this is NOT `guardMutation`-fronted like every other
 * mutating route in this app. The trust boundary is entirely the
 * HMAC-SHA256 signature over the raw body, exactly as `/api/cron`'s is
 * entirely `CRON_SECRET`. Listed in `src/proxy.ts`'s public-path
 * allowlist for the same reason.
 *
 * Worth stating plainly, because this app already rejected a public
 * webhook once: §3oo turned down a PSD2 ingestion webhook because a
 * signature scheme there would have been *security theater* — no real
 * institution was ever going to call it, so the choice was between a
 * fake signature and a genuinely unauthenticated write into a user's
 * ledger. Neither applies here. There is a real caller, holding a real
 * shared secret, and the signature is verified against it before a
 * single byte of the body is parsed. What made a public endpoint wrong
 * there is precisely what is absent here.
 *
 * The two properties this route exists to preserve:
 *
 * 1. **Verify before parsing.** `await request.text()` is read first and
 *    the MAC is checked against those exact bytes. `request.json()` would
 *    re-serialize with different key order and spacing, and the digest
 *    would no longer describe what was actually sent.
 * 2. **Never trust an unsigned header.** `X-Idempotency-Key` is sent for
 *    operator convenience but is NOT covered by the MAC, so the dedupe
 *    key is read from the signed body only.
 */

/**
 * Up to 9 decimal places — Alpaca's own fractional-quantity precision,
 * which is the real upstream constraint. Deliberately tighter than the
 * `Decimal(30, 18)` column: `executeTrade` carries quantity as a JS
 * `number`, and 18 significant decimals would not survive that round
 * trip. Money is unaffected either way — it is integer agorot end to end
 * (§1 law #1); this is a share count, not an amount.
 */
const QUANTITY_PATTERN = /^\d+(\.\d{1,9})?$/;

const DECIMAL_STRING_PATTERN = /^\d+(\.\d+)?$/;

const ReceiptSchema = z.object({
  schema_version: z.literal(1),
  idempotency_key: z.string().trim().min(1).max(128),
  order_id: z.string().trim().min(1).max(128),
  /**
   * Two-phase settlement (ad hoc, extends the original single-shot
   * design — see TradeStatus's schema doc comment): "pending" fires the
   * instant Alpaca ACCEPTS an order, before any real fill; "settled"
   * fires once a real fill is confirmed, carrying the ACTUAL fill price
   * rather than the original order's limit price.
   */
  status: z.enum(["pending", "settled"]),
  symbol: z.string().trim().min(1).max(10),
  side: z.enum(["buy", "sell"]),
  quantity: z.string().regex(QUANTITY_PATTERN, "quantity must be a decimal with at most 9 places"),
  currency: z.enum(["ILS", "USD", "EUR", "GBP"]),
  native_price_amount: z.number().int(),
  native_total_amount: z.number().int(),
  exchange_rate_at_entry: z.string().regex(DECIMAL_STRING_PATTERN, "exchange rate must be a positive decimal"),
  price_agorot: z.number().int(),
  total_agorot: z.number().int(),
  executed_at: z.string().min(1),
  signal: z
    .object({ headline: z.string().max(500).optional() })
    .partial()
    .optional(),
});

export async function POST(request: NextRequest) {
  // Raw bytes first, before anything can reinterpret them. Everything
  // below this line depends on these exact characters.
  const rawBody = await request.text();

  let secret: string;
  try {
    secret = getWebhookSecret();
  } catch (error) {
    console.error("POST /api/webhooks/trades: WEBHOOK_SECRET is not configured", error);
    return jsonServerError();
  }

  const verification = verifyWebhookSignature({
    rawBody,
    signatureHeader: request.headers.get(SIGNATURE_HEADER),
    timestampHeader: request.headers.get(TIMESTAMP_HEADER),
    secret,
    nowMs: Date.now(),
  });

  if (!verification.ok) {
    // The specific reason is logged, never returned: telling an
    // unauthenticated caller whether it got the timestamp or the digest
    // wrong is free oracle access it has no need for.
    console.warn(`POST /api/webhooks/trades: rejected receipt (${verification.reason})`);
    return jsonForbidden("Invalid signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = ReceiptSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonBadRequest("Invalid trade receipt", parsed.error.issues);
  }
  const receipt = parsed.data;

  const executedAt = new Date(receipt.executed_at);
  if (Number.isNaN(executedAt.getTime())) {
    return jsonBadRequest("executed_at must be a valid ISO-8601 timestamp");
  }

  const quantity = Number.parseFloat(receipt.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return jsonBadRequest("quantity must be greater than zero");
  }

  const exchangeRate = Number.parseFloat(receipt.exchange_rate_at_entry);
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    return jsonBadRequest("exchange_rate_at_entry must be greater than zero");
  }

  if (receipt.price_agorot <= 0 || receipt.native_price_amount <= 0) {
    return jsonBadRequest("Execution prices must be positive");
  }

  // Which user this books against comes from server configuration, never
  // from the body — see `getPaperTradingUserId`'s own doc comment for
  // why a body-supplied id would turn one leaked secret into a write
  // primitive against every account in the database.
  const userId = getPaperTradingUserId();
  if (!userId) {
    console.error("POST /api/webhooks/trades: PAPER_TRADING_USER_ID is not configured");
    return jsonServerError();
  }

  const receiptInput = {
    idempotencyKey: receipt.idempotency_key,
    orderId: receipt.order_id,
    symbol: receipt.symbol.toUpperCase(),
    side: (receipt.side === "buy" ? "BUY" : "SELL") as "BUY" | "SELL",
    quantity,
    priceAgorot: agorot(receipt.price_agorot),
    nativePriceAmount: nativeAmount(receipt.native_price_amount),
    currency: receipt.currency,
    exchangeRate,
    executedAt,
    headline: receipt.signal?.headline ?? "",
  };

  try {
    // Pending: only the Trade row is created (provisional price, no
    // envelope/ledger impact at all) — see paper-trades.ts's module doc
    // comment for why. Never 201s a ledger effect that hasn't happened.
    if (receipt.status === "pending") {
      const pendingResult = await recordPendingPaperTrade(userId, receiptInput);
      return NextResponse.json(
        { ok: true, status: pendingResult.status, tradeId: pendingResult.tradeId },
        { status: pendingResult.status === "recorded" ? 201 : 200 },
      );
    }

    const result = await settlePaperTradeReceipt(userId, receiptInput);

    switch (result.status) {
      case "duplicate":
        // A redelivered receipt is a success, not a failure: the agent
        // retries on transport errors and 5xx, and answering anything
        // else would make it retry forever against an already-booked
        // trade. 200 rather than 201 — nothing was created this time.
        return NextResponse.json(
          { ok: true, status: "duplicate", tradeId: result.tradeId },
          { status: 200 },
        );

      case "rejected":
        return jsonBadRequest(
          result.reason === "no_bank_account"
            ? "No bank account exists to book this trade against"
            : "Insufficient shares for this sale",
        );

      case "recorded":
        return NextResponse.json(
          {
            ok: true,
            status: "recorded",
            tradeId: result.tradeId,
            transactionId: result.transactionId,
            categoryId: result.categoryId,
            amountAgorot: result.amountAgorot,
          },
          { status: 201 },
        );
    }
  } catch (error) {
    // A concurrent redelivery loses the race on
    // `@@unique([userId, idempotencyKey])` (or the ledger row's own
    // `@@unique([userId, providerTransactionId])`) and surfaces here as a
    // constraint violation. That is still a duplicate, not a failure, so
    // it resolves the same way — the identical recovery `/api/trades`
    // already does for its own idempotency-key race.
    const raced = await findTradeByIdempotencyKey(userId, receipt.idempotency_key).catch(() => null);
    if (raced) {
      return NextResponse.json({ ok: true, status: "duplicate", tradeId: raced.id }, { status: 200 });
    }
    console.error("POST /api/webhooks/trades failed", error);
    return jsonServerError();
  }
}
