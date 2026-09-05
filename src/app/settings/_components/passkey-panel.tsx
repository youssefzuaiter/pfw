"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState, type ChangeEvent, type FormEvent, type MouseEvent } from "react";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";
import { RecoveryCodesReveal } from "./recovery-codes-reveal";

type AuthenticatorSummary = {
  id: string;
  deviceLabel: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAtIso: string;
  lastUsedAtIso: string | null;
};

/**
 * Device-Bound Biometrics via Passkeys (ad hoc) — registering and
 * managing passkeys from Settings. Named handler functions throughout,
 * never an inline arrow directly on a button element — this codebase's
 * focus-visible guard test regex reads the literal `>` inside `=>` as
 * the tag's own closing bracket and truncates everything after it, a
 * documented, repeatedly-hit trap (AGENTS.md §3c bug #2, hit again many
 * times since, most recently `household-admin-panel.tsx`).
 *
 * "Device-bound" is accurate for a platform authenticator tied to one
 * device, but a passkey CAN be a synced, multi-device credential —
 * `backedUp`/`deviceType` (from `Authenticator`'s own stored fields,
 * §"Phase 1") are shown honestly rather than the panel overclaiming
 * "device-bound" for a credential that may in fact be synced across a
 * user's devices via iCloud Keychain or Google Password Manager.
 */
export function PasskeyPanel() {
  const [authenticators, setAuthenticators] = useState<AuthenticatorSummary[] | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  function handleAcknowledgeRecoveryCodes() {
    setRecoveryCodes(null);
  }

  useEffect(() => {
    void (async () => {
      try {
        const { browserSupportsWebAuthn } = await import("@simplewebauthn/browser");
        setIsSupported(browserSupportsWebAuthn());
      } catch {
        setIsSupported(false);
      }
      await loadAuthenticators();
    })();
  }, []);

  async function loadAuthenticators() {
    try {
      const response = await fetch("/api/auth/webauthn/authenticators");
      if (!response.ok) throw new Error("Failed to load passkeys");
      const data = await response.json();
      setAuthenticators(data.authenticators);
    } catch {
      setAuthenticators([]);
    }
  }

  function handleOpenAdd() {
    setError(null);
    setIsAdding(true);
  }

  function handleCancelAdd() {
    setIsAdding(false);
    setNewLabel("");
    setError(null);
  }

  function handleLabelChange(event: ChangeEvent<HTMLInputElement>) {
    setNewLabel(event.target.value);
  }

  async function handleAddPasskey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const optionsResponse = await fetch("/api/auth/webauthn/register-options", { method: "POST" });
      if (!optionsResponse.ok) throw new Error("Failed to start passkey registration");
      const { options, challengeId } = await optionsResponse.json();

      // Triggers the browser's native biometric/PIN prompt. The private
      // key is generated and held by the authenticator itself — nothing
      // biometric ever reaches this code or the server; only the signed
      // response below does.
      const registrationResponse = await startRegistration(options);

      const verifyResponse = await fetch("/api/auth/webauthn/register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, response: registrationResponse, deviceLabel: newLabel.trim() || "Passkey" }),
      });
      if (!verifyResponse.ok) {
        const body = await verifyResponse.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to add passkey");
      }
      const verifyBody = await verifyResponse.json().catch(() => ({}));

      setStatusMessage("Passkey added.");
      setNewLabel("");
      setIsAdding(false);
      if (Array.isArray(verifyBody.recoveryCodes)) setRecoveryCodes(verifyBody.recoveryCodes);
      await loadAuthenticators();
    } catch (err) {
      // A user dismissing the native prompt throws too — worth a plain
      // message rather than exposing the browser's own error text.
      setError(err instanceof Error && err.name !== "NotAllowedError" ? err.message : "Passkey setup was cancelled or failed.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRemove(event: MouseEvent<HTMLButtonElement>) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    setIsBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const response = await fetch(`/api/auth/webauthn/authenticators/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to remove passkey");
      setStatusMessage("Passkey removed.");
      await loadAuthenticators();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove passkey");
    } finally {
      setIsBusy(false);
    }
  }

  if (!isSupported) {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <h3 className="text-sm font-semibold text-fg">Passkeys</h3>
        <p className="mt-1 text-xs text-muted">Your browser doesn&rsquo;t support passkeys.</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">Passkeys</h3>
        {!isAdding && (
          <button
            type="button"
            onClick={handleOpenAdd}
            disabled={isBusy}
            className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border px-3 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Add a passkey
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        Sign in with your device&rsquo;s fingerprint, face, or PIN — no password needed. The private key never leaves
        your device; nothing biometric is ever sent here.
      </p>

      {isAdding && (
        <form onSubmit={handleAddPasskey} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="passkey-label" className="text-xs font-medium text-muted">
              Label (optional)
            </label>
            <input
              id="passkey-label"
              type="text"
              placeholder="e.g. MacBook Touch ID"
              value={newLabel}
              onChange={handleLabelChange}
              className="w-56 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <button
            type="submit"
            disabled={isBusy}
            className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {isBusy && <Spinner />} Continue
          </button>
          <button
            type="button"
            onClick={handleCancelAdd}
            disabled={isBusy}
            className="rounded-md px-2 py-1.5 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Cancel
          </button>
        </form>
      )}

      {statusMessage && <p className="mt-2 text-xs text-positive">{statusMessage}</p>}
      {error && <p className="mt-2 text-xs text-negative">{error}</p>}
      {recoveryCodes && <RecoveryCodesReveal codes={recoveryCodes} onAcknowledge={handleAcknowledgeRecoveryCodes} />}

      <ul className="mt-3 flex flex-col gap-2">
        {authenticators === null && <li className="text-xs text-muted">Loading…</li>}
        {authenticators?.length === 0 && <li className="text-xs text-muted">No passkeys registered yet.</li>}
        {authenticators?.map((a) => (
          <li
            key={a.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-bg px-3 py-2 text-sm"
          >
            <div>
              <p className="font-medium text-fg">{a.deviceLabel}</p>
              <p className="text-xs text-muted">
                {a.backedUp ? "Synced across devices" : "This device only"}
                {a.lastUsedAtIso && ` · last used ${new Date(a.lastUsedAtIso).toLocaleDateString()}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="neutral">{a.deviceType === "multiDevice" ? "Synced" : "Device-bound"}</Badge>
              <button
                type="button"
                data-id={a.id}
                onClick={handleRemove}
                disabled={isBusy}
                className="rounded-md px-2 py-1 text-xs text-negative hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
