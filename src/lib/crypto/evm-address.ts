/**
 * EVM (Ethereum-compatible) public address validation (AGENTS.md §3w).
 * Pure functions, `src/lib/` convention (§3b).
 *
 * KNOWN LIMITATION, stated plainly: this validates FORMAT only (`0x` +
 * exactly 40 hex characters) — it does NOT verify an EIP-55 mixed-case
 * checksum. A real checksum needs Keccak-256 (note: NOT the same
 * algorithm as the SHA-3 Node's built-in `crypto` module provides,
 * despite the naming similarity — a well-known gotcha), which isn't
 * available without a new dependency. Given this module only ever reads
 * a PUBLIC address (never a key), the cost of skipping checksum
 * validation is a possible silent typo in an address a user adds to
 * track — annoying (a wallet that just never matches any real balance)
 * but not a security hole the way it would be for, say, validating a
 * destination address before sending funds, which this app never does at
 * all (read-only tracking, AGENTS.md §2.1's Tier 0 defense).
 */

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isValidEvmAddress(value: string): boolean {
  return EVM_ADDRESS_PATTERN.test(value.trim());
}

/**
 * Validates and lowercase-normalizes an address for storage/lookup —
 * EVM addresses are case-insensitive at the protocol level (mixed case
 * is ONLY meaningful for the EIP-55 checksum this module doesn't verify,
 * see this file's header), so normalizing to one canonical case is what
 * makes the same address always match itself regardless of how a user
 * or an RPC response happens to have cased it.
 */
export function normalizeEvmAddress(value: string): string {
  const trimmed = value.trim();
  if (!isValidEvmAddress(trimmed)) {
    throw new RangeError(`Not a valid EVM address (expected 0x + 40 hex characters): ${JSON.stringify(value)}`);
  }
  return trimmed.toLowerCase();
}

/** For display: shortens a normalized address to "0x1234…abcd" — the standard wallet-UI convention, since a full 42-character address is rarely useful to read in full inline. */
export function shortenEvmAddress(address: string): string {
  if (!isValidEvmAddress(address)) {
    throw new RangeError(`Not a valid EVM address: ${JSON.stringify(address)}`);
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
