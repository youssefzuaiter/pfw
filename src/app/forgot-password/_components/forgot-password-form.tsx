"use client";

import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";

/**
 * ASVS "generic messaging" requirement (auth hardening pass, ad hoc
 * post-§3ff) — `POST /api/auth/forgot-password` always returns the same
 * message regardless of whether the email exists, so this form always
 * shows that same message too, never a distinguishing error for "email
 * not found." A genuine network/server failure is the ONLY case that
 * shows something different, and even then the message stays generic.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!response.ok && response.status !== 400) {
        throw new Error("Something went wrong — try again.");
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <p className="mt-6 text-sm text-fg">
        If an account exists for <span className="font-medium">{email}</span>, a reset link has been sent. Check your
        inbox — the link expires in 15 minutes.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="forgot-password-email" className="text-xs font-medium text-muted">
          Email
        </label>
        <input
          id="forgot-password-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="uv-btn-press flex items-center justify-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        {isSubmitting ? "Sending…" : "Send reset link"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      )}
    </form>
  );
}
