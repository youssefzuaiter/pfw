"use client";

import { signOut } from "next-auth/react";

/**
 * Real sign-out (AGENTS.md §3ff) — a named handler, not an inline arrow
 * on the button element, on purpose: this app's own focus-visible guard
 * test has a documented regex trap for exactly `onClick={() => ...}` on
 * a button element (the `=>` inside the arrow gets read as the tag's
 * own closing bracket), hit repeatedly across this app's history (§3c,
 * §3d, §3r, §3s, §3t) and avoided here by construction rather than by
 * luck.
 */
function handleSignOut() {
  void signOut({ callbackUrl: "/login" });
}

/**
 * Two literal variants, not one component with a `className` prop
 * threaded through as `className={className}` — that shape hit a
 * DIFFERENT, previously-undiscovered blind spot in the same guard test:
 * its regex only recognizes a literal `className="..."` or a literal
 * backtick-template form directly on the tag, not a prop reference or a
 * `??` fallback expression, so a genuinely-safe button rendered via a
 * dynamic className was flagged as a false positive (the guard's own
 * header comment already says this exact shape — a reusable wrapper
 * component — is out of scope for it). Two literal render branches, one
 * button element each, sidesteps that rather than fighting the regex or
 * adding an allowlist entry for a component this small.
 */
export function SignOutButton({ variant = "nav" }: { variant?: "nav" | "drawer" }) {
  if (variant === "drawer") {
    return (
      <button
        type="button"
        onClick={handleSignOut}
        className="block w-full rounded-md border border-border px-3 py-2 text-center text-sm font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Sign out
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      className="rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Sign out
    </button>
  );
}
