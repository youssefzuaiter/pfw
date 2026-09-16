import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "../../../../lib/webhook-signature";
import { jsonBadRequest, jsonForbidden, jsonServerError } from "../../../../server/api/responses";
import { recordScenarioMetrics } from "../../../../server/dal/scenario-metrics";
import { getWebhookSecret } from "../../../../server/env";
import { resolvePaperTradingUser } from "../../../../server/paper-trader/resolve-paper-trading-user";

/**
 * Structured AI-strategy telemetry from the Tier-0 paper-trading agent
 * (ad hoc, Phase 4) — one row per scenario the agent EVALUATED, fired
 * from `scheduler.trading_loop()` every cycle. Same trust-boundary shape
 * as `/api/webhooks/trades` (this route's own doc comment there explains
 * why a real caller holding a real shared secret is exactly the
 * condition that makes a public, unauthenticated endpoint acceptable —
 * §3oo's rejected PSD2 webhook had no such caller). Reusing that exact
 * reasoning here, not inventing a new one: this endpoint could
 * "only" corrupt analytics rows rather than move money, but there is
 * still no reason to accept an unauthenticated public write when the
 * agent already holds WEBHOOK_SECRET and the signing/verification
 * infrastructure already exists — skipping it here would be a real,
 * avoidable regression from this app's own established posture, not a
 * proportionate relaxation for lower stakes.
 *
 * Idempotent on the trader's `X-Idempotency-Key` (trader integration
 * hardening, ad hoc). This route originally skipped dedup on purpose —
 * "a duplicate analytics row on retry is a low-severity cost" — which
 * held while a retry meant three attempts within ~1.5s. It stopped
 * holding once the trader gained a durable outbox that replays a
 * delivery whose response it never saw (a 5s client timeout on a cold
 * Vercel lambda is enough): every replay would have added a second row
 * for the same evaluated scenario. The header is NOT covered by the MAC,
 * but here that is acceptable in a way it isn't for the trades route's
 * dedupe key: the worst a forged/omitted key can do is make a duplicate
 * row possible (the pre-hardening behaviour), never corrupt or replace
 * an existing one, and only a caller who already holds WEBHOOK_SECRET
 * gets this far at all.
 */

const HASH_PATTERN = /^[0-9a-f]{64}$/;

const MetricsPayloadSchema = z.object({
  schema_version: z.literal(1),
  ticker: z.string().trim().min(1).max(10),
  hash: z.string().regex(HASH_PATTERN, "hash must be a SHA-256 hex digest"),
  predicted_move_pct: z.number().finite(),
  actual_fill_price: z.number().finite().nullable().optional(),
  decision: z.string().trim().min(1).max(64),
  // Shadow A/B pipeline (ad hoc, Phase 3) — a second, non-authoritative
  // model's theoretical verdict on the same scenario. Both optional
  // (rather than required) so an older caller that hasn't computed a
  // shadow verdict at all doesn't fail validation.
  shadow_predicted_move_pct: z.number().finite().nullable().optional(),
  shadow_decision: z.string().trim().min(1).max(64).nullable().optional(),
});

export async function POST(request: NextRequest) {
  // Raw bytes first, before anything can reinterpret them — same
  // "verify before parsing" discipline as /api/webhooks/trades.
  const rawBody = await request.text();

  let secret: string;
  try {
    secret = getWebhookSecret();
  } catch (error) {
    console.error("POST /api/webhooks/metrics: WEBHOOK_SECRET is not configured", error);
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
    console.warn(`POST /api/webhooks/metrics: rejected payload (${verification.reason})`);
    return jsonForbidden("Invalid signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = MetricsPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonBadRequest("Invalid scenario metrics payload", parsed.error.issues);
  }
  const metrics = parsed.data;

  // Same server-controlled-origin reasoning as /api/webhooks/trades:
  // never taken from the body, so a leaked secret can't become a write
  // primitive against an arbitrary account. A 503 (retryable by the
  // trader's outbox), not an opaque 500, when the account doesn't resolve.
  const target = await resolvePaperTradingUser();
  if (target.status !== "ok") {
    console.error(
      `POST /api/webhooks/metrics: paper-trading user ${target.status}` +
        (target.status === "missing" ? ` (${target.configured} matches no User row)` : " (set PAPER_TRADING_USER_EMAIL)"),
    );
    return NextResponse.json(
      { error: "paper_trading_user_unresolved", detail: "PFW has no valid paper-trading account configured" },
      { status: 503 },
    );
  }
  const userId = target.userId;

  const idempotencyKey = request.headers.get(IDEMPOTENCY_HEADER)?.trim().slice(0, 128) || null;

  try {
    const result = await recordScenarioMetrics(userId, {
      ticker: metrics.ticker.toUpperCase(),
      hash: metrics.hash,
      predictedMovePct: metrics.predicted_move_pct,
      actualFillPrice: metrics.actual_fill_price ?? null,
      decision: metrics.decision,
      shadowPredictedMovePct: metrics.shadow_predicted_move_pct ?? null,
      shadowDecision: metrics.shadow_decision ?? null,
      idempotencyKey,
    });

    return NextResponse.json(
      { ok: true, id: result.id, status: result.created ? "recorded" : "duplicate" },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    console.error("POST /api/webhooks/metrics failed", error);
    return jsonServerError();
  }
}
