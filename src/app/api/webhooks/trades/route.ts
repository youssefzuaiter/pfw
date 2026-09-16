import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "../../../../lib/webhook-signature";
import { jsonBadRequest, jsonForbidden, jsonServerError } from "../../../../server/api/responses";
import { recordPendingPaperTrade, settlePaperTradeReceipt } from "../../../../server/dal/paper-trades";
import { findTradeByIdempotencyKey } from "../../../../server/dal/portfolio";
import { getLatestRateTable } from "../../../../server/dal/exchange-rates";
import { getWebhookSecret } from "../../../../server/env";
import { repriceReceipt } from "../../../../server/paper-trader/reprice-receipt";
import { settleWithRaceRetry } from "../../../../server/paper-trader/settle-with-race-retry";
import { resolvePaperTradingUser } from "../../../../server/paper-trader/resolve-paper-trading-user";

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
 * 3. **Never trust the trader's ILS figures.** The receipt's
 *    `price_agorot`/`exchange_rate_at_entry` come from a fixed rate in
 *    the agent's own `.env`; the execution price is re-derived from the
 *    NATIVE amount at this app's synced rate (`reprice-receipt.ts`,
 *    law #3) — the trader's numbers are accepted for compatibility and
 *    compared, never booked.
 * 4. **A misconfigured target account is a 503, not a 500.** The account
 *    is resolved by `resolve-paper-trading-user.ts`; when it can't be,
 *    the response says so in a way the agent's outbox treats as
 *    retryable, instead of the opaque foreign-key failure it used to be.
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
  // from the body — see `getPaperTradingUserEmail`'s doc comment in
  // env.ts for why a body-supplied identity would turn one leaked secret
  // into a write primitive against every account in the database.
  const target = await resolvePaperTradingUser();
  if (target.status !== "ok") {
    console.error(
      `POST /api/webhooks/trades: paper-trading user ${target.status}` +
        (target.status === "missing" ? ` (${target.configured} matches no User row)` : " (set PAPER_TRADING_USER_EMAIL)"),
    );
    return NextResponse.json(
      { error: "paper_trading_user_unresolved", detail: "PFW has no valid paper-trading account configured" },
      { status: 503 },
    );
  }
  const userId = target.userId;

  // Law #3: convert once, at execution, at the REAL rate — ours, not the
  // trader's fixed one (property 3 above).
  const rateTable = await getLatestRateTable(executedAt);
  const repriced = repriceReceipt({
    nativePriceMinorUnits: receipt.native_price_amount,
    currency: receipt.currency,
    ourRate: rateTable[receipt.currency],
    traderRate: exchangeRate,
  });
  if (repriced.driftWarning) {
    console.warn(`POST /api/webhooks/trades: ${repriced.driftWarning} (receipt ${receipt.idempotency_key})`);
  }

  const receiptInput = {
    idempotencyKey: receipt.idempotency_key,
    orderId: receipt.order_id,
    symbol: receipt.symbol.toUpperCase(),
    side: (receipt.side === "buy" ? "BUY" : "SELL") as "BUY" | "SELL",
    quantity,
    priceAgorot: repriced.priceAgorot,
    nativePriceAmount: repriced.nativePriceAmount,
    currency: receipt.currency,
    exchangeRate: repriced.exchangeRate,
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

    return respondToSettlement(await settleWithRaceRetry(userId, receiptInput));
  } catch (error) {
    // A concurrent redelivery of a PENDING receipt loses the race on
    // `@@unique([userId, idempotencyKey])` and surfaces here as a
    // constraint violation. That is still a duplicate, not a failure, so
    // it resolves the same way — the identical recovery `/api/trades`
    // already does for its own idempotency-key race.
    //
    // ONLY that case, though (trader integration hardening, ad hoc). This
    // used to resolve ANY error to "duplicate" whenever a trade with the
    // key existed — which for a SETTLEMENT is always, since the pending
    // row is there by design. A genuine failure inside
    // `settlePaperTradeReceipt` therefore answered 200, the trader logged
    // "delivered", and the trade sat PENDING forever with nothing ever
    // retrying it — observed live, not hypothetically. Anything that
    // isn't a unique-constraint race is now a real 500, which is exactly
    // what the trader's outbox retries. (A settlement's own race is
    // handled inside `settleWithRaceRetry`, never here.)
    if (receipt.status === "pending" && isUniqueConstraintViolation(error)) {
      const raced = await findTradeByIdempotencyKey(userId, receipt.idempotency_key).catch(() => null);
      if (raced) {
        return NextResponse.json({ ok: true, status: "duplicate", tradeId: raced.id }, { status: 200 });
      }
    }
    console.error("POST /api/webhooks/trades failed", error);
    return jsonServerError();
  }
}

function respondToSettlement(result: Awaited<ReturnType<typeof settleWithRaceRetry>>): NextResponse {
  switch (result.status) {
    case "race_unresolved":
      return NextResponse.json(
        { ok: false, error: "settlement_race", detail: "Pending receipt not yet committed; retry" },
        { status: 503 },
      );

    case "duplicate":
      // A redelivered receipt is a success, not a failure: the agent
      // retries on transport errors and 5xx, and answering anything
      // else would make it retry forever against an already-booked
      // trade. 200 rather than 201 — nothing was created this time.
      return NextResponse.json({ ok: true, status: "duplicate", tradeId: result.tradeId }, { status: 200 });

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
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}
