"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type MouseEvent } from "react";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";
import { DMS_PBKDF2_ITERATIONS } from "../../../lib/dead-mans-switch-crypto";
import {
  dmsVaultDecrypt,
  dmsVaultEncrypt,
  dmsVaultLock,
  dmsVaultResplit,
  dmsVaultRotate,
  dmsVaultUnlock,
} from "../../../lib/workers/dead-mans-switch-worker-client";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY));
}

// Same local, self-contained helpers vault-setup-wizard.tsx already
// defines for the same reason (an independent bearer token, unrelated to
// the vault key, has no reason to route through the crypto worker).
function randomTokenBase64Url(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  const [unlocked, setUnlocked] = useState(false);
  const [decrypted, setDecrypted] = useState<Record<string, string>>({});
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocContent, setNewDocContent] = useState("");
  const [addDocError, setAddDocError] = useState<string | null>(null);

  const [cancelError, setCancelError] = useState<string | null>(null);

  const [managementMode, setManagementMode] = useState<"none" | "rotate" | "beneficiaries">("none");

  const [rotateOldPassphrase, setRotateOldPassphrase] = useState("");
  const [rotateNewPassphrase, setRotateNewPassphrase] = useState("");
  const [rotateConfirmPassphrase, setRotateConfirmPassphrase] = useState("");
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotateDistribution, setRotateDistribution] = useState<{ label: string; share: string }[] | null>(null);

  const [beneficiaryLabels, setBeneficiaryLabels] = useState<string[]>(() => status.beneficiaries.map((b) => b.label));
  const [beneficiaryThreshold, setBeneficiaryThreshold] = useState(status.thresholdShares ?? 2);
  const [resplitPassphrase, setResplitPassphrase] = useState("");
  const [resplitError, setResplitError] = useState<string | null>(null);
  const [resplitDistribution, setResplitDistribution] = useState<
    { label: string; recoveryUrl: string; share: string }[] | null
  >(null);

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUnlockError(null);
    if (!status.salt || !status.iterations || !status.canaryCiphertext) return;

    setIsBusy(true);
    try {
      const { valid } = await dmsVaultUnlock(passphrase, status.salt, status.iterations, status.canaryCiphertext);
      if (!valid) {
        setUnlockError("Incorrect passphrase");
        return;
      }

      const nextDecrypted: Record<string, string> = {};
      for (const doc of status.documents) {
        nextDecrypted[doc.id] = (await dmsVaultDecrypt(doc.ciphertext)).plaintext;
      }

      setUnlocked(true);
      setDecrypted(nextDecrypted);
      setPassphrase("");
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : "Failed to unlock");
    } finally {
      setIsBusy(false);
    }
  }

  function handleLock() {
    void dmsVaultLock();
    setUnlocked(false);
    setDecrypted({});
  }

  async function handleAddDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddDocError(null);
    if (!unlocked) return;
    if (!newDocTitle.trim() || !newDocContent.trim()) {
      setAddDocError("Both a title and content are required.");
      return;
    }

    setIsBusy(true);
    try {
      const { ciphertext } = await dmsVaultEncrypt(newDocContent);
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

  function openRotate() {
    setRotateError(null);
    setManagementMode("rotate");
  }

  function openBeneficiaryManagement() {
    setResplitError(null);
    setBeneficiaryLabels(status.beneficiaries.map((b) => b.label));
    setBeneficiaryThreshold(status.thresholdShares ?? 2);
    setManagementMode("beneficiaries");
  }

  function closeManagement() {
    setManagementMode("none");
    setRotateError(null);
    setResplitError(null);
  }

  /**
   * Passphrase Rotation, Emergency Vault half (AGENTS.md §3t amendment,
   * item 1). Beneficiary labels/invite links are UNCHANGED by a
   * rotation — only the cryptographic material does — so `result.shares`
   * (in `splitSecret`'s deterministic array order) is zipped positionally
   * against `status.beneficiaries` (already ordered by shareIndex ASC,
   * the same order the original setup assigned shares in): each existing
   * beneficiary just needs their NEW share value to replace the old one,
   * paired with the recovery link they already have from setup.
   */
  async function handleRotateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRotateError(null);

    if (rotateNewPassphrase.length < 12) {
      setRotateError("New passphrase must be at least 12 characters.");
      return;
    }
    if (rotateNewPassphrase !== rotateConfirmPassphrase) {
      setRotateError("New passphrases don't match.");
      return;
    }
    if (!status.salt || !status.iterations || !status.canaryCiphertext || !status.totalShares || !status.thresholdShares) {
      return;
    }

    setIsBusy(true);
    try {
      const result = await dmsVaultRotate({
        oldPassphrase: rotateOldPassphrase,
        oldSaltBase64: status.salt,
        oldIterations: status.iterations,
        oldCanaryCiphertext: status.canaryCiphertext,
        newPassphrase: rotateNewPassphrase,
        newIterations: DMS_PBKDF2_ITERATIONS,
        totalShares: status.totalShares,
        thresholdShares: status.thresholdShares,
        documents: status.documents.map((d) => ({ id: d.id, ciphertext: d.ciphertext })),
      });

      if (!result.valid) {
        setRotateError("Current passphrase is incorrect");
        return;
      }

      const response = await fetch("/api/dead-mans-switch/rotate-passphrase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newSalt: result.newSalt,
          newIterations: DMS_PBKDF2_ITERATIONS,
          newCanaryCiphertext: result.newCanaryCiphertext,
          documents: result.documents,
          beneficiaries: status.beneficiaries.map((b, i) => ({
            id: b.id,
            shareIndex: result.shares[i].index,
            shareHash: result.shares[i].shareHash,
          })),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to rotate passphrase");
      }

      setRotateDistribution(status.beneficiaries.map((b, i) => ({ label: b.label, share: result.shares[i].encodedShare })));
      setRotateOldPassphrase("");
      setRotateNewPassphrase("");
      setRotateConfirmPassphrase("");
      setUnlocked(false);
      setDecrypted({});
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : "Failed to rotate passphrase");
    } finally {
      setIsBusy(false);
    }
  }

  function handleRotateDone() {
    setRotateDistribution(null);
    setManagementMode("none");
    router.refresh();
  }

  function updateBeneficiaryLabel(index: number, label: string) {
    setBeneficiaryLabels((prev) => prev.map((l, i) => (i === index ? label : l)));
  }

  function addBeneficiaryLabel() {
    setBeneficiaryLabels((prev) => [...prev, ""]);
  }

  function removeBeneficiaryLabel(index: number) {
    setBeneficiaryLabels((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setBeneficiaryThreshold((t) => Math.min(t, Math.max(2, next.length)));
      return next;
    });
  }

  function handleRemoveBeneficiaryLabelClick(event: MouseEvent<HTMLButtonElement>) {
    removeBeneficiaryLabel(Number(event.currentTarget.dataset.index));
  }

  /**
   * Dynamic Beneficiaries (AGENTS.md §3t amendment, item 2). Every entry
   * in the new roster — continuing or newly added — gets a genuinely
   * fresh invite token here, generated the exact same way
   * `vault-setup-wizard.tsx`'s own setup flow does: a resplit produces an
   * entirely new polynomial, so even a continuing beneficiary's OLD link
   * is void the moment this succeeds — see `updateVaultBeneficiaries`'s
   * DAL doc comment for why there is no "preserve the old link" path.
   */
  async function handleBeneficiariesSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResplitError(null);

    const labels = beneficiaryLabels.map((l) => l.trim());
    if (labels.length < 2) {
      setResplitError("Add at least 2 beneficiaries.");
      return;
    }
    if (labels.some((l) => l.length === 0)) {
      setResplitError("Every beneficiary needs a label.");
      return;
    }
    if (beneficiaryThreshold < 2 || beneficiaryThreshold > labels.length) {
      setResplitError(`Threshold must be between 2 and ${labels.length}.`);
      return;
    }
    if (!status.salt || !status.iterations || !status.canaryCiphertext) return;

    setIsBusy(true);
    try {
      const result = await dmsVaultResplit(
        resplitPassphrase,
        status.salt,
        status.iterations,
        status.canaryCiphertext,
        labels.length,
        beneficiaryThreshold,
      );

      if (!result.valid) {
        setResplitError("Current passphrase is incorrect");
        return;
      }

      const beneficiaryPayload = await Promise.all(
        result.shares.map(async (share, i) => {
          const rawToken = randomTokenBase64Url();
          const inviteTokenHash = await sha256Hex(new TextEncoder().encode(rawToken));
          return {
            label: labels[i],
            shareIndex: share.index,
            shareHash: share.shareHash,
            inviteTokenHash,
            rawToken,
            encodedShare: share.encodedShare,
          };
        }),
      );

      const response = await fetch("/api/dead-mans-switch/beneficiaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          totalShares: labels.length,
          thresholdShares: beneficiaryThreshold,
          beneficiaries: beneficiaryPayload.map((b) => ({
            label: b.label,
            shareIndex: b.shareIndex,
            shareHash: b.shareHash,
            inviteTokenHash: b.inviteTokenHash,
          })),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to update beneficiaries");
      }

      setResplitDistribution(
        beneficiaryPayload.map((b) => ({
          label: b.label,
          recoveryUrl: `${window.location.origin}/vault/recover/${b.rawToken}`,
          share: b.encodedShare,
        })),
      );
      setResplitPassphrase("");
    } catch (err) {
      setResplitError(err instanceof Error ? err.message : "Failed to update beneficiaries");
    } finally {
      setIsBusy(false);
    }
  }

  function handleResplitDone() {
    setResplitDistribution(null);
    setManagementMode("none");
    router.refresh();
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

        {status.status !== "ACTIVE" ? (
          <p className="mt-2 text-xs text-muted">
            Passphrase rotation and beneficiary changes are only available while the vault is Active — cancel any
            in-progress recovery first.
          </p>
        ) : managementMode === "none" ? (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
            <button
              type="button"
              onClick={openRotate}
              className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Rotate passphrase
            </button>
            <button
              type="button"
              onClick={openBeneficiaryManagement}
              className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Add / remove beneficiaries
            </button>
          </div>
        ) : managementMode === "rotate" ? (
          rotateDistribution ? (
            <div className="mt-3 flex flex-col gap-3 border-t border-negative border-t-2 pt-3">
              <p className="text-sm font-medium text-fg">New shares — distribute these now, they replace the old ones</p>
              <p className="text-xs text-muted">
                Each beneficiary&apos;s recovery link is unchanged — only give them their new share below to replace
                their old one. The old shares no longer work.
              </p>
              <ul className="flex flex-col gap-2">
                {rotateDistribution.map((packet) => (
                  <li key={packet.label} className="rounded-md border border-border bg-bg p-2">
                    <p className="text-sm font-medium text-fg">{packet.label}</p>
                    <p className="mt-1 break-all font-tabular-figures text-xs text-muted">New share: {packet.share}</p>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={handleRotateDone}
                className="uv-btn-press self-start rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                I&apos;ve distributed these — done
              </button>
            </div>
          ) : (
            <form onSubmit={handleRotateSubmit} className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="dms-rotate-old" className="text-xs font-medium text-muted">
                  Current passphrase
                </label>
                <input
                  id="dms-rotate-old"
                  type="password"
                  autoComplete="current-password"
                  value={rotateOldPassphrase}
                  onChange={(event) => setRotateOldPassphrase(event.target.value)}
                  className="w-48 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="dms-rotate-new" className="text-xs font-medium text-muted">
                  New passphrase
                </label>
                <input
                  id="dms-rotate-new"
                  type="password"
                  autoComplete="new-password"
                  value={rotateNewPassphrase}
                  onChange={(event) => setRotateNewPassphrase(event.target.value)}
                  className="w-48 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="dms-rotate-confirm" className="text-xs font-medium text-muted">
                  Confirm new passphrase
                </label>
                <input
                  id="dms-rotate-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={rotateConfirmPassphrase}
                  onChange={(event) => setRotateConfirmPassphrase(event.target.value)}
                  className="w-48 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <button
                type="submit"
                disabled={isBusy || !rotateOldPassphrase || !rotateNewPassphrase || !rotateConfirmPassphrase}
                className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {isBusy && <Spinner />} Rotate
              </button>
              <button
                type="button"
                onClick={closeManagement}
                className="rounded-md px-2 py-1.5 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
              <p className="w-full text-xs text-muted">
                Every document is decrypted with your current passphrase and re-encrypted with the new one, and every
                beneficiary&apos;s share is regenerated — entirely in your browser.
              </p>
              {rotateError && <p className="w-full text-xs text-negative">{rotateError}</p>}
            </form>
          )
        ) : resplitDistribution ? (
          <div className="mt-3 flex flex-col gap-3 border-t border-negative border-t-2 pt-3">
            <p className="text-sm font-medium text-fg">
              Distribute these now — every beneficiary&apos;s link and share are brand new
            </p>
            <p className="text-xs text-muted">
              This replaces the ENTIRE roster, including anyone who was already a beneficiary — their old link and
              share no longer work, even if their label is unchanged.
            </p>
            <ul className="flex flex-col gap-2">
              {resplitDistribution.map((packet) => (
                <li key={packet.label} className="rounded-md border border-border bg-bg p-2">
                  <p className="text-sm font-medium text-fg">{packet.label}</p>
                  <p className="mt-1 break-all font-tabular-figures text-xs text-muted">Link: {packet.recoveryUrl}</p>
                  <p className="mt-1 break-all font-tabular-figures text-xs text-muted">Share: {packet.share}</p>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={handleResplitDone}
              className="uv-btn-press self-start rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              I&apos;ve distributed these — done
            </button>
          </div>
        ) : (
          <form onSubmit={handleBeneficiariesSubmit} className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs font-medium text-muted">Beneficiaries</legend>
              {beneficiaryLabels.map((label, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder={`Beneficiary ${index + 1}`}
                    value={label}
                    onChange={(event) => updateBeneficiaryLabel(index, event.target.value)}
                    className="flex-1 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {beneficiaryLabels.length > 2 && (
                    <button
                      type="button"
                      data-index={index}
                      onClick={handleRemoveBeneficiaryLabelClick}
                      className="rounded-md px-2 py-1 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addBeneficiaryLabel}
                className="uv-btn-press self-start rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                + Add beneficiary
              </button>
            </fieldset>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="dms-resplit-threshold" className="text-xs font-medium text-muted">
                  Shares required to unlock
                </label>
                <input
                  id="dms-resplit-threshold"
                  type="number"
                  min={2}
                  max={beneficiaryLabels.length}
                  value={beneficiaryThreshold}
                  onChange={(event) => setBeneficiaryThreshold(Number(event.target.value))}
                  className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="dms-resplit-passphrase" className="text-xs font-medium text-muted">
                  Current passphrase
                </label>
                <input
                  id="dms-resplit-passphrase"
                  type="password"
                  autoComplete="current-password"
                  value={resplitPassphrase}
                  onChange={(event) => setResplitPassphrase(event.target.value)}
                  className="w-48 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <button
                type="submit"
                disabled={isBusy || !resplitPassphrase}
                className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {isBusy && <Spinner />} Re-split &amp; save
              </button>
              <button
                type="button"
                onClick={closeManagement}
                className="rounded-md px-2 py-1.5 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
            </div>
            <p className="text-xs text-muted">
              This re-splits your master key across the new roster above — every beneficiary, including anyone
              unchanged, gets a brand new link and share to replace their old one.
            </p>
            {resplitError && <p className="text-xs text-negative">{resplitError}</p>}
          </form>
        )}
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
              {unlocked ? (
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{decrypted[doc.id] ?? "…"}</p>
              ) : (
                <p className="mt-1 text-xs text-muted">Content locked — unlock below to view.</p>
              )}
            </li>
          ))}
        </ul>

        {unlocked ? (
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
