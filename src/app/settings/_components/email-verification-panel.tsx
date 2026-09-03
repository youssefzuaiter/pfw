"use client";

import { useState } from "react";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";

/**
 * Email verification status + resend action (auth hardening pass, ad hoc
 * post-§3ff) — mirrors `RevokeSessionsButton`'s shape (a settings-page
 * action button with its own busy/error state), placed in the same
 * "Security" section.
 */
export function EmailVerificationPanel({ initialVerified }: { initialVerified: boolean }) {
  const [verified, setVerified] = useState(initialVerified);
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleResend() {
    setIsBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/resend-verification", { method: "POST" });
      if (!response.ok) throw new Error("Failed to resend verification email");
      const body = await response.json();
      if (body.alreadyVerified) {
        setVerified(true);
        setMessage("Your email is already verified.");
      } else {
        setMessage("Verification email sent — check your inbox.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to resend verification email");
    } finally {
      setIsBusy(false);
    }
  }

  if (verified) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="positive">Email verified</Badge>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Badge variant="warning">Email not verified</Badge>
      <button
        type="button"
        onClick={handleResend}
        disabled={isBusy}
        className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isBusy && <Spinner />} Resend verification email
      </button>
      {message && <p className="text-xs text-muted">{message}</p>}
    </div>
  );
}
