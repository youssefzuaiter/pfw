import "server-only";
import { cache } from "react";
import { listBankConnections } from "../dal/bank-connections";

export type OpenBankingSyncData = {
  connectionCount: number;
  activeCount: number;
  needsAttentionCount: number;
  mostRecentSyncIso: string | null;
};

/**
 * Assembles the dashboard's "Open Banking Sync" indicator (EU Open
 * Banking PSD2 Ingestion, ad hoc) — a glanceable summary only, same
 * deliberately-small pattern as `HouseholdSummary`/`DeadMansSwitchSummary`
 * (§3s/§3t): the dashboard's job is an overview, not a second copy of
 * the connection-management screen, which lives at
 * `/settings/open-banking`. `cache()`-wrapped for the same per-request-
 * only reason every other `build-*-data.ts` aggregator uses it (§3c).
 */
export const buildOpenBankingSyncData = cache(async (userId: string): Promise<OpenBankingSyncData> => {
  const connections = await listBankConnections(userId);

  const activeCount = connections.filter((connection) => connection.status === "ACTIVE").length;
  const needsAttentionCount = connections.length - activeCount;
  const mostRecentSyncIso = connections.reduce<string | null>((latest, connection) => {
    if (!connection.lastSyncedAt) return latest;
    const iso = connection.lastSyncedAt.toISOString();
    return !latest || iso > latest ? iso : latest;
  }, null);

  return { connectionCount: connections.length, activeCount, needsAttentionCount, mostRecentSyncIso };
});
