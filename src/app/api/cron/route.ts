import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getCronSecret } from "../../../server/env";
import { syncExchangeRates } from "../../../server/currency/rate-sync";
import { syncCryptoPrices } from "../../../server/crypto/price-sync";
import { runInactivityCheck } from "../../../server/dead-mans-switch/inactivity-check";
import { StaleDataError } from "../../../server/stale-data-error";
import { jsonForbidden, jsonServerError } from "../../../server/api/responses";

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
  if (!isAuthorizedCronRequest(request)) {
    return jsonForbidden("Invalid or missing cron secret");
  }

  try {
    const fxRateSync = await runJob("fx-rate-sync", syncExchangeRates);
    const cryptoPriceSync = await runJob("crypto-price-sync", syncCryptoPrices);

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

    return NextResponse.json({
      fxRateSync,
      cryptoPriceSync,
      deadMansSwitchCheck,
    });
  } catch (error) {
    console.error("GET /api/cron failed unexpectedly", error);
    return jsonServerError();
  }
}
