import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getCronSecret } from "../../../server/env";
import { syncExchangeRates } from "../../../server/currency/rate-sync";
import { syncCryptoPrices } from "../../../server/crypto/price-sync";
import { syncEquityQuotes } from "../../../server/market-data/quote-sync";
import { runInactivityCheck } from "../../../server/dead-mans-switch/inactivity-check";
import { deleteExpiredRateLimitBuckets } from "../../../server/dal/rate-limit-buckets";
import { runEncryptionKeyRotationSweep } from "../../../server/crypto/key-rotation";
import { getEncryptionKeyFingerprints } from "../../../server/crypto/field-encryption";
import { StaleDataError } from "../../../server/stale-data-error";
import { jsonForbidden, jsonServerError } from "../../../server/api/responses";
import { sendOperatorAlert } from "../../../server/ops/operator-alert";

/**
 * Vercel Cron & Notifications Engine (ad hoc) — the automated replacement
 * for hand-running `scripts/sync-exchange-rates.ts`,
 * `scripts/sync-crypto-prices.ts`, and `scripts/check-dead-mans-switch.ts`
 * (AGENTS.md §3l/§3w/§3t) from a terminal. Triggered by Vercel Cron per
 * `vercel.json`'s schedule — this route calls the exact same
 * request-independent functions those scripts already call, in the same
 * order those scripts document (FX, then crypto, then the Dead Man's
 * Switch inactivity check), never duplicating their logic.
 *
 * No user session exists for a cron-triggered request (Vercel calls this
 * with no cookies at all), so this is NOT `guardMutation`-fronted the way
 * every other mutating route in this app is — the trust boundary here is
 * entirely `CRON_SECRET`, matching Vercel's own documented convention:
 * when that env var is set on the project, Vercel automatically sends
 * `Authorization: Bearer <CRON_SECRET>` on every Cron-triggered request.
 * Compared in constant time (Section 2.3's `crypto.timingSafeEqual`
 * requirement) since — unlike Origin/Host in `verify-origin.ts` — this
 * really is a secret value, not a public one. Listed in `src/proxy.ts`'s
 * public-path allowlist for the same reason `/api/health`/`/api/health/ready`
 * are: a cron invocation carries no session and must never be redirected
 * to `/login`.
 *
 * Each job runs independently — one job failing (a Frankfurter/CoinGecko
 * outage, say) must never prevent the other two from running, the same
 * "a failed sync degrades, never blocks" resilience contract each job's
 * own manual script already documents. This route does not (yet) write
 * `Notification` rows from a job's outcome — the FX/crypto syncs update a
 * public, non-user-scoped table (`ExchangeRate`/`CryptoAssetPrice`) with
 * no natural single `userId` to notify, and wiring the Dead Man's
 * Switch's per-user transitions into a real alert is a genuine follow-up
 * scoping question (which event types warrant a notification, what the
 * message copy should say), not built speculatively here.
 */

type JobResult =
  | { ok: true }
  | { ok: false; error: string; staleData: boolean };

// What the rotation sweep reports beyond ok/failed. The key ids are
// public fingerprints (every `v2:` row stores one in plaintext); the
// counts are absent when the sweep failed before it could tally.
type RotationDetail = {
  inProgress: boolean;
  currentKeyId: string;
  nextKeyId: string | null;
  reencrypted?: number;
  remaining?: number;
  failed?: number;
};

async function runJob(name: string, job: () => Promise<{ ok: boolean; error?: string }>): Promise<JobResult> {
  try {
    const result = await job();
    if (!result.ok) {
      console.error(`cron: ${name} failed: ${result.error}`);
      return { ok: false, error: result.error ?? "unknown error", staleData: false };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof StaleDataError) {
      console.error(`cron: ${name} STALE-DATA CIRCUIT BREAKER TRIPPED: ${error.message}`);
      return { ok: false, error: error.message, staleData: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`cron: ${name} threw unexpectedly: ${message}`);
    return { ok: false, error: message, staleData: false };
  }
}

function isAuthorizedCronRequest(request: NextRequest): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${getCronSecret()}`;

  const headerBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);
  if (headerBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(headerBuffer, expectedBuffer);
}

export async function GET(request: NextRequest) {
  // `getCronSecret()` throws when CRON_SECRET is unset, and this call sits
  // OUTSIDE the try below — an unconfigured deployment surfaced that as an
  // unhandled framework-level 500 rather than a clear, logged
  // misconfiguration. Fails closed either way (never authorizes), but the
  // operator now gets a diagnosable message. Same shape
  // /api/webhooks/trades already uses for its own secret read.
  let authorized: boolean;
  try {
    authorized = isAuthorizedCronRequest(request);
  } catch (error) {
    console.error("GET /api/cron: CRON_SECRET is not configured", error);
    return jsonServerError();
  }

  if (!authorized) {
    return jsonForbidden("Invalid or missing cron secret");
  }

  try {
    const fxRateSync = await runJob("fx-rate-sync", syncExchangeRates);
    const cryptoPriceSync = await runJob("crypto-price-sync", syncCryptoPrices);
    // Latest market price for every trader-booked ticker the mock feed
    // can't price (AGENTS.md §3xx), via the agent's signed /control/quotes.
    const equityQuoteSync = await runJob("equity-quote-sync", async () => {
      const result = await syncEquityQuotes();
      if (result.ok) console.log(`cron: equity-quote-sync ok — synced=${result.synced.join(",") || "-"} skipped=${result.skipped.join(",") || "-"}`);
      return result;
    });

    let deadMansSwitchCheck: JobResult;
    try {
      const result = await runInactivityCheck();
      deadMansSwitchCheck = { ok: true };
      console.log(
        `cron: dead-mans-switch-check ok — movedToGracePeriod=${result.movedToGracePeriod.length} triggered=${result.triggered.length}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`cron: dead-mans-switch-check threw unexpectedly: ${message}`);
      deadMansSwitchCheck = { ok: false, error: message, staleData: false };
    }

    // Sweeps `RateLimitBucket` windows that have fully elapsed (see that
    // model's doc comment). Every check upserts its own row, so nothing
    // depends on this running — it only keeps the table from growing
    // without bound on a deployment that never restarts.
    const rateLimitCleanup = await runJob("rate-limit-cleanup", async () => {
      const removed = await deleteExpiredRateLimitBuckets();
      console.log(`cron: rate-limit-cleanup ok — removed=${removed}`);
      return { ok: true };
    });

    // A genuine no-op on every ordinary night (ENCRYPTION_KEY_NEXT
    // unset) — see src/server/crypto/key-rotation.ts's own doc comment.
    // The counts and key fingerprints ride along in the response, not
    // only the log: the operator deciding whether it's safe to cut
    // ENCRYPTION_KEY over reads this JSON from a manual trigger, and the
    // one real cutover mistake — the key on file not being the key the
    // rows are under — is exactly what `nextKeyId` lets them rule out
    // (see getEncryptionKeyFingerprints' doc comment) before it's
    // irreversible. The first production rotation shipped without these
    // and the answer had to be dug out of the runtime log.
    const rotation: { detail?: RotationDetail } = {};
    const rotationJob = await runJob("encryption-key-rotation-sweep", async () => {
      const result = await runEncryptionKeyRotationSweep();
      const keys = getEncryptionKeyFingerprints();
      rotation.detail = { inProgress: result.inProgress, currentKeyId: keys.current, nextKeyId: keys.next };
      if (!result.ok) return { ok: false, error: result.error };
      if (!result.inProgress) return { ok: true };

      rotation.detail = { ...rotation.detail, reencrypted: result.reencrypted, remaining: result.remaining, failed: result.failed };
      console.log(
        `cron: encryption-key-rotation-sweep ok — reencrypted=${result.reencrypted} remaining=${result.remaining} failed=${result.failed}`,
      );
      // The sweep itself completed, but a nonzero `failed` (an
      // individual row's re-encryption threw) is real, actionable
      // information during a live rotation — surfaced as a route-level
      // job failure so it reaches the operator alert, even though the
      // module's own `ok: true` correctly means "ran to completion, not
      // every row necessarily succeeded" (see that file's doc comment).
      if (result.failed > 0) {
        return { ok: false, error: `${result.failed} row(s) failed to re-encrypt this run (${result.remaining} still remaining)` };
      }
      return { ok: true };
    });
    const encryptionKeyRotation = { ...rotationJob, ...rotation.detail };

    const results = {
      fxRateSync,
      cryptoPriceSync,
      equityQuoteSync,
      deadMansSwitchCheck,
      rateLimitCleanup,
      encryptionKeyRotation,
    };

    // The one place a nightly failure reaches a human (AGENTS.md §3yy).
    // One email per run, every failed job listed, the stale-data breaker
    // named as such — and a no-op when OPERATOR_ALERT_EMAIL is unset.
    const failures = Object.entries(results).filter(([, r]) => !r.ok) as [string, Extract<JobResult, { ok: false }>][];
    let operatorAlert: "sent" | "not_configured" | "failed" | "not_needed" = "not_needed";
    if (failures.length > 0) {
      operatorAlert = await sendOperatorAlert({
        subject: `cron: ${failures.length} job(s) failed${failures.some(([, r]) => r.staleData) ? " — STALE-DATA BREAKER TRIPPED" : ""}`,
        lines: failures.map(([name, r]) => `${name}: ${r.staleData ? "[stale data] " : ""}${r.error}`),
      });
    }

    return NextResponse.json({ ...results, operatorAlert });
  } catch (error) {
    console.error("GET /api/cron failed unexpectedly", error);
    return jsonServerError();
  }
}
