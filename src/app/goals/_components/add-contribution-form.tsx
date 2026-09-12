"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";
import { useZkVaultStore } from "../../../lib/stores/zk-vault-store";
import { zkVaultEncrypt } from "../../../lib/workers/zk-vault-worker-client";

export function AddContributionForm({ goalId }: { goalId: string }) {
  const router = useRouter();
  const zkUnlocked = useZkVaultStore((state) => state.unlocked);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!amount.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      // Encrypted inside zk-crypto.worker.ts under the zero-knowledge key
      // before it ever leaves the browser (AGENTS.md §3m, §3x) — the
      // server only ever receives the ciphertext blob.
      const noteCiphertext =
        note.trim() && zkUnlocked ? (await zkVaultEncrypt(note.trim())).ciphertext : undefined;

      const response = await fetch(`/api/goals/${goalId}/contributions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amount.trim(), note: noteCiphertext }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to add contribution");
      }
      setAmount("");
      setNote("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add contribution");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`contribution-${goalId}`}>
        Contribution amount (₪, negative for a withdrawal)
      </label>
      <input
        id={`contribution-${goalId}`}
        inputMode="decimal"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        placeholder="500.00"
        className="w-28 rounded-md border border-slate-800/80 bg-slate-800 px-2 py-1 font-tabular-figures tracking-tight text-sm text-slate-100 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <label className="sr-only" htmlFor={`contribution-note-${goalId}`}>
        Encrypted note (optional)
      </label>
      <input
        id={`contribution-note-${goalId}`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder={zkUnlocked ? "Note (encrypted)" : "Secure notes locked"}
        title={zkUnlocked ? undefined : "Unlock secure notes above to add an encrypted note"}
        disabled={!zkUnlocked}
        className="w-40 rounded-md border border-slate-800/80 bg-slate-800 px-2 py-1 text-sm text-slate-100 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={isSubmitting || !amount.trim()}
        className="uv-btn-press flex items-center gap-1.5 rounded-md border border-slate-800/80 px-3 py-1 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        Add contribution
      </button>
      {error && <span className="text-xs text-negative">{error}</span>}
    </form>
  );
}
