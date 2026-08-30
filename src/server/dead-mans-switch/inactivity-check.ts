import "server-only";
import { createAdminClient } from "../db/admin-client";

/**
 * The Activity Monitor's batch half (AGENTS.md §3t) — scans EVERY user's
 * DeadMansSwitch row and advances its lifecycle based on elapsed time.
 * This is a FOURTH, distinct admin-client exception (alongside
 * current-user.ts, invite-admin-ops.ts, and this feature's own
 * recovery-admin-ops.ts) — allowlisted separately in
 * tests/guards/admin-client-boundary.test.ts — because a scheduled batch
 * job has no authenticated request, and therefore no single `userId`, to
 * scope a `withUserScope` transaction by at all: it has to look across
 * every user's switch in one pass, which is precisely what RLS is
 * designed to prevent a normal request from doing.
 *
 * Deliberately request-independent, like the exchange-rate sync
 * (src/server/currency/rate-sync.ts, §3l) — this module is called by
 * scripts/check-dead-mans-switch.ts (manual or cron), never by an HTTP
 * route; nothing in this app runs scheduled jobs on its own, so "how
 * often does this actually run" is a deployment-configuration decision,
 * not something enforced in code.
 *
 * Lifecycle: ACTIVE -> GRACE_PERIOD once `inactivityThresholdDays` have
 * elapsed since `lastActivityAt`; GRACE_PERIOD -> TRIGGERED once
 * `gracePeriodDays` have ALSO elapsed since `graceStartedAt`. Both
 * transitions are idempotent to re-running this check repeatedly (a
 * switch already in GRACE_PERIOD/TRIGGERED is left alone unless its own
 * next threshold is crossed) — see the real-time equivalent of the
 * GRACE_PERIOD -> ACTIVE reversal in
 * src/server/auth/current-user.ts's activity touch, and the TRIGGERED ->
 * ACTIVE reversal in src/server/dal/dead-mans-switch.ts's
 * `cancelRecovery` — this module only ever moves a switch FORWARD.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type InactivityCheckResult = {
  movedToGracePeriod: string[]; // DeadMansSwitch ids
  triggered: string[]; // DeadMansSwitch ids
};

export async function runInactivityCheck(now: Date = new Date()): Promise<InactivityCheckResult> {
  const admin = createAdminClient();
  const result: InactivityCheckResult = { movedToGracePeriod: [], triggered: [] };

  const activeSwitches = await admin.deadMansSwitch.findMany({ where: { status: "ACTIVE" } });
  for (const switchRow of activeSwitches) {
    const elapsedMs = now.getTime() - switchRow.lastActivityAt.getTime();
    if (elapsedMs >= switchRow.inactivityThresholdDays * MS_PER_DAY) {
      await admin.deadMansSwitch.update({
        where: { id: switchRow.id },
        data: { status: "GRACE_PERIOD", graceStartedAt: now },
      });
      result.movedToGracePeriod.push(switchRow.id);
    }
  }

  const graceSwitches = await admin.deadMansSwitch.findMany({ where: { status: "GRACE_PERIOD" } });
  for (const switchRow of graceSwitches) {
    if (!switchRow.graceStartedAt) continue; // invariant: always set when entering GRACE_PERIOD, above.
    const elapsedMs = now.getTime() - switchRow.graceStartedAt.getTime();
    if (elapsedMs >= switchRow.gracePeriodDays * MS_PER_DAY) {
      await admin.deadMansSwitch.update({
        where: { id: switchRow.id },
        data: { status: "TRIGGERED", triggeredAt: now },
      });
      result.triggered.push(switchRow.id);
    }
  }

  return result;
}
