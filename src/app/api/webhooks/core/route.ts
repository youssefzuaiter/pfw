import { NextResponse, type NextRequest } from "next/server";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhookSignature } from "../../../../lib/webhook-signature";
import { jsonBadRequest, jsonForbidden, jsonServerError } from "../../../../server/api/responses";
import { CoreMirrorUnavailableError, ingestCoreJournal, recordCoreReport } from "../../../../server/dal/core-mirror";
import { getWebhookSecret } from "../../../../server/env";
import { CoreSyncPayloadSchema } from "../../../../server/paper-trader/core-sync-schema";
import { resolvePaperTradingUser } from "../../../../server/paper-trader/resolve-paper-trading-user";

/**
 * The long-term core's mirror (AGENTS.md §3fff): signed pushes from the
 * core router (`~/paper-trader`'s `risk_router/core_sync.py`) of its
 * append-only journal and its latest self-report. Two kinds of request,
 * one endpoint — see `core-sync-schema.ts` for the contract.
 *
 * Same trust boundary, for the same reasons, as `/api/webhooks/trades`
 * (whose doc comment explains why a public endpoint with a real caller
 * holding a real shared secret is acceptable where §3oo's PSD2 webhook,
 * with no real caller, was not): there is no user session — the router
 * is a separate process — so the whole authentication is the HMAC-SHA256
 * over the raw bytes, verified BEFORE a single field of them is read,
 * and the route is on the proxy's public allowlist for that reason. The
 * target account comes from server configuration
 * (`resolvePaperTradingUser`), never from the body, so one leaked secret
 * can write the paper-trading account's mirror and nothing else.
 *
 * What is different here, and shapes every status code below:
 *
 * - **This is a mirror, not a ledger.** Nothing here books a trade, moves
 *   a balance, or reaches net worth; the core's paper account stays out of
 *   every aggregate in this app. A forged request could therefore only
 *   mislead what the page SHOWS — which is also why it is signed with the
 *   existing `WEBHOOK_SECRET` rather than a fourth secret — and cannot
 *   approve, halt or trade anything: this app holds no credential for the
 *   core router at all.
 * - **The router's journal is its own outbox.** The router sends from a
 *   cursor and advances it only on a success response, so a response must
 *   tell it the truth about what is now stored (`next_index`) and must
 *   never look like success when something was not stored. A 2xx means
 *   "stored or already stored"; a 409 `gap` means "I am further behind
 *   than your cursor — rewind to `next_index`" (a restored database); a
 *   409 `chain_conflict` means two versions of one entry would exist and
 *   a person has to look; a 503 means "not now" (no account configured,
 *   or the migration has not been applied) and the router simply tries
 *   again, losing nothing.
 *
 * Idempotency needs no key lookup: a journal entry is identified by its
 * position in its chain, and storing it is `ON CONFLICT DO NOTHING`, so a
 * replay is a no-op by construction. The request's `X-Idempotency-Key`
 * header is accepted and ignored.
 */
export async function POST(request: NextRequest) {
  // Raw bytes first, before anything can reinterpret them.
  const rawBody = await request.text();

  let secret: string;
  try {
    secret = getWebhookSecret();
  } catch (error) {
    console.error("POST /api/webhooks/core: WEBHOOK_SECRET is not configured", error);
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
    // unauthenticated caller which part it got wrong is free oracle
    // access it has no need for.
    console.warn(`POST /api/webhooks/core: rejected request (${verification.reason})`);
    return jsonForbidden("Invalid signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = CoreSyncPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonBadRequest("Invalid core sync payload", parsed.error.issues);
  }
  const message = parsed.data;

  const target = await resolvePaperTradingUser();
  if (target.status !== "ok") {
    console.error(
      `POST /api/webhooks/core: paper-trading user ${target.status}` +
        (target.status === "missing" ? ` (${target.configured} matches no User row)` : " (set PAPER_TRADING_USER_EMAIL)"),
    );
    return NextResponse.json(
      { error: "paper_trading_user_unresolved", detail: "PFW has no valid paper-trading account configured" },
      { status: 503 },
    );
  }
  const userId = target.userId;

  try {
    if (message.kind === "report") {
      const result = await recordCoreReport(userId, message);
      return NextResponse.json(
        { ok: true, status: result.status, ...(result.status === "recorded" ? { snapshot_stored: result.snapshotStored } : {}) },
        { status: result.status === "recorded" ? 201 : 200 },
      );
    }

    const result = await ingestCoreJournal(userId, {
      chainId: message.chain_id,
      entries: message.entries.map((entry) => ({ index: entry.index, hash: entry.hash, prev: entry.prev, raw: entry.raw })),
    });

    switch (result.status) {
      case "recorded":
      case "duplicate":
        return NextResponse.json(
          {
            ok: true,
            status: result.status,
            chain_id: message.chain_id,
            accepted: result.accepted,
            duplicates: result.duplicates,
            next_index: result.nextIndex,
          },
          { status: result.status === "recorded" ? 201 : 200 },
        );
      case "gap":
        return NextResponse.json({ ok: false, error: "gap", next_index: result.nextIndex }, { status: 409 });
      case "conflict":
        return NextResponse.json(
          { ok: false, error: "chain_conflict", index: result.index, detail: result.detail },
          { status: 409 },
        );
      case "invalid":
        return NextResponse.json({ ok: false, error: "invalid_entry", detail: result.detail }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof CoreMirrorUnavailableError) {
      return NextResponse.json(
        { ok: false, error: "core_mirror_unavailable", detail: "The core mirror is not set up on this deployment yet" },
        { status: 503 },
      );
    }
    console.error("POST /api/webhooks/core failed", error);
    return jsonServerError();
  }
}
