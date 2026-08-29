import "server-only";
import { withUserScope } from "../db/with-user-scope";

/**
 * The stateful half of the subscription radar (AGENTS.md §3p) — per-user,
 * per-merchant review/cancellation status. `merchantKey` here is always
 * the radar's canonical fuzzy-cluster key (src/lib/subscription-radar.ts),
 * not a raw per-transaction merchant string.
 */

export type SubscriptionStatusMap = ReadonlyMap<string, "ACTIVE" | "REVIEWED" | "CANCELLED">;

/**
 * Every tracked merchant's status for this user, as a lookup map. A
 * merchant absent from this map is implicitly ACTIVE — there's
 * deliberately no row created for every merchant the radar has ever
 * seen, only for ones the user has actually acted on, so this table
 * only ever grows with genuine user decisions, never with one throwaway
 * row per detected subscription regardless of whether the user touched
 * it.
 */
export async function getSubscriptionStatuses(userId: string): Promise<SubscriptionStatusMap> {
  const rows = await withUserScope(userId, (tx) =>
    tx.subscriptionTracking.findMany({ where: { userId }, select: { merchantKey: true, status: true } }),
  );
  return new Map(rows.map((row) => [row.merchantKey, row.status]));
}

export type SetSubscriptionStatusInput = { merchantKey: string; status: "ACTIVE" | "REVIEWED" | "CANCELLED" };

/**
 * Upserts one merchant's review status. Setting a merchant back to
 * ACTIVE deliberately still writes a row (rather than deleting it back
 * to "implicitly active") — an explicit "I marked this active again"
 * action is itself worth keeping as the merchant's current recorded
 * state, and the upsert-based implementation is simpler for having
 * exactly one code path regardless of which status is being set.
 */
export async function setSubscriptionStatus(userId: string, input: SetSubscriptionStatusInput) {
  return withUserScope(userId, (tx) =>
    tx.subscriptionTracking.upsert({
      where: { userId_merchantKey: { userId, merchantKey: input.merchantKey } },
      create: { userId, merchantKey: input.merchantKey, status: input.status },
      update: { status: input.status },
    }),
  );
}
