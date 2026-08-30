"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type MouseEvent } from "react";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";
import {
  decryptVaultValue,
  deriveVaultKeyBytes,
  encryptVaultValue,
  importVaultAesKey,
  verifyVaultKey,
} from "../../../lib/dead-mans-switch-crypto";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/** Mirrors src/server/dal/dead-mans-switch.ts's VaultStatus shape, defined locally rather than imported — same "a Client Component defines its own prop type instead of importing one from a server-only file" convention src/app/goals/_components/secure-notes-panel.tsx already follows. */
type VaultDashboardProps = {
  status: "ACTIVE" | "GRACE_PERIOD" | "TRIGGERED" | "RECOVERED" | null;
  inactivityThresholdDays: number | null;
  gracePeriodDays: number | null;
  lastActivityAt: Date | null;
  graceStartedAt: Date | null;
  totalShares: number | null;
  thresholdShares: number | null;
  salt: string | null;
  iterations: number | null;
  canaryCiphertext: string | null;
  beneficiaries: { id: string; label: string; shareIndex: number }[];
  documents: { id: string; title: string; ciphertext: string }[];
  submittedShareCount: number;
};

export function VaultDashboard({ status }: { status: VaultDashboardProps }) {
  const router = useRouter();

  const [passphrase, setPassphrase] = useState("");
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [decrypted, setDecrypted] = useState<Record<string, string>>({});
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocContent, setNewDocContent] = useState("");
  const [addDocError, setAddDocError] = useState<string | null>(null);

  const [cancelError, setCancelError] = useState<string | null>(null);

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUnlockError(null);
    if (!status.salt || !status.iterations || !status.canaryCiphertext) return;

    setIsBusy(true);
    try {
      const rawKey = await deriveVaultKeyBytes(passphrase, status.salt, status.iterations);
      const candidateKey = await importVaultAesKey(rawKey);
      const isCorrect = await verifyVaultKey(candidateKey, status.canaryCiphertext);
      if (!isCorrect) {
        setUnlockError("Incorrect passphrase");
        return;
      }

      const nextDecrypted: Record<string, string> = {};
      for (const doc of status.documents) {
        nextDecrypted[doc.id] = await decryptVaultValue(candidateKey, doc.ciphertext);
      }

      setKey(candidateKey);
      setDecrypted(nextDecrypted);
      setPassphrase("");
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : "Failed to unlock");
    } finally {
      setIsBusy(false);
    }
  }

  function handleLock() {
    setKey(null);
    setDecrypted({});
  }

  async function handleAddDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddDocError(null);
    if (!key) return;
    if (!newDocTitle.trim() || !newDocContent.trim()) {
      setAddDocError("Both a title and content are required.");
      return;
    }

    setIsBusy(true);
    try {
      const ciphertext = await encryptVaultValue(key, newDocContent);
      const response = await fetch("/api/dead-mans-switch/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newDocTitle.trim(), ciphertext }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to add document");
      }

      setNewDocTitle("");
      setNewDocContent("");
      router.refresh();
    } catch (err) {
      setAddDocError(err instanceof Error ? err.message : "Failed to add document");
    } finally {
      setIsBusy(false);
    }
  }

  // Named handler reading event.currentTarget.dataset.documentId, not an
  // inline onClick={() => ...} arrow on a button element — see
  // vault-setup-wizard.tsx's matching comment for why (the documented
  // "=>"-truncates-the-focus-visible-guard's-regex trap).
  function handleDeleteDocumentClick(event: MouseEvent<HTMLButtonElement>) {
    const documentId = event.currentTarget.dataset.documentId;
    if (documentId) void handleDeleteDocument(documentId);
  }

  async function handleDeleteDocument(documentId: string) {
    setIsBusy(true);
    try {
      const response = await fetch(`/api/dead-mans-switch/documents/${documentId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete document");
      router.refresh();
    } catch {
      // Silently ignored beyond the refreshed list still showing the row —
      // consistent with this app's other lightweight delete controls.
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCancelRecovery() {
    setCancelError(null);
    setIsBusy(true);
    try {
      const response = await fetch("/api/dead-mans-switch/cancel-recovery", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to cancel recovery");
      }
      router.refresh();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Failed to cancel recovery");
    } finally {
      setIsBusy(false);
    }
  }

  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={status.status} />
          {status.status === "ACTIVE" && status.lastActivityAt && status.inactivityThresholdDays && (
            <p className="text-sm text-muted">
              Last activity {status.lastActivityAt.toLocaleDateString()}. Viewing this page counts as activity —
              enters a grace period after {status.inactivityThresholdDays} days of inactivity.
            </p>
          )}
          {status.status === "GRACE_PERIOD" && status.graceStartedAt && status.gracePeriodDays && (
            <p className="text-sm text-muted">
              Grace period started {status.graceStartedAt.toLocaleDateString()} —{" "}
              {daysBetween(now, new Date(status.graceStartedAt.getTime() + status.gracePeriodDays * MS_PER_DAY))} day(s)
              left before beneficiaries can begin recovery.
            </p>
          )}
          {status.status === "TRIGGERED" && (
            <p className="text-sm text-negative">
              Recovery is open. {status.submittedShareCount} of {status.thresholdShares} required shares submitted so
              far.
            </p>
          )}
          {status.status === "RECOVERED" && <p className="text-sm text-muted">Beneficiaries have recovered this vault.</p>}
        </div>

        {status.status === "TRIGGERED" && (
          <div className="mt-3">
            <button
              type="button"
              disabled={isBusy}
              onClick={handleCancelRecovery}
              className="uv-btn-press rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {isBusy && <Spinner />} I&apos;m safe — cancel recovery
            </button>
            {cancelError && <p className="mt-1 text-xs text-negative">{cancelError}</p>}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Beneficiaries ({status.thresholdShares} of {status.totalShares} needed)
        </h2>
        <ul className="mt-2 flex flex-col gap-1">
          {status.beneficiaries.map((b) => (
            <li key={b.id} className="text-sm text-fg">
              {b.label} <span className="text-xs text-muted">(share #{b.shareIndex})</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">
          Beneficiaries can&apos;t be added or removed after setup — doing so would require re-splitting the key and
          redistributing every share from scratch.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">Emergency documents</h2>

        {status.documents.length === 0 && <p className="text-sm text-muted">No documents yet.</p>}
        <ul className="flex flex-col gap-2">
          {status.documents.map((doc) => (
            <li key={doc.id} className="rounded-md border border-border p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-fg">{doc.title}</p>
                <button
                  type="button"
                  data-document-id={doc.id}
                  onClick={handleDeleteDocumentClick}
                  className="rounded-md px-2 py-1 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Delete
                </button>
              </div>
              {key ? (
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{decrypted[doc.id] ?? "…"}</p>
              ) : (
                <p className="mt-1 text-xs text-muted">Content locked — unlock below to view.</p>
              )}
            </li>
          ))}
        </ul>

        {key ? (
          <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3">
            <div className="flex items-center gap-2">
              <Badge variant="positive">Unlocked</Badge>
              <button
                type="button"
                onClick={handleLock}
                className="uv-btn-press ml-auto rounded-md border border-border px-2 py-1 text-xs font-medium text-muted hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Lock
              </button>
            </div>
            <form onSubmit={handleAddDocument} className="flex flex-col gap-2">
              <input
                type="text"
                placeholder="Title"
                value={newDocTitle}
                onChange={(event) => setNewDocTitle(event.target.value)}
                className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <textarea
                placeholder="Content"
                rows={3}
                value={newDocContent}
                onChange={(event) => setNewDocContent(event.target.value)}
                className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="submit"
                disabled={isBusy}
                className="uv-btn-press flex w-fit items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {isBusy && <Spinner />} Add document
              </button>
              {addDocError && <p className="text-xs text-negative">{addDocError}</p>}
            </form>
          </div>
        ) : (
          <form onSubmit={handleUnlock} className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="dms-unlock-passphrase" className="text-xs font-medium text-muted">
                Recovery passphrase
              </label>
              <input
                id="dms-unlock-passphrase"
                type="password"
                autoComplete="current-password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                className="w-48 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <button
              type="submit"
              disabled={isBusy || !passphrase}
              className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {isBusy && <Spinner />} Unlock
            </button>
            {unlockError && <p className="text-xs text-negative">{unlockError}</p>}
          </form>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: VaultDashboardProps["status"] }) {
  switch (status) {
    case "ACTIVE":
      return <Badge variant="positive">Active — sealed</Badge>;
    case "GRACE_PERIOD":
      return (
        <Badge variant="warning" pulse>
          Grace period
        </Badge>
      );
    case "TRIGGERED":
      return (
        <Badge variant="critical" pulse>
          Recovery open
        </Badge>
      );
    case "RECOVERED":
      return <Badge variant="neutral">Recovered</Badge>;
    default:
      return null;
  }
}
