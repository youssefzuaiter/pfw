import { NextResponse, type NextRequest } from "next/server";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  computeWebhookSignature,
} from "../../../../lib/webhook-signature";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonServerError } from "../../../../server/api/responses";
import { getPaperTraderServiceUrl, getWebhookSecret } from "../../../../server/env";

/**
 * Emergency kill switch for the Tier-0 paper-trading agent (ad hoc).
 *
 * This route — NOT the browser — signs the request to the agent's own
 * `POST /control/halt`. The task this closes originally asked for the
 * "Emergency Halt" button itself to generate a valid HMAC signature
 * client-side; that would mean shipping `WEBHOOK_SECRET` inside
 * JavaScript sent to every browser that loads this page, which would let
 * anyone who opens dev tools extract the SAME shared secret this app
 * uses to authenticate trade receipts and settlements — not a
 * proportionate trade-off for a "halt" button, a genuine compromise of
 * both webhook endpoints' trust boundary. This app has a hard, standing
 * rule against exactly this shape of exposure (`WEBHOOK_SECRET` is
 * server-only, in `SECRET_ENV_VAR_NAMES`, guarded by
 * `tests/guards/no-public-secrets.test.ts`), so the signature is
 * computed here instead, server-side, after `guardMutation` has already
 * confirmed the caller holds a real authenticated PFW session — the
 * browser's only credential for this action is that session cookie, the
 * same as every other mutating route in this app.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "agent:halt", { windowMs: 60_000, maxRequests: 5 });
  if ("response" in guard) return guard.response;

  let secret: string;
  try {
    secret = getWebhookSecret();
  } catch (error) {
    console.error("POST /api/agent/halt: WEBHOOK_SECRET is not configured", error);
    return jsonServerError();
  }

  const body = JSON.stringify({ reason: "Emergency halt requested from the PFW agent dashboard" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeWebhookSignature(body, timestamp, secret);

  try {
    const response = await fetch(`${getPaperTraderServiceUrl()}/control/halt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: `sha256=${signature}`,
        [TIMESTAMP_HEADER]: timestamp,
      },
      body,
    });

    const result: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("POST /api/agent/halt: agent rejected the halt request", response.status, result);
      return NextResponse.json({ ok: false, error: "The agent rejected the halt request" }, { status: 502 });
    }

    return NextResponse.json({ ok: true, ...(typeof result === "object" && result !== null ? result : {}) });
  } catch (error) {
    console.error("POST /api/agent/halt: could not reach the Tier-0 agent", error);
    return NextResponse.json({ ok: false, error: "Could not reach the Tier-0 agent" }, { status: 502 });
  }
}
