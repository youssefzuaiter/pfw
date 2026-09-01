"use client";

import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "../../../components/spinner/spinner";

/**
 * Server-side JWT revocation's one explicit user-facing trigger (Punch
 * List Tier 2, item 2). `POST /api/auth/revoke-sessions` bumps
 * tokenVersion for EVERY session including this one — see that route's
 * own doc comment — so this immediately signs the current browser out
 * too, rather than leaving it relying on a now-stale token until the
 * next mismatch check happens to run.
 */
export function RevokeSessionsButton() {
  const router = useRouter();
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/revoke-sessions", { method: "POST" });
      if (!response.ok) throw new Error("Failed to sign out other sessions");
      await signOut({ redirect: false });
      router.push("/login");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign out other sessions");
      setIsBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={isBusy}
        className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-negative px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isBusy && <Spinner />} Sign out of all sessions
      </button>
      <p className="text-xs text-muted">Signs this device and every other signed-in device out immediately.</p>
      {error && <p className="text-xs text-negative">{error}</p>}
    </div>
  );
}
