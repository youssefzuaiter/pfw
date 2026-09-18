"use client";

import { useEffect, useState } from "react";
import { isZkCiphertext } from "../../../lib/zk-crypto";
import { useZkVaultStore } from "../../../lib/stores/zk-vault-store";
import { zkVaultDecrypt } from "../../../lib/workers/zk-vault-worker-client";

/**
 * Renders one contribution's note. The server hands this component raw
 * ciphertext (or `null`) as a prop — it never sees plaintext (AGENTS.md
 * §3m). Decryption happens in `zk-crypto.worker.ts`, only while
 * `useZkVaultStore` reports the vault unlocked.
 */
export function ContributionNote({ ciphertext }: { ciphertext: string | null }) {
  const unlocked = useZkVaultStore((state) => state.unlocked);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // No reset-to-null at the top of this effect: `ciphertext`/`unlocked`
  // are stable for the lifetime of a mounted list row (each
  // contribution's note ciphertext never changes in place), and the
  // render guards below already short-circuit before `plaintext`/`failed`
  // are ever read for a missing ciphertext or a locked vault — so
  // there's no stale value to mask.
  useEffect(() => {
    if (!ciphertext || !unlocked) return;
    let cancelled = false;

    zkVaultDecrypt(ciphertext)
      .then(({ plaintext: result }) => {
        if (!cancelled) {
          setPlaintext(result);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [ciphertext, unlocked]);

  if (!ciphertext) return null;

  if (!unlocked) {
    return <span className="italic text-muted">🔒 locked</span>;
  }

  if (failed) {
    return (
      <span className="italic text-muted">
        {isZkCiphertext(ciphertext) ? "unable to decrypt" : "legacy note — unlock to migrate"}
      </span>
    );
  }

  if (plaintext === null) {
    return <span className="italic text-muted">decrypting…</span>;
  }

  return <span>{plaintext}</span>;
}
