"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";

/**
 * Device-Bound Biometrics via Passkeys (ad hoc) — "Sign in with Passkey"
 * triggers the browser's native biometric/PIN prompt
 * (`@simplewebauthn/browser`'s `startAuthentication()`), then completes
 * the sign-in through the SAME `signIn()` flow the password form below
 * uses, just against the `passkey` Credentials provider
 * (`src/server/auth/auth.ts`) instead of `credentials` — `authorize()`
 * there does the actual cryptographic verification, so this component
 * never sees or judges anything about it. Uses whichever email is
 * currently typed into the form's own email field — no separate input.
 */
async function signInWithPasskey(email: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const { startAuthentication } = await import("@simplewebauthn/browser");

  const optionsResponse = await fetch("/api/auth/webauthn/authenticate-options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!optionsResponse.ok) return { ok: false, message: "Something went wrong — try again." };
  const { options, challengeId } = await optionsResponse.json();
  if (!challengeId) return { ok: false, message: "No passkey found for this email." };

  let assertion;
  try {
    assertion = await startAuthentication(options);
  } catch {
    return { ok: false, message: "Passkey sign-in was cancelled or failed." };
  }

  const result = await signIn("passkey", {
    email,
    challengeId,
    assertion: JSON.stringify(assertion),
    redirect: false,
  });
  if (!result || result.error) {
    if (result?.code === "too_many_attempts") return { ok: false, message: "Too many attempts — wait a few minutes before trying again." };
    if (result?.code === "account_locked") {
      return { ok: false, message: "This account is locked after too many failed attempts. Use a backup code or reset your password to unlock it." };
    }
    return { ok: false, message: "Could not sign in with that passkey." };
  }
  return { ok: true };
}

/**
 * MFA backup-code emergency bypass (Phase 3, Security & Recovery) — the
 * client half of the "recovery-code" Credentials provider (auth.ts). A
 * separate, dedicated form rather than a third field on the password
 * form: entering a backup code bypasses password AND TOTP entirely,
 * which is a meaningfully different action from "I have my password and
 * my code," not an extra optional field on the same submission.
 */
async function signInWithRecoveryCode(email: string, code: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await signIn("recovery-code", { email, code, redirect: false });
  if (!result || result.error) {
    if (result?.code === "too_many_attempts") return { ok: false, message: "Too many attempts — wait a few minutes before trying again." };
    return { ok: false, message: "That code is invalid or has already been used." };
  }
  return { ok: true };
}

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
  const [recoveryCode, setRecoveryCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [showRecoveryForm, setShowRecoveryForm] = useState(false);
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
  function handleRecoveryCodeChange(event: ChangeEvent<HTMLInputElement>) {
    setRecoveryCode(event.target.value);
  }

  function handleShowRecoveryForm() {
    setError(null);
    setShowRecoveryForm(true);
  }
  function handleBackToPassword() {
    setError(null);
    setShowRecoveryForm(false);
    setMfaRequired(false);
  }

  async function handlePasskeySignIn() {
    if (!email.trim()) {
      setError("Enter your email above, then choose Sign in with Passkey.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await signInWithPasskey(email.trim());
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.push(redirectTo);
      router.refresh();
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRecoverySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await signInWithRecoveryCode(email, recoveryCode);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.push(redirectTo);
      router.refresh();
    } finally {
      setIsSubmitting(false);
    }
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
        if (result?.code === "too_many_attempts") {
          setError("Too many attempts — wait a few minutes before trying again.");
          return;
        }
        if (result?.code === "account_locked") {
          setError("This account is locked after too many failed attempts. Use a backup code or reset your password to unlock it.");
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

  if (showRecoveryForm) {
    return (
      <form onSubmit={handleRecoverySubmit} className="mt-6 flex flex-col gap-4">
        <p className="text-sm text-muted">
          Enter your email and one of your backup codes. Each code works once.
        </p>
        <div className="flex flex-col gap-1">
          <label htmlFor="login-recovery-email" className="text-xs font-medium text-muted">
            Email
          </label>
          <input
            id="login-recovery-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={handleEmailChange}
            className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="login-recovery-code" className="text-xs font-medium text-muted">
            Backup code
          </label>
          <input
            id="login-recovery-code"
            type="text"
            autoComplete="off"
            autoFocus
            required
            value={recoveryCode}
            onChange={handleRecoveryCodeChange}
            className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg font-tabular-figures placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <button
          type="submit"
          disabled={isSubmitting || !email.trim() || !recoveryCode.trim()}
          className="uv-btn-press flex items-center justify-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isSubmitting && <Spinner />}
          {isSubmitting ? "Verifying…" : "Sign in with backup code"}
        </button>
        <button
          type="button"
          onClick={handleBackToPassword}
          className="text-xs text-muted underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Back to password sign-in
        </button>
        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}
      </form>
    );
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
        <div className="flex items-center justify-between">
          <label htmlFor="login-password" className="text-xs font-medium text-muted">
            Password
          </label>
          <Link
            href="/forgot-password"
            className="text-xs text-accent-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Forgot password?
          </Link>
        </div>
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
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <button
        type="button"
        onClick={handlePasskeySignIn}
        disabled={isSubmitting}
        className="uv-btn-press flex items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        Sign in with Passkey
      </button>
      <button
        type="button"
        onClick={handleShowRecoveryForm}
        className="text-center text-xs text-muted underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Use a backup code instead
      </button>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      )}
    </form>
  );
}
