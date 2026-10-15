/**
 * Pure hash computation for Cryptographic Ledger Versioning (ad hoc,
 * AGENTS.md) — no DAL/DB access, same `src/lib/` convention as every
 * other engine in this app (§3b): testable with plain data literals.
 *
 * `computeLedgerCommitHash` is deliberately the ONLY place this app
 * computes a ledger hash — `src/server/dal/ledger-commits.ts` (writing)
 * and its verification counterpart both call this same function, so the
 * write path and the verify path can never silently drift into two
 * different hash definitions.
 */

import { createHash } from "node:crypto";

/**
 * A transaction's state at one commit — everything about it that
 * matters for tamper-evidence, frozen as it was AT THAT MOMENT (the
 * category NAME, not just its id, since a later rename shouldn't change
 * what an old commit's hash covers — the same historical-fact treatment
 * this app already gives `Trade`/`Dividend` fields). BigInt fields are
 * pre-converted to decimal strings by the caller — `JSON.stringify`
 * throws on a raw `bigint`, the same `NextResponse.json()`-can't-
 * serialize-bigint bug class documented elsewhere in this app (§3d),
 * applied here to hash-input canonicalization instead.
 */
export type LedgerCommitState = {
  transactionId: string;
  categoryId: string;
  categoryName: string;
  /** Signed agorot, as a decimal string. */
  amountAgorot: string;
  currency: string;
  /** Signed minor units of `currency`, as a decimal string. */
  nativeAmount: string;
  occurredAtIso: string;
  description: string;
  merchantName: string | null;
  /**
   * Only on a DELETE commit: the `providerTransactionId` the delete
   * released, so a restore can put it back.
   *
   * Optional, and absent from every other action's state, so existing
   * commits hash exactly as they did — `canonicalJson` sorts keys and
   * simply has one fewer to serialize.
   */
  providerTransactionId?: string | null;
  /**
   * The exchange rate the shekel amount was converted at, as the exact
   * six-decimal text stored in `exchangeRateAtEntry` ("3.037667"). Present
   * only for a row recorded in a currency other than shekels.
   *
   * Without it the chain covered both amounts but not the rate linking
   * them, so the stored rate could be changed without breaking
   * verification (AGENTS.md §3www). Optional, so every commit written
   * before this field existed hashes exactly as it did.
   */
  exchangeRate?: string;
  /**
   * How the amount divides across categories (AGENTS.md §3xxx), sorted by
   * category id. Present only while the transaction is split, so every
   * unsplit row's state, and every commit written before splits existed,
   * hashes exactly as it did.
   */
  splits?: LedgerSplitState[];
};

/** One category's share in a commit; amounts are signed decimal strings. */
export type LedgerSplitState = {
  categoryId: string;
  /** Frozen as it was at the commit, like `categoryName` above. */
  categoryName: string;
  amountAgorot: string;
  nativeAmount: string;
};

/**
 * Deterministic, sorted-key JSON — plain `JSON.stringify` on an object
 * literal happens to preserve insertion order for string keys in every
 * engine this app runs on, but a hash function's input format should
 * never depend on an incidental engine behavior; sorting explicitly
 * makes "canonical" actually mean something.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sortedEntries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(sortedEntries.map(([key, inner]) => [key, sortKeysDeep(inner)]));
  }
  return value;
}

/**
 * Nested objects (the `splits` entries) are sorted too. Every field before
 * splits was a scalar, so for those states this is byte-for-byte the
 * top-level sort it replaced, and their hashes are unchanged.
 */
function canonicalize(state: LedgerCommitState): string {
  return JSON.stringify(sortKeysDeep(state));
}

/**
 * `sha256(previousHash ?? "" + canonicalize(state))`. `previousHash` is
 * `null` only for a transaction's very first (CREATE) commit — treated
 * as an empty string in the hash input, never skipped, so a chain's
 * first link is still a real hash of `("" + state)`, not a special case
 * a verifier has to know about separately.
 */
export function computeLedgerCommitHash(previousHash: string | null, state: LedgerCommitState): string {
  const hash = createHash("sha256");
  hash.update(previousHash ?? "");
  hash.update(canonicalize(state));
  return hash.digest("hex");
}
