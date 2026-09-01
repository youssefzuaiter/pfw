"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";

/**
 * Same generic "Invalid email or password" message regardless of WHICH
 * of the three ways this can fail (unknown email, an unclaimed seeded
 * row with no password yet, or a wrong password) — matching
 * verifyCredentials()'s own deliberately-identical-shaped responses
 * (AGENTS.md §3ff), so this form can't be used to enumerate which
 * emails have accounts.
 *
 * TOTP MFA (Punch List Tier 2, item 3) — a second-step code field,
 * revealed only after the FIRST submission comes back with
 * `result.code === "totp_required"` (auth.ts's `TotpRequiredError`,
 * thrown from `authorize()` only AFTER the password was already
 * confirmed — see that file's own doc comment for why this ordering
 * means never revealing MFA status pre-password). `result.code` is
 * populated directly from the redirect URL's `code` query param by
 * `next-auth/react`'s own `signIn()` — verified against the installed
 * package's source, not assumed from the beta docs.
 */
export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleEmailChange(event: ChangeEvent<HTMLInputElement>) {
    setEmail(event.target.value);
  }
  function handlePasswordChange(event: ChangeEvent<HTMLInputElement>) {
    setPassword(event.target.value);
  }
  function handleTotpCodeChange(event: ChangeEvent<HTMLInputElement>) {
    setTotpCode(event.target.value);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await signIn("credentials", {
        email,
        password,
        ...(mfaRequired ? { totpCode } : {}),
        redirect: false,
      });

      if (!result || result.error) {
        if (result?.code === "totp_required") {
          setMfaRequired(true);
          return;
        }
        if (result?.code === "totp_invalid") {
          setMfaRequired(true);
          setError("Incorrect authentication code — try again.");
          return;
        }
        setError("Invalid email or password.");
        return;
      }

      router.push(redirectTo);
      router.refresh();
    } catch {
      setError("Something went wrong signing in — try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (mfaRequired) {
    return (
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app.</p>
        <div className="flex flex-col gap-1">
          <label htmlFor="login-totp-code" className="text-xs font-medium text-muted">
            Authentication code
          </label>
          <input
            id="login-totp-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            value={totpCode}
            onChange={handleTotpCodeChange}
            className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg font-tabular-figures placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <button
          type="submit"
          disabled={isSubmitting || totpCode.length === 0}
          className="uv-btn-press flex items-center justify-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isSubmitting && <Spinner />}
          {isSubmitting ? "Verifying…" : "Verify"}
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
        <label htmlFor="login-email" className="text-xs font-medium text-muted">
          Email
        </label>
        <input
          id="login-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={handleEmailChange}
          className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="login-password" className="text-xs font-medium text-muted">
          Password
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={handlePasswordChange}
          className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="uv-btn-press flex items-center justify-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        {isSubmitting ? "Signing in…" : "Sign in"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      )}
    </form>
  );
}
