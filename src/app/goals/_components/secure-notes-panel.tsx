"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";
import {
  PBKDF2_ITERATIONS,
  ZK_CANARY_PLAINTEXT,
  deriveZkKey,
  encryptWithZkKey,
  generateZkSalt,
  verifyZkKey,
} from "../../../lib/zk-crypto";
import { useZkVaultStore } from "../../../lib/stores/zk-vault-store";

const MIN_PASSPHRASE_LENGTH = 10;

type Props = {
  isSetUp: boolean;
  salt: string | null;
  iterations: number | null;
  canaryCiphertext: string | null;
  legacyNoteCount: number;
};

/**
 * Setup / unlock / lock control for the zero-knowledge note vault
 * (AGENTS.md §3m). The derived key never leaves this component tree
 * except into `useZkVaultStore`, which is memory-only — see that
 * store's doc comment. Every network call here sends only non-secret
 * material (salt, iteration count, ciphertext) or receives it (the one
 * exception is `/api/zk/migrate-legacy`'s response — see that route's
 * doc comment for why that one plaintext round-trip is unavoidable).
 */
export function SecureNotesPanel({ isSetUp, salt, iterations, canaryCiphertext, legacyNoteCount }: Props) {
  const router = useRouter();
  const key = useZkVaultStore((state) => state.key);
  const unlock = useZkVaultStore((state) => state.unlock);
  const lock = useZkVaultStore((state) => state.lock);

  const [mode, setMode] = useState<"idle" | "setup" | "unlock">("idle");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  async function migrateLegacyNotes(newKey: CryptoKey) {
    const response = await fetch("/api/zk/migrate-legacy", { method: "POST" });
    if (!response.ok) {
      throw new Error("Failed to fetch legacy notes for migration");
    }
    const body = (await response.json()) as { notes: { id: string; plaintext: string }[] };

    for (const legacyNote of body.notes) {
      const ciphertext = await encryptWithZkKey(newKey, legacyNote.plaintext);
      const patchResponse = await fetch(`/api/goals/contributions/${legacyNote.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: ciphertext }),
      });
      if (!patchResponse.ok) {
        throw new Error(`Failed to migrate note ${legacyNote.id}`);
      }
    }
    return body.notes.length;
  }

  async function handleSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError("Passphrases don't match");
      return;
    }

    setIsBusy(true);
    try {
      const newSalt = generateZkSalt();
      const newKey = await deriveZkKey(passphrase, newSalt, PBKDF2_ITERATIONS);
      const canary = await encryptWithZkKey(newKey, ZK_CANARY_PLAINTEXT);

      const response = await fetch("/api/zk/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salt: newSalt, iterations: PBKDF2_ITERATIONS, canaryCiphertext: canary }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to set up secure notes");
      }

      unlock(newKey);

      if (legacyNoteCount > 0) {
        const migratedCount = await migrateLegacyNotes(newKey);
        setStatusMessage(`Secure notes ready — migrated ${migratedCount} existing note(s).`);
      } else {
        setStatusMessage("Secure notes ready.");
      }

      setPassphrase("");
      setConfirmPassphrase("");
      setMode("idle");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set up secure notes");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!salt || !iterations || !canaryCiphertext) return;

    setIsBusy(true);
    try {
      const candidateKey = await deriveZkKey(passphrase, salt, iterations);
      const isCorrect = await verifyZkKey(candidateKey, canaryCiphertext);
      if (!isCorrect) {
        setError("Incorrect passphrase");
        return;
      }

      unlock(candidateKey);

      if (legacyNoteCount > 0) {
        const migratedCount = await migrateLegacyNotes(candidateKey);
        setStatusMessage(`Unlocked — migrated ${migratedCount} remaining note(s).`);
      } else {
        setStatusMessage("Unlocked.");
      }

      setPassphrase("");
      setMode("idle");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlock secure notes");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleMigrateClick() {
    if (!key) return;
    setIsBusy(true);
    setError(null);
    try {
      const migratedCount = await migrateLegacyNotes(key);
      setStatusMessage(`Migrated ${migratedCount} remaining note(s).`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Migration failed");
    } finally {
      setIsBusy(false);
    }
  }

  function handleLockClick() {
    lock();
    setStatusMessage(null);
  }

  function handleOpenUnlockOrSetup() {
    setMode(isSetUp ? "unlock" : "setup");
  }

  function handleCancel() {
    setMode("idle");
    setError(null);
  }

  // Already unlocked this session.
  if (key) {
    return (
      <section className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3 text-sm">
        <Badge variant="positive">Secure notes unlocked</Badge>
        {statusMessage && <span className="text-xs text-muted">{statusMessage}</span>}
        {legacyNoteCount > 0 && (
          <button
            type="button"
            disabled={isBusy}
            onClick={handleMigrateClick}
            className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {isBusy && <Spinner />} Migrate {legacyNoteCount} legacy note(s)
          </button>
        )}
        <button
          type="button"
          onClick={handleLockClick}
          className="uv-btn-press ml-auto rounded-md border border-border px-2 py-1 text-xs font-medium text-muted hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Lock
        </button>
        {error && <p className="w-full text-xs text-negative">{error}</p>}
      </section>
    );
  }

  if (mode === "idle") {
    return (
      <section className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3 text-sm">
        <Badge variant="neutral">Secure notes locked</Badge>
        <p className="text-xs text-muted">
          {isSetUp
            ? "Contribution notes are end-to-end encrypted with your passphrase — the server can never read them."
            : "Set up a master passphrase to attach end-to-end encrypted notes to contributions."}
        </p>
        <button
          type="button"
          onClick={handleOpenUnlockOrSetup}
          className="uv-btn-press ml-auto rounded-md border border-border bg-accent px-3 py-1 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {isSetUp ? "Unlock secure notes" : "Set up secure notes"}
        </button>
      </section>
    );
  }

  if (mode === "setup") {
    return (
      <section className="rounded-lg border border-border bg-surface p-3">
        <form onSubmit={handleSetup} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="zk-passphrase" className="text-xs font-medium text-muted">
              Master passphrase
            </label>
            <input
              id="zk-passphrase"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              className="w-48 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="zk-passphrase-confirm" className="text-xs font-medium text-muted">
              Confirm passphrase
            </label>
            <input
              id="zk-passphrase-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPassphrase}
              onChange={(event) => setConfirmPassphrase(event.target.value)}
              className="w-48 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <button
            type="submit"
            disabled={isBusy || !passphrase || !confirmPassphrase}
            className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {isBusy && <Spinner />} Create vault
          </button>
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-md px-2 py-1.5 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <p className="w-full text-xs text-muted">
            This passphrase is never sent to the server and can&apos;t be recovered if forgotten — every encrypted note
            would become permanently unreadable.
          </p>
          {error && <p className="w-full text-xs text-negative">{error}</p>}
        </form>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-3">
      <form onSubmit={handleUnlock} className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="zk-unlock-passphrase" className="text-xs font-medium text-muted">
            Master passphrase
          </label>
          <input
            id="zk-unlock-passphrase"
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
        <button
          type="button"
          onClick={handleCancel}
          className="rounded-md px-2 py-1.5 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
        {error && <p className="w-full text-xs text-negative">{error}</p>}
      </form>
    </section>
  );
}
