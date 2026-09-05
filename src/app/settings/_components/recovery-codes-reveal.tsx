"use client";

import { useState } from "react";

/**
 * MFA backup codes, shown exactly once (Phase 3, Security & Recovery) —
 * shared by `MfaPanel` and `PasskeyPanel`, whichever MFA enrollment flow
 * actually generates a fresh batch (`ensureRecoveryCodes`'s own doc
 * comment). Rendered inline, not a modal dialog — no focus trap needed
 * since there's nothing behind it to accidentally reach; the only way
 * past it is the explicit acknowledgement button, deliberately with no
 * Escape-to-dismiss, since these codes are shown once and dismissing by
 * accident would be a real loss, not just an inconvenience.
 */
export function RecoveryCodesReveal({ codes, onAcknowledge }: { codes: string[]; onAcknowledge: () => void }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      // Best-effort — clipboard access can be denied or unavailable; the
      // codes are still fully visible below to copy by hand either way.
    }
  }

  return (
    <div className="mt-4 rounded-md border border-signature bg-signature/10 p-3">
      <p className="text-xs font-semibold text-fg">Save your backup codes</p>
      <p className="mt-1 text-xs text-muted">
        Each code works once, to sign in if you ever lose access to your authenticator app or passkey. They
        won&rsquo;t be shown again — save them somewhere safe now.
      </p>
      <ul className="mt-2 grid grid-cols-2 gap-1.5 font-tabular-figures text-sm text-fg">
        {codes.map((code) => (
          <li key={code} className="rounded-md border border-border bg-bg px-2 py-1 text-center">
            {code}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="uv-btn-press rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? "Copied" : "Copy all"}
        </button>
        <button
          type="button"
          onClick={onAcknowledge}
          className="uv-btn-press rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          I&rsquo;ve saved these codes
        </button>
      </div>
    </div>
  );
}
