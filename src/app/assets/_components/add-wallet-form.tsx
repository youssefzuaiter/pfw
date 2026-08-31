"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";
import { isValidEvmAddress } from "../../../lib/crypto/evm-address";

/**
 * Adds a public EVM wallet address to track (AGENTS.md §3w). No private
 * key or seed phrase field exists anywhere in this form — this app
 * tracks public addresses only, read-only, the same Tier 0 "never store
 * a credential" law that already governs bank data (AGENTS.md §2.1).
 *
 * EIP-55 checksum validation (§3w amendment, Punch List Phase 3 item 3):
 * `isValidEvmAddress` is checked here BEFORE ever hitting the network —
 * a mistyped/miscapitalized address is flagged immediately, not only
 * after a round trip to the server (which still re-validates the same
 * way, since a client-side check is a UX convenience, never the actual
 * trust boundary — the same "untrusted input crossing a trust boundary"
 * treatment every other client-validated field in this app gets).
 */
export function AddWalletForm() {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const trimmedAddress = address.trim();
    if (!isValidEvmAddress(trimmedAddress)) {
      setError(
        /^0x[0-9a-fA-F]{40}$/.test(trimmedAddress)
          ? "That address doesn't match its own EIP-55 checksum — double-check the capitalization for a typo."
          : "Not a valid EVM address — expected 0x followed by 40 hex characters.",
      );
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/crypto-wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: address.trim(), label: label.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? "Failed to add wallet");
      }

      setAddress("");
      setLabel("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add wallet");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor="wallet-label" className="text-xs font-medium text-muted">
          Label
        </label>
        <input
          id="wallet-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="e.g. Main wallet"
          required
          className="w-40 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <label htmlFor="wallet-address" className="text-xs font-medium text-muted">
          Public address (0x…)
        </label>
        <input
          id="wallet-address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="0x…"
          required
          className="w-full rounded-md border border-border bg-bg px-2 py-1 font-tabular-figures text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-sm font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />} Track wallet
      </button>
      {error && <p className="w-full text-xs text-negative">{error}</p>}
      <p className="w-full text-xs text-muted">
        Public address only — never enter a private key or seed phrase. This app can only ever read a public
        balance, never move funds.
      </p>
    </form>
  );
}
