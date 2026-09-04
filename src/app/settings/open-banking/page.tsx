import Link from "next/link";
import { getCurrentUser } from "../../../server/auth/current-user";
import { listAvailableInstitutions, listBankConnections } from "../../../server/dal/bank-connections";
import { OpenBankingConnectionsPanel } from "./_components/open-banking-connections-panel";

export const instant = false;

/**
 * EU Open Banking PSD2 Ingestion (ad hoc) — the connection-management
 * screen. Reachable by direct link only (from `/settings` and the
 * dashboard's `OpenBankingSyncCard`), deliberately not added to
 * `PRIMARY_NAV_ITEMS`/`MobileNav` — same "sub-view, not one of the
 * spec's 9 primary destinations" pattern as `/vault`, `/analytics`,
 * `/trading/portfolio`.
 */
export default async function OpenBankingSettingsPage() {
  const user = await getCurrentUser();
  const connections = await listBankConnections(user.id);
  const institutions = listAvailableInstitutions();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
      <div>
        <Link href="/settings" className="text-xs text-muted underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          ← Settings
        </Link>
        <h1 className="mt-1 font-display text-2xl font-semibold text-fg">Open Banking</h1>
        <p className="mt-1 text-sm text-muted">
          Connect European bank accounts via a simulated PSD2-style API and sync their transactions automatically.
        </p>
      </div>

      <OpenBankingConnectionsPanel
        institutions={institutions}
        initialConnections={connections.map((connection) => ({
          id: connection.id,
          institutionId: connection.institutionId,
          institutionName: connection.institutionName,
          status: connection.status,
          expiresAt: connection.expiresAt.toISOString(),
          lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
