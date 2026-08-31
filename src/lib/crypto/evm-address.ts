/**
 * EVM (Ethereum-compatible) public address validation (AGENTS.md §3w,
 * amended by Punch List Phase 3 item 3). Pure functions, `src/lib/`
 * convention (§3b) — importable from both server and client code (the
 * server route's Zod-adjacent validation AND `AddWalletForm`'s pre-
 * submit check both need the exact same rule).
 *
 * Full EIP-55 checksum validation, via `viem`'s `isAddress`/`getAddress`
 * — already an installed dependency (§3y's RPC-multiplexing work added
 * it for `evm-rpc-client.ts`), so this closes the KNOWN LIMITATION this
 * file used to state plainly rather than silently claiming coverage it
 * didn't have: a real checksum needs Keccak-256 (NOT the same algorithm
 * as Node's built-in SHA-3, despite the naming similarity — a
 * well-known gotcha), which `viem` already bundles correctly, so no new
 * dependency (a raw `keccak256` or `eip55` package) was needed at all.
 *
 * A real, verified (not assumed from reading the EIP-55 spec text alone)
 * behavior of `viem.isAddress(..., { strict: true })`, worth stating
 * plainly since it's genuinely non-obvious and differs from a common
 * paraphrase of the spec ("all-lowercase AND all-uppercase are both
 * accepted with no checksum to verify"): only an ALL-LOWERCASE address
 * short-circuits to valid with no checksum check. An ALL-UPPERCASE
 * address does NOT get the same free pass — it falls through to a real
 * checksum comparison, which an all-uppercase string essentially never
 * satisfies (a true EIP-55 checksum is always genuinely mixed-case), so
 * in practice `isValidEvmAddress` REJECTS an all-uppercase address.
 * Confirmed by direct execution against the installed `viem` version,
 * not inferred from its source or docs. A MIXED-CASE address must match
 * its true checksum casing exactly or is rejected — that's what actually
 * catches a mistyped/miscapitalized address before it's accepted. The
 * address is still only ever a PUBLIC identifier this app reads a
 * balance from, never a destination it sends funds to, so this remains a
 * correctness/UX improvement (catching a typo before a wallet is added
 * that will never match a real balance) rather than closing a security
 * hole the way checksum validation would matter before submitting a
 * transaction, which this app never does.
 */

import { getAddress, isAddress } from "viem";

export function isValidEvmAddress(value: string): boolean {
  return isAddress(value.trim(), { strict: true });
}

/**
 * Validates (full EIP-55 checksum, when the input is mixed-case) and
 * lowercase-normalizes an address for storage/lookup — EVM addresses are
 * case-insensitive at the protocol level (mixed case is ONLY meaningful
 * for the EIP-55 checksum verified above), so normalizing to one
 * canonical case is what makes the same address always match itself
 * regardless of how a user or an RPC response happens to have cased it.
 */
export function normalizeEvmAddress(value: string): string {
  const trimmed = value.trim();
  if (!isValidEvmAddress(trimmed)) {
    throw new RangeError(`Not a valid EVM address (expected 0x + 40 hex characters with a valid EIP-55 checksum): ${JSON.stringify(value)}`);
  }
  return trimmed.toLowerCase();
}

/**
 * Computes the canonical EIP-55 mixed-case checksum form of an already
 * format-valid address — for a UI that wants to show/suggest the
 * correctly-checksummed casing (e.g. "did you mean 0xAbC...123?") rather
 * than only accepting or rejecting. Throws for anything that isn't even
 * shape-valid (`0x` + 40 hex, any case) — computing a checksum for a
 * garbage string has no meaning.
 */
export function toChecksumEvmAddress(value: string): string {
  const trimmed = value.trim();
  if (!isAddress(trimmed, { strict: false })) {
    throw new RangeError(`Not a valid EVM address (expected 0x + 40 hex characters): ${JSON.stringify(value)}`);
  }
  return getAddress(trimmed);
}

/** For display: shortens a normalized address to "0x1234…abcd" — the standard wallet-UI convention, since a full 42-character address is rarely useful to read in full inline. */
export function shortenEvmAddress(address: string): string {
  if (!isAddress(address, { strict: false })) {
    throw new RangeError(`Not a valid EVM address: ${JSON.stringify(address)}`);
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
