"use client";

import { useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";
import { shortenEvmAddress } from "../../../lib/crypto/evm-address";
import { weiToEtherString } from "../../../lib/crypto/token-units";
import { agorot, formatAgorot } from "../../../lib/money";

export type WalletBalanceRowProps = {
  id: string;
  address: string;
  label: string;
  chainId: number;
  /** A base-10 string, not a `bigint` — Server->Client props must be JSON-serializable, and `bigint` isn't (AGENTS.md's own "NextResponse.json() cannot serialize a raw bigint" bug class, §3d, applies equally to RSC prop serialization). */
  balanceWei: string | null;
  valueAgorot: number;
  stakingYieldBps: number | null;
  /** Same base-10-string-not-bigint reasoning as `balanceWei`. */
  cumulativeGasFeesWei: string | null;
  rpcError: string | null;
};

const CHAIN_LABEL: Record<number, string> = { 1: "Ethereum" };

/**
 * The Advanced Crypto & On-Chain Asset Tracking module's multi-currency
 * display row (AGENTS.md §3w) — shows a wallet's native on-chain balance
 * (ETH, up to 18 decimal places, via `weiToEtherString`) directly
 * alongside its live ILS-converted value, the same "never show a native
 * amount without its currency, never conflate it with a base-currency
 * figure" convention `formatNativeAmount` already establishes for fiat
 * (currency.ts, §3k) — extended here to a genuinely different currency
 * *kind* (an on-chain token, not a second fiat currency).
 */
export function WalletBalanceRow({
  id,
  address,
  label,
  chainId,
  balanceWei,
  valueAgorot,
  stakingYieldBps,
  cumulativeGasFeesWei,
  rpcError,
}: WalletBalanceRowProps) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDeleteClick(event: MouseEvent<HTMLButtonElement>) {
    const walletId = event.currentTarget.dataset.walletId;
    if (!walletId) return;

    setIsDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/crypto-wallets/${walletId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to remove wallet");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove wallet");
      setIsDeleting(false);
    }
  }

  return (
    <li className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium text-fg">
            {label} <span className="text-xs text-muted">({CHAIN_LABEL[chainId] ?? `Chain ${chainId}`})</span>
          </p>
          <p className="font-tabular-figures text-xs text-muted">{shortenEvmAddress(address)}</p>
        </div>
        <button
          type="button"
          data-wallet-id={id}
          onClick={handleDeleteClick}
          disabled={isDeleting}
          className="uv-btn-press flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isDeleting && <Spinner />} Remove
        </button>
      </div>

      {rpcError ? (
        <p className="mt-2 text-xs text-negative">Couldn&apos;t fetch a live balance right now — {rpcError}</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-baseline gap-2 font-tabular-figures">
          <span className="text-lg font-semibold text-fg">{weiToEtherString(BigInt(balanceWei ?? "0"))} ETH</span>
          <span className="text-sm text-muted">≈ {formatAgorot(agorot(Math.round(valueAgorot)))}</span>
        </div>
      )}

      {(stakingYieldBps !== null || cumulativeGasFeesWei !== null) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {stakingYieldBps !== null && <Badge variant="positive">Staking {(stakingYieldBps / 100).toFixed(2)}% APY</Badge>}
          {cumulativeGasFeesWei !== null && (
            <Badge variant="neutral">Gas paid: {weiToEtherString(BigInt(cumulativeGasFeesWei))} ETH</Badge>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-negative">{error}</p>}
    </li>
  );
}
