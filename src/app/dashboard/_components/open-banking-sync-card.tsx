import Link from "next/link";
import { Badge } from "../../../components/badge/badge";
import type { OpenBankingSyncData } from "../../../server/analytics/build-open-banking-sync-data";

/**
 * A compact "Open Banking Sync" card for the dashboard (EU Open Banking
 * PSD2 Ingestion, ad hoc) — just enough to see whether connections need
 * attention and jump into `/settings/open-banking`, where connecting/
 * syncing/disconnecting actually happens. Same deliberately-small
 * pattern as `DeadMansSwitchSummary`/`HouseholdSummary`.
 */
export function OpenBankingSyncCard({ data }: { data: OpenBankingSyncData }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="open-banking-sync-heading">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="open-banking-sync-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Open Banking Sync
        </h2>
        <Link
          href="/settings/open-banking"
          className="text-xs font-medium text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Manage →
        </Link>
      </div>
      {data.connectionCount === 0 ? (
        <p className="text-sm text-muted">
          No European bank connections yet.{" "}
          <Link
            href="/settings/open-banking"
            className="text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Connect an account
          </Link>{" "}
          to sync transactions automatically.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {data.needsAttentionCount === 0 ? (
            <Badge variant="positive">
              {data.connectionCount} connection{data.connectionCount === 1 ? "" : "s"} active
            </Badge>
          ) : (
            <Badge variant="warning" pulse>
              {data.needsAttentionCount} of {data.connectionCount} need{data.needsAttentionCount === 1 ? "s" : ""} attention
            </Badge>
          )}
          {data.mostRecentSyncIso && (
            <span className="text-xs text-muted">last synced {new Date(data.mostRecentSyncIso).toLocaleString()}</span>
          )}
        </div>
      )}
    </section>
  );
}
