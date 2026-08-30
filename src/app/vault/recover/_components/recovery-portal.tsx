"use client";

import { useState, type FormEvent } from "react";
import { Badge } from "../../../../components/badge/badge";
import { Spinner } from "../../../../components/spinner/spinner";

/** Mirrors src/server/dead-mans-switch/recovery-service.ts's RecoveryPortalStatus shape — defined locally, same convention as VaultDashboardProps. */
type PortalStatus =
  | { found: false }
  | {
      found: true;
      beneficiaryLabel: string;
      switchStatus: "ACTIVE" | "GRACE_PERIOD" | "TRIGGERED" | "RECOVERED";
      thresholdShares: number;
      totalShares: number;
      submittedShareCount: number;
      hasSubmitted: boolean;
    };

type RecoveredDocument = { id: string; title: string; plaintext: string };

export function RecoveryPortal({ token, initialStatus }: { token: string; initialStatus: PortalStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [share, setShare] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveredDocuments, setRecoveredDocuments] = useState<RecoveredDocument[] | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!share.trim()) {
      setError("Enter the share value you were given.");
      return;
    }

    setIsBusy(true);
    try {
      const response = await fetch(`/api/dead-mans-switch/recover/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ share: share.trim() }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error ?? "Failed to submit share");
      }

      if (body.status === "recovered") {
        setRecoveredDocuments(body.documents);
      } else if (body.status === "accepted_pending") {
        setStatus((prev) =>
          prev.found
            ? { ...prev, hasSubmitted: true, submittedShareCount: body.submittedCount }
            : prev,
        );
        setShare("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit share");
    } finally {
      setIsBusy(false);
    }
  }

  if (recoveredDocuments) {
    return (
      <section className="flex flex-col gap-4 rounded-lg border-2 border-positive bg-surface p-4">
        <Badge variant="positive">Vault recovered</Badge>
        <p className="text-sm text-muted">
          Enough beneficiaries submitted their shares. These documents are shown once — save them now.
        </p>
        <ul className="flex flex-col gap-3">
          {recoveredDocuments.map((doc) => (
            <li key={doc.id} className="rounded-md border border-border bg-bg p-3">
              <p className="text-sm font-medium text-fg">{doc.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{doc.plaintext}</p>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (!status.found) {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <p className="text-sm text-negative">This recovery link is invalid or has been revoked.</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <p className="text-sm text-fg">
        Hello, <span className="font-medium">{status.beneficiaryLabel}</span>.
      </p>

      {status.switchStatus !== "TRIGGERED" && status.switchStatus !== "RECOVERED" && (
        <p className="text-sm text-muted">
          This vault has not been opened for recovery yet — nothing to do here right now. Check back if you have
          reason to believe the owner is unreachable.
        </p>
      )}

      {status.switchStatus === "RECOVERED" && (
        <p className="text-sm text-muted">This vault has already been recovered by other beneficiaries.</p>
      )}

      {status.switchStatus === "TRIGGERED" && (
        <>
          <Badge variant="critical" pulse>
            Recovery open
          </Badge>
          <p className="text-sm text-muted">
            {status.submittedShareCount} of {status.thresholdShares} required shares submitted so far.
            {status.hasSubmitted && " Your share has already been recorded."}
          </p>
          <form onSubmit={handleSubmit} className="flex flex-col gap-2">
            <label htmlFor="recovery-share" className="text-xs font-medium text-muted">
              Your share value
            </label>
            <textarea
              id="recovery-share"
              rows={3}
              value={share}
              onChange={(event) => setShare(event.target.value)}
              className="rounded-md border border-border bg-bg px-2 py-1 font-tabular-figures text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="dms-share1:..."
            />
            <button
              type="submit"
              disabled={isBusy}
              className="uv-btn-press flex w-fit items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {isBusy && <Spinner />} Submit share
            </button>
            {error && <p className="text-xs text-negative">{error}</p>}
          </form>
        </>
      )}
    </section>
  );
}
