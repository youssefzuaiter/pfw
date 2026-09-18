"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Spinner } from "../../../../components/spinner/spinner";

type Status = "verifying" | "success" | "error";

/**
 * Auto-confirms on mount — unlike the reset-password page (which waits
 * for the user to type a new password before doing anything), there's no
 * additional input needed here: opening the link IS the confirmation
 * action. A `useEffect`-guarded ref stops React StrictMode's dev-only
 * double-invoke from submitting the single-use token twice.
 */
export function VerifyEmailConfirm({ token }: { token: string }) {
  const [status, setStatus] = useState<Status>("verifying");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/auth/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        setStatus(response.ok ? "success" : "error");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === "verifying") {
    return (
      <div className="mt-6 flex items-center gap-2 text-sm text-muted">
        <Spinner /> Verifying your email…
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="mt-6 flex flex-col gap-3">
        <p className="text-sm text-fg">Your email address has been verified.</p>
        <Link
          href="/dashboard"
          className="text-sm text-accent-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Go to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-6 flex flex-col gap-3">
      <p className="text-sm text-negative">This verification link is invalid or has expired.</p>
      <p className="text-sm text-muted">You can request a new one from your account settings.</p>
    </div>
  );
}
