import "server-only";
import { createAdminClient } from "../db/admin-client";
import { recordNetWorthSnapshot } from "../dal/net-worth";

/**
 * Nightly net-worth snapshot for every user, run from GET /api/cron after
 * the FX, crypto and equity-quote syncs so each figure uses that night's
 * prices.
 *
 * An admin-client exception (allowlisted in
 * tests/guards/admin-client-boundary.test.ts), the same shape as
 * inactivity-check.ts and quote-sync.ts: a scheduled job has no session and
 * no single userId, and "which users exist" is exactly the cross-user read
 * RLS refuses. That one `findMany` of ids is all the admin client does here;
 * each figure is computed and written through the ordinary, user-scoped DAL.
 *
 * One user's failure (an unreachable wallet RPC, say) is logged and counted,
 * never fatal: everyone else still gets their snapshot. `ok: false` only when
 * the user list itself could not be read.
 */
export type NetWorthSnapshotJobResult =
  | { ok: true; recorded: number; failed: number }
  | { ok: false; error: string };

type Deps = {
  listUserIds: () => Promise<string[]>;
  record: (userId: string, now: Date) => Promise<unknown>;
};

async function listAllUserIds(): Promise<string[]> {
  const admin = createAdminClient();
  const users = await admin.user.findMany({ select: { id: true } });
  return users.map((u) => u.id);
}

const defaultDeps: Deps = { listUserIds: listAllUserIds, record: recordNetWorthSnapshot };

export async function recordDailyNetWorthSnapshots(
  now: Date = new Date(),
  deps: Deps = defaultDeps,
): Promise<NetWorthSnapshotJobResult> {
  let userIds: string[];
  try {
    userIds = await deps.listUserIds();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  let recorded = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      await deps.record(userId, now);
      recorded += 1;
    } catch (error) {
      failed += 1;
      console.error(`net-worth snapshot failed for one user: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: true, recorded, failed };
}
