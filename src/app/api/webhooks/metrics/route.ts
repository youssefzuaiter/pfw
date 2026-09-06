import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "../../../../lib/webhook-signature";
import { jsonBadRequest, jsonForbidden, jsonServerError } from "../../../../server/api/responses";
import { recordScenarioMetrics } from "../../../../server/dal/scenario-metrics";
import { getPaperTradingUserId, getWebhookSecret } from "../../../../server/env";

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
 * Deliberately simpler than the trades webhook in one respect: no
 * idempotency-key dedup. A duplicate row on retry is an acceptable,
 * low-severity cost for analytics telemetry — unlike a trade receipt,
 * nothing here moves money or needs `@@unique` protection.
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
  // primitive against an arbitrary account.
  const userId = getPaperTradingUserId();
  if (!userId) {
    console.error("POST /api/webhooks/metrics: PAPER_TRADING_USER_ID is not configured");
    return jsonServerError();
  }

  try {
    const created = await recordScenarioMetrics(userId, {
      ticker: metrics.ticker.toUpperCase(),
      hash: metrics.hash,
      predictedMovePct: metrics.predicted_move_pct,
      actualFillPrice: metrics.actual_fill_price ?? null,
      decision: metrics.decision,
      shadowPredictedMovePct: metrics.shadow_predicted_move_pct ?? null,
      shadowDecision: metrics.shadow_decision ?? null,
    });

    return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
  } catch (error) {
    console.error("POST /api/webhooks/metrics failed", error);
    return jsonServerError();
  }
}
