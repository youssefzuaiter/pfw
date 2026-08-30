"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type MouseEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";
import { DMS_PBKDF2_ITERATIONS } from "../../../lib/dead-mans-switch-crypto";
import { dmsVaultEncrypt, dmsVaultSetup } from "../../../lib/workers/dead-mans-switch-worker-client";

const MIN_PASSPHRASE_LENGTH = 12;

type BeneficiaryDraft = { label: string };
type DocumentDraft = { title: string; content: string };

type DistributionPacket = { label: string; recoveryUrl: string; share: string };

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

/**
 * Setup wizard for the Emergency Vault (AGENTS.md §3t, §3x). Every
 * cryptographic operation — key derivation, splitting, document
 * encryption — happens client-side, before anything is sent to the
 * server, inside `dead-mans-switch-crypto.worker.ts`; this component
 * never holds the raw master key or an imported `CryptoKey` at all, only
 * the payloads the worker hands back (encoded shares, share hashes,
 * ciphertext). Invite tokens are the one thing still generated here
 * directly — they're independent random bearer tokens, not derived from
 * the vault key, so they have no reason to route through that worker.
 * None of this is ever sent to the server, written to browser storage, or
 * held anywhere after the user confirms they've distributed it
 * (`handleDone` simply discards this component's state by unmounting it
 * via `router.refresh()`).
 */
export function VaultSetupWizard() {
  const router = useRouter();

  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [beneficiaries, setBeneficiaries] = useState<BeneficiaryDraft[]>([{ label: "" }, { label: "" }]);
  const [thresholdShares, setThresholdShares] = useState(2);
  const [inactivityThresholdDays, setInactivityThresholdDays] = useState(90);
  const [gracePeriodDays, setGracePeriodDays] = useState(14);
  const [documents, setDocuments] = useState<DocumentDraft[]>([{ title: "", content: "" }]);

  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [distribution, setDistribution] = useState<DistributionPacket[] | null>(null);

  function updateBeneficiaryLabel(index: number, label: string) {
    setBeneficiaries((prev) => prev.map((b, i) => (i === index ? { label } : b)));
  }

  function addBeneficiary() {
    setBeneficiaries((prev) => [...prev, { label: "" }]);
  }

  function removeBeneficiary(index: number) {
    setBeneficiaries((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setThresholdShares((t) => Math.min(t, Math.max(2, next.length)));
      return next;
    });
  }

  // Named handlers reading event.currentTarget.dataset, not inline
  // onClick={() => ...} arrows on a button element — an inline arrow's "=>"
  // contains a literal ">" that trips tests/guards/focus-visible.test.ts's
  // regex-based heuristic, truncating the captured attributes before the
  // className that comes after it (documented repeatedly in AGENTS.md:
  // §3c bug #2, §3d, §3r, §3s — same trap, same fix, every time).
  function handleRemoveBeneficiaryClick(event: MouseEvent<HTMLButtonElement>) {
    removeBeneficiary(Number(event.currentTarget.dataset.index));
  }

  function handleRemoveDocumentClick(event: MouseEvent<HTMLButtonElement>) {
    removeDocument(Number(event.currentTarget.dataset.index));
  }

  function updateDocument(index: number, field: "title" | "content", value: string) {
    setDocuments((prev) => prev.map((d, i) => (i === index ? { ...d, [field]: value } : d)));
  }

  function addDocument() {
    setDocuments((prev) => [...prev, { title: "", content: "" }]);
  }

  function removeDocument(index: number) {
    setDocuments((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const labels = beneficiaries.map((b) => b.label.trim());
    if (labels.length < 2) {
      setError("Add at least 2 beneficiaries.");
      return;
    }
    if (labels.some((label) => label.length === 0)) {
      setError("Every beneficiary needs a label (e.g. a name or relationship).");
      return;
    }
    if (thresholdShares < 2 || thresholdShares > labels.length) {
      setError(`Threshold must be between 2 and ${labels.length}.`);
      return;
    }
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Recovery passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError("Passphrases don't match.");
      return;
    }
    const validDocuments = documents.filter((d) => d.title.trim().length > 0 && d.content.trim().length > 0);

    setIsBusy(true);
    try {
      const { salt, canaryCiphertext, shares } = await dmsVaultSetup(
        passphrase,
        DMS_PBKDF2_ITERATIONS,
        labels.length,
        thresholdShares,
      );

      const documentPayload = await Promise.all(
        validDocuments.map(async (d) => ({
          title: d.title.trim(),
          ciphertext: (await dmsVaultEncrypt(d.content)).ciphertext,
        })),
      );

      const beneficiaryPayload = await Promise.all(
        shares.map(async (share, i) => {
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

      const response = await fetch("/api/dead-mans-switch/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salt,
          iterations: DMS_PBKDF2_ITERATIONS,
          canaryCiphertext,
          totalShares: labels.length,
          thresholdShares,
          inactivityThresholdDays,
          gracePeriodDays,
          beneficiaries: beneficiaryPayload.map((b) => ({
            label: b.label,
            shareIndex: b.shareIndex,
            shareHash: b.shareHash,
            inviteTokenHash: b.inviteTokenHash,
          })),
          documents: documentPayload,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to set up the Emergency Vault");
      }

      setDistribution(
        beneficiaryPayload.map((b) => ({
          label: b.label,
          recoveryUrl: `${window.location.origin}/vault/recover/${b.rawToken}`,
          share: b.encodedShare,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set up the Emergency Vault");
    } finally {
      setIsBusy(false);
    }
  }

  function handleDone() {
    setDistribution(null);
    router.refresh();
  }

  if (distribution) {
    return (
      <section className="flex flex-col gap-4 rounded-lg border-2 border-negative bg-surface p-4">
        <h2 className="font-display text-lg font-semibold text-fg">Distribute these now — they will never be shown again</h2>
        <p className="text-sm text-muted">
          The server never stored your master passphrase, the raw key, or any of these shares. Give each beneficiary
          their own recovery link AND their own share value, through two different channels if possible (e.g. the
          link by email, the share printed on paper) — anyone with only one of the two cannot unlock anything.
        </p>
        <ul className="flex flex-col gap-3">
          {distribution.map((packet) => (
            <li key={packet.label} className="rounded-md border border-border bg-bg p-3">
              <p className="text-sm font-medium text-fg">{packet.label}</p>
              <p className="mt-1 break-all font-tabular-figures text-xs text-muted">Link: {packet.recoveryUrl}</p>
              <p className="mt-1 break-all font-tabular-figures text-xs text-muted">Share: {packet.share}</p>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={handleDone}
          className="uv-btn-press self-start rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          I&apos;ve saved these — continue
        </button>
      </section>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="dms-passphrase" className="text-xs font-medium text-muted">
          Recovery passphrase
        </label>
        <input
          id="dms-passphrase"
          type="password"
          autoComplete="new-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="dms-passphrase-confirm" className="text-xs font-medium text-muted">
          Confirm passphrase
        </label>
        <input
          id="dms-passphrase-confirm"
          type="password"
          autoComplete="new-password"
          value={confirmPassphrase}
          onChange={(event) => setConfirmPassphrase(event.target.value)}
          className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-muted">Beneficiaries</legend>
        {beneficiaries.map((b, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              type="text"
              placeholder={`Beneficiary ${index + 1} (e.g. "Spouse — Dana")`}
              value={b.label}
              onChange={(event) => updateBeneficiaryLabel(index, event.target.value)}
              className="flex-1 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {beneficiaries.length > 2 && (
              <button
                type="button"
                data-index={index}
                onClick={handleRemoveBeneficiaryClick}
                className="rounded-md px-2 py-1 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={addBeneficiary}
          className="uv-btn-press self-start rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          + Add beneficiary
        </button>
      </fieldset>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="dms-threshold" className="text-xs font-medium text-muted">
            Shares required to unlock
          </label>
          <input
            id="dms-threshold"
            type="number"
            min={2}
            max={beneficiaries.length}
            value={thresholdShares}
            onChange={(event) => setThresholdShares(Number(event.target.value))}
            className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="dms-inactivity" className="text-xs font-medium text-muted">
            Inactive days before grace period
          </label>
          <input
            id="dms-inactivity"
            type="number"
            min={1}
            value={inactivityThresholdDays}
            onChange={(event) => setInactivityThresholdDays(Number(event.target.value))}
            className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="dms-grace" className="text-xs font-medium text-muted">
            Grace period days
          </label>
          <input
            id="dms-grace"
            type="number"
            min={1}
            value={gracePeriodDays}
            onChange={(event) => setGracePeriodDays(Number(event.target.value))}
            className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-muted">Emergency documents (optional — you can add more later)</legend>
        {documents.map((d, index) => (
          <div key={index} className="flex flex-col gap-1 rounded-md border border-border p-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Title (e.g. Where the will is)"
                value={d.title}
                onChange={(event) => updateDocument(index, "title", event.target.value)}
                className="flex-1 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {documents.length > 1 && (
                <button
                  type="button"
                  data-index={index}
                  onClick={handleRemoveDocumentClick}
                  className="rounded-md px-2 py-1 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Remove
                </button>
              )}
            </div>
            <textarea
              placeholder="Content"
              rows={3}
              value={d.content}
              onChange={(event) => updateDocument(index, "content", event.target.value)}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        ))}
        <button
          type="button"
          onClick={addDocument}
          className="uv-btn-press self-start rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          + Add document
        </button>
      </fieldset>

      <p className="text-xs text-muted">
        This passphrase and every generated share exist only in your browser during setup. If forgotten, and fewer
        than the threshold of beneficiaries can be reached, the vault becomes permanently unrecoverable — the same
        honest trade-off every zero-knowledge scheme in this app makes.
      </p>

      {error && <p className="text-xs text-negative">{error}</p>}

      <button
        type="submit"
        disabled={isBusy}
        className="uv-btn-press flex w-fit items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isBusy && <Spinner />} Create vault
      </button>
    </form>
  );
}
