"use client";

import { useRouter } from "next/navigation";
import { useState, type MouseEvent } from "react";
import { Badge, type BadgeVariant } from "../../../../components/badge/badge";
import { Spinner } from "../../../../components/spinner/spinner";

type Institution = { id: string; name: string; country: string; currency: string };
type Connection = {
  id: string;
  institutionId: string;
  institutionName: string;
  status: string;
  expiresAt: string;
  lastSyncedAt: string | null;
};

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  ACTIVE: "positive",
  EXPIRED: "warning",
  ERROR: "critical",
  REVOKED: "neutral",
};

/**
 * EU Open Banking PSD2 Ingestion (ad hoc) — connect/sync/unlink a MOCK
 * European institution. Named handler functions throughout, reading
 * `event.currentTarget.dataset.*` — never an inline arrow directly on a
 * button element, this codebase's repeatedly-hit focus-visible guard
 * trap (§3c bug #2 and many times since).
 *
 * No real bank is ever contacted — see `src/lib/banking/psd2-client.ts`'s
 * own doc comment for the honest scope.
 */
export function OpenBankingConnectionsPanel({
  institutions,
  initialConnections,
}: {
  institutions: readonly Institution[];
  initialConnections: readonly Connection[];
}) {
  const router = useRouter();
  const [connections, setConnections] = useState(initialConnections);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const connectedInstitutionIds = new Set(connections.map((c) => c.institutionId));

  async function handleConnect(event: MouseEvent<HTMLButtonElement>) {
    const institutionId = event.currentTarget.dataset.institutionId;
    if (!institutionId) return;
    setBusyId(institutionId);
    setError(null);
    setStatusMessage(null);
    try {
      const response = await fetch("/api/banking/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ institutionId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? "Connection failed — try again.");
      }
      setStatusMessage(`Connected to ${body.connection.institutionName}.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed — try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleSync(event: MouseEvent<HTMLButtonElement>) {
    const connectionId = event.currentTarget.dataset.id;
    if (!connectionId) return;
    setBusyId(connectionId);
    setError(null);
    setStatusMessage(null);
    try {
      const response = await fetch(`/api/banking/connections/${connectionId}/sync`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.message ?? body.error ?? "Sync failed — try again.");
      }
      setStatusMessage(`Synced: ${body.importedCount} new, ${body.duplicateCount} already up to date.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed — try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleUnlink(event: MouseEvent<HTMLButtonElement>) {
    const connectionId = event.currentTarget.dataset.id;
    if (!connectionId) return;
    setBusyId(connectionId);
    setError(null);
    setStatusMessage(null);
    try {
      const response = await fetch(`/api/banking/connections/${connectionId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to disconnect");
      setConnections((prev) => prev.filter((c) => c.id !== connectionId));
      setStatusMessage("Disconnected. Already-synced transactions were kept.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {statusMessage && <p className="text-sm text-positive">{statusMessage}</p>}
      {error && <p className="text-sm text-negative">{error}</p>}

      <section>
        <h2 className="text-sm font-semibold text-fg">Connected accounts</h2>
        {connections.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No European bank connections yet — connect one below.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {connections.map((connection) => (
              <li
                key={connection.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-bg px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium text-fg">{connection.institutionName}</p>
                  <p className="text-xs text-muted">
                    {connection.lastSyncedAt ? `Last synced ${new Date(connection.lastSyncedAt).toLocaleString()}` : "Never synced"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={STATUS_VARIANT[connection.status] ?? "neutral"}>{connection.status}</Badge>
                  <button
                    type="button"
                    data-id={connection.id}
                    onClick={handleSync}
                    disabled={busyId === connection.id || connection.status === "REVOKED"}
                    className="uv-btn-press flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {busyId === connection.id && <Spinner size="sm" />} Sync now
                  </button>
                  <button
                    type="button"
                    data-id={connection.id}
                    onClick={handleUnlink}
                    disabled={busyId === connection.id}
                    className="rounded-md px-2 py-1 text-xs text-negative hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-fg">Connect a European bank</h2>
        <p className="mt-1 text-xs text-muted">
          Simulated for demonstration only — no real bank is ever contacted, and no real financial data is transmitted.
        </p>
        <ul className="mt-2 flex flex-col gap-2">
          {institutions.map((institution) => {
            const alreadyConnected = connectedInstitutionIds.has(institution.id);
            return (
              <li
                key={institution.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-bg px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium text-fg">{institution.name}</p>
                  <p className="text-xs text-muted">
                    {institution.country} · {institution.currency}
                  </p>
                </div>
                <button
                  type="button"
                  data-institution-id={institution.id}
                  onClick={handleConnect}
                  disabled={alreadyConnected || busyId === institution.id}
                  className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {busyId === institution.id && <Spinner size="sm" />} {alreadyConnected ? "Connected" : "Connect"}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
