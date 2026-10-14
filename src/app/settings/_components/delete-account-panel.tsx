"use client";

import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";
import { clearLocalVectorStore } from "../../../lib/rag/local-vector-store";

/**
 * Settings → Delete account (AGENTS.md §3ttt). Collapsed until asked for,
 * says exactly what goes, and needs the password, the authenticator code
 * when two-factor sign-in is on, and the word DELETE. After the server
 * confirms, this browser's own copies go too: the copilot's local search
 * cache (IndexedDB) and the app's saved preferences (local storage), and
 * then the session.
 */
export type DeleteAccountPanelProps = {
  totpEnabled: boolean;
  ownedHouseholds: string[];
  hasEmergencyVault: boolean;
};

const CONFIRM_WORD = "DELETE";

export function DeleteAccountPanel({ totpEnabled, ownedHouseholds, hasEmergencyVault }: DeleteAccountPanelProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !isBusy && password.length > 0 && confirm === CONFIRM_WORD && (!totpEnabled || totpCode.trim().length > 0);

  function handleOpen() {
    setIsOpen(true);
  }

  function handleCancel() {
    setIsOpen(false);
    setPassword("");
    setTotpCode("");
    setConfirm("");
    setError(null);
  }

  function handlePasswordChange(event: ChangeEvent<HTMLInputElement>) {
    setPassword(event.target.value);
  }

  function handleTotpChange(event: ChangeEvent<HTMLInputElement>) {
    setTotpCode(event.target.value);
  }

  function handleConfirmChange(event: ChangeEvent<HTMLInputElement>) {
    setConfirm(event.target.value);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, totpCode: totpEnabled ? totpCode.trim() : undefined, confirm }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          response.status === 429 ? "Too many attempts. Try again in an hour." : (body?.error ?? "The account could not be deleted."),
        );
      }
      await clearBrowserCopies();
      await signOut({ redirect: false });
      router.push("/login?deleted=1");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The account could not be deleted.");
      setIsBusy(false);
    }
  }

  if (!isOpen) {
    return (
      <div className="flex flex-col items-start gap-2">
        <button
          type="button"
          onClick={handleOpen}
          className="uv-btn-press rounded-md border border-negative px-3 py-1.5 text-xs font-medium text-negative hover:bg-negative/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Delete account…
        </button>
        <p className="text-xs text-muted">Permanently removes your account and everything in it.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-md border border-negative bg-surface p-4">
      <div>
        <h3 className="text-sm font-semibold text-fg">Delete your account permanently</h3>
        <p className="mt-1 text-xs text-muted">This cannot be undone. It removes, for good:</p>
        <ul className="mt-1 list-disc pl-5 text-xs text-muted">
          <li>every account, transaction, budget, goal, rule and import, and their history</li>
          <li>your passkeys, two-factor settings, phone alerts and preferences</li>
          {hasEmergencyVault && <li>your Emergency Vault: beneficiaries will no longer be able to recover it</li>}
          {ownedHouseholds.map((name) => (
            <li key={name}>
              the household &ldquo;{name}&rdquo; for all its members (their own data stays, but stops being shared)
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">
          Encrypted copies stay in the nightly backups for up to 30 days, and in the database provider&rsquo;s restore window,
          until they expire.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="delete-account-password">
        Current password
        <input
          id="delete-account-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={handlePasswordChange}
          className="rounded-md border border-border bg-elevated px-2 py-1.5 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      {totpEnabled && (
        <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="delete-account-totp">
          Code from your authenticator app
          <input
            id="delete-account-totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={totpCode}
            onChange={handleTotpChange}
            className="rounded-md border border-border bg-elevated px-2 py-1.5 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      )}

      <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="delete-account-confirm">
        Type {CONFIRM_WORD} to confirm
        <input
          id="delete-account-confirm"
          autoComplete="off"
          value={confirm}
          onChange={handleConfirmChange}
          className="rounded-md border border-border bg-elevated px-2 py-1.5 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      {error && (
        <p role="alert" className="text-xs text-negative">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-negative px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isBusy && <Spinner />} Delete my account
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={isBusy}
          className="uv-btn-press rounded-md border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-fg hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Best effort: the account is already gone, so a failure here must not stop the sign-out. */
async function clearBrowserCopies(): Promise<void> {
  try {
    await clearLocalVectorStore();
  } catch {
    // IndexedDB unavailable (private mode) or never opened: nothing to clear.
  }
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage blocked by the browser: nothing was stored.
  }
}
