import "server-only";
import { createAdminClient } from "../db/admin-client";
import { getPaperTradingUserEmail, getPaperTradingUserId } from "../env";

/**
 * Resolves WHICH user the Tier-0 agent's signed receipts are booked
 * against (`PAPER_TRADING_USER_EMAIL`, or the legacy
 * `PAPER_TRADING_USER_ID` — see `env.ts` for why email is preferred).
 *
 * One of this app's few admin-client (RLS-bypassing) exceptions, and a
 * documented one — allowlisted in `tests/guards/admin-client-boundary.test.ts`
 * with the same justification as `invite-admin-ops.ts`/`webauthn-admin-ops.ts`:
 * the callers (`POST /api/webhooks/trades`, `/metrics`, and the
 * `GET /api/agent/health` status probe) run for a MACHINE caller with no
 * session at all, or for a signed-in user who is not necessarily the
 * paper-trading account. `User`'s RLS SELECT policy is "yourself, or
 * someone who shares a household with you" — a `withUserScope` lookup of
 * a different account would resolve to `null` and read as "missing"
 * when the account exists. Looking up ONE row by a value this server's
 * own environment supplied (never request input) is the entire
 * privilege this module exercises; it never writes.
 *
 * Cached in-process for `CACHE_TTL_MS` (same shape as `current-user.ts`'s
 * activity-touch debounce) so a burst of receipts doesn't cost a lookup
 * each — a `missing` result is cached too, so a misconfiguration can't
 * hammer the database either.
 */
export type PaperTradingUserResolution =
  | { status: "ok"; userId: string }
  | { status: "missing"; configured: string }
  | { status: "unconfigured" };

const CACHE_TTL_MS = 60_000;
let cached: { at: number; value: PaperTradingUserResolution } | null = null;

export async function resolvePaperTradingUser(): Promise<PaperTradingUserResolution> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const value = await lookup();
  cached = { at: now, value };
  return value;
}

async function lookup(): Promise<PaperTradingUserResolution> {
  const email = getPaperTradingUserEmail();
  const legacyId = getPaperTradingUserId();
  if (!email && !legacyId) return { status: "unconfigured" };

  const admin = createAdminClient();
  try {
    if (email) {
      const byEmail = await admin.user.findUnique({ where: { email }, select: { id: true } });
      if (byEmail) return { status: "ok", userId: byEmail.id };
      return { status: "missing", configured: `PAPER_TRADING_USER_EMAIL=${email}` };
    }
    const byId = await admin.user.findUnique({ where: { id: legacyId! }, select: { id: true } });
    if (byId) return { status: "ok", userId: byId.id };
    return { status: "missing", configured: `PAPER_TRADING_USER_ID=${legacyId}` };
  } finally {
    await admin.$disconnect();
  }
}

/** Test-only: drops the cached resolution so a test that changes the environment sees the change immediately. */
export function _resetPaperTradingUserCacheForTests(): void {
  cached = null;
}
