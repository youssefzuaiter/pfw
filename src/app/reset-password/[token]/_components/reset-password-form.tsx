"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../../components/spinner/spinner";

/**
 * True 2-step verification on reset (auth hardening pass, ad hoc
 * post-§3ff, per this pass's own design discussion): if the account has
 * TOTP enabled, `POST /api/auth/reset-password` comes back with
 * `code: "totp_required"` on the first submission — same two-step shape
 * `LoginForm` already uses for login's own TOTP challenge, reused here
 * rather than inventing a second pattern.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [newPassword, setNewPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpRequired, setTotpRequired] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword, ...(totpRequired ? { totpCode } : {}) }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (body.code === "totp_required") {
          setTotpRequired(true);
          return;
        }
        if (body.code === "totp_invalid") {
          setTotpRequired(true);
          setError("Incorrect authentication code — try again.");
          return;
        }
        setError(body.error ?? "This reset link is invalid or has expired.");
        return;
      }

      setDone(true);
      setTimeout(() => router.push("/login"), 2000);
    } catch {
      setError("Something went wrong — try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (done) {
    return <p className="mt-6 text-sm text-fg">Your password has been reset. Redirecting you to sign in…</p>;
  }

  if (totpRequired) {
    return (
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <p className="text-sm text-muted">This account has two-factor authentication enabled — enter the 6-digit code from your authenticator app to finish resetting your password.</p>
        <div className="flex flex-col gap-1">
          <label htmlFor="reset-password-totp-code" className="text-xs font-medium text-muted">
            Authentication code
          </label>
          <input
            id="reset-password-totp-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            value={totpCode}
            onChange={(event) => setTotpCode(event.target.value)}
            className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg font-tabular-figures placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <button
          type="submit"
          disabled={isSubmitting || totpCode.length === 0}
          className="uv-btn-press flex items-center justify-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isSubmitting && <Spinner />}
          {isSubmitting ? "Verifying…" : "Verify and reset password"}
        </button>
        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="reset-password-new" className="text-xs font-medium text-muted">
          New password
        </label>
        <input
          id="reset-password-new"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted">At least 8 characters.</p>
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="uv-btn-press flex items-center justify-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        {isSubmitting ? "Resetting…" : "Reset password"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      )}
    </form>
  );
}
