/**
 * Shamir's Secret Sharing over GF(256) (AGENTS.md §3t, §3x), built on
 * `secrets.js-grempe` rather than the hand-rolled GF(256) implementation
 * this module started with. This is a deliberate reversal of §3t's original
 * "own small, well-understood algorithms directly" stance: finite-field
 * Shamir sharing turned out to be exactly the kind of primitive where a
 * subtle bug (this file's own git history has one — an early build used
 * generator 2 for the GF(256) log/exp tables, which only has multiplicative
 * order 51, silently producing a broken field with 1/5 the elements it
 * needed) is easy to introduce and hard to notice, since round-trip tests
 * can pass on a broken field as long as they never exercise the missing
 * elements. `secrets.js-grempe` was in scope of a Cure53 security audit
 * (commissioned by the Slant PrivEOS project, July 2019) that found no
 * issues — the report ships in the installed package itself at
 * node_modules/secrets.js-grempe/audit/SLA-01-report.pdf, so the audit
 * claim is independently checkable, not taken on faith.
 *
 * Two honest caveats about this dependency, stated plainly rather than
 * glossed over:
 *  - It has had no new npm releases in over a year and has essentially one
 *    maintainer. It is small (zero runtime dependencies), simple enough to
 *    vendor a fork of if it ever goes fully unmaintained, and the audited
 *    behavior is exactly what's installed — but this is not an
 *    actively-developed project.
 *  - Binary-field Shamir sharing reveals the SIZE of the secret (each
 *    share's byte length is a function of the secret's byte length), even
 *    though it remains information-theoretically secure against learning
 *    anything about the VALUE below the threshold. `secrets.share()`
 *    zero-pads to a 128-bit boundary by default, which narrows this to
 *    "which 128-bit size bucket" rather than the exact byte count — and in
 *    this app specifically, every secret ever split here is the same fixed
 *    32-byte AES-256 vault key (src/lib/dead-mans-switch-crypto.ts), so in
 *    practice every share this app ever produces is the same 48-byte
 *    length regardless of vault contents. There is no differential leakage
 *    in actual use.
 *
 * Still pure math with no crypto.subtle/Node-crypto dependency of its own
 * and no DAL access — same `src/lib/` convention as every other engine
 * (§3b): importable from both the browser (splitting the vault master key
 * at setup, src/lib/dead-mans-switch-crypto.ts, inside the Web Worker
 * described in §3x) and the server (combining submitted shares during
 * recovery, src/server/dead-mans-switch/recovery-service.ts) — unlike
 * zk-crypto.ts, this module needs no client-only guard, because the math
 * itself reveals nothing on its own; what must stay client/worker-only is
 * generating the ORIGINAL secret and calling `splitSecret` on it.
 *
 * `Share.value` is treated as an opaque blob (the exact bits+id+data string
 * `secrets.share()` produces, UTF-8 encoded — NOT hex-decoded, since that
 * string's length is odd whenever `config.bits` is a single base-36 digit,
 * as it always is here) rather than decomposed into its own y-value
 * representation — this module only ever hands shares back to
 * `secrets.combine()` unchanged, so there is no reason to know or rely on
 * their internal structure, and doing so would just be re-introducing the
 * "our own crypto plumbing" surface this refactor removes.
 */

import * as secretsLib from "secrets.js-grempe";

export type Share = {
  /** 1..255 — the share's id, as assigned by `secrets.share()`. 0 is never issued (it would reveal the secret directly) and GF(256) has only 255 non-zero elements, which caps totalShares at 255. Kept alongside `value` purely for display/bookkeeping (e.g. "Share #3 of 5" in the UI); reconstruction relies entirely on `value`, not this field. */
  index: number;
  /** Opaque bytes — the UTF-8 encoding of the exact share string `secrets.share()` produced. No internal structure should be assumed; see this module's top comment. */
  value: Uint8Array;
};

const MAX_SHARES = 255;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * An odd-length `hex` is left-padded with one zero nibble rather than
 * rejected — `secrets.combine()`'s output (the only caller that can hand
 * this an odd length) strips a leading marker bit that `secrets.share()`
 * added, and for a WRONG reconstruction (fewer than `threshold` real
 * shares) that strip can land anywhere, not just on a byte boundary. A
 * correct reconstruction is always byte-aligned by construction, so this
 * padding only ever engages on already-garbage output — it turns "throws
 * instead of comparing" into "compares and correctly finds a mismatch",
 * without ever making bad input look valid.
 */
function hexToBytes(hex: string): Uint8Array {
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new RangeError(`Invalid hex string at offset ${i * 2}`);
    bytes[i] = byte;
  }
  return bytes;
}

/**
 * Splits `secret` into `totalShares` shares, any `threshold` of which
 * reconstruct it exactly — see `combineShares`. Fewer than `threshold`
 * shares reveal nothing about the secret at all (information-theoretic
 * security, not just computational hardness) — that's the actual security
 * property this whole feature rests on, not merely "hard to guess".
 *
 * Uses whatever CSPRNG `secrets.js-grempe` auto-detects for the current
 * environment (`crypto.getRandomValues` in the browser/Worker,
 * `crypto.randomBytes` under Node for server-side tooling) — this module
 * no longer accepts an injectable randomness source. The previous
 * hand-rolled implementation took one solely so its own tests could assert
 * exact byte-level output deterministically; no production call site ever
 * used it, and now that the actual splitting is delegated to an audited
 * library, substituting its randomness would undermine the point of
 * trusting it as shipped. Tests here instead assert the same properties
 * production code relies on (round-trips, threshold behavior) against the
 * real CSPRNG.
 */
export function splitSecret(secret: Uint8Array, totalShares: number, threshold: number): Share[] {
  if (secret.length === 0) throw new RangeError("secret must be at least 1 byte");
  if (!Number.isInteger(totalShares) || totalShares < 2 || totalShares > MAX_SHARES) {
    throw new RangeError(`totalShares must be an integer between 2 and ${MAX_SHARES}, got ${totalShares}`);
  }
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > totalShares) {
    throw new RangeError(`threshold must be an integer between 2 and totalShares (${totalShares}), got ${threshold}`);
  }

  const shareStrings = secretsLib.share(bytesToHex(secret), totalShares, threshold);
  return shareStrings.map((raw) => ({
    index: secretsLib.extractShareComponents(raw).id,
    value: textEncoder.encode(raw),
  }));
}

/**
 * Reconstructs the secret from `shares`. Requires at least `threshold`-many
 * DISTINCT shares to reconstruct correctly — this function has no way to
 * know what the original threshold was, so it always uses every share it's
 * given; the caller (recovery-service.ts) is what enforces "don't attempt
 * this until >= DeadMansSwitch.thresholdShares distinct beneficiaries have
 * submitted". Passing fewer than the true threshold does NOT throw — it
 * silently produces the WRONG secret (the same information-theoretic
 * property `splitSecret` describes, working in reverse) — which is exactly
 * why every real caller in this app verifies the result against
 * `vaultCanaryCiphertext` before trusting it, never this function's return
 * value alone.
 */
export function combineShares(shares: Share[]): Uint8Array {
  if (shares.length < 2) throw new RangeError("combineShares needs at least 2 shares");

  const indices = new Set(shares.map((s) => s.index));
  if (indices.size !== shares.length) {
    throw new RangeError("combineShares was given duplicate share indices");
  }

  const hex = secretsLib.combine(shares.map((s) => textDecoder.decode(s.value)));
  return hexToBytes(hex);
}

const SHARE_FORMAT_VERSION = "dms-share1";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A short, non-cryptographic checksum (first 4 bytes of a cheap FNV-1a hash) so a beneficiary who mistypes/mis-pastes their share gets an immediate, clear "that's not a valid share" error client-side, before ever hitting the server — NOT a security control (nothing here is secret; SSS shares are only meaningful information-theoretically once combined), purely a typo guard. */
function checksum4(bytes: Uint8Array): Uint8Array {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  const out = new Uint8Array(4);
  out[0] = (hash >>> 24) & 0xff;
  out[1] = (hash >>> 16) & 0xff;
  out[2] = (hash >>> 8) & 0xff;
  out[3] = hash & 0xff;
  return out;
}

/** `dms-share1:<index>:<base64url value>:<base64url 4-byte checksum>` — a self-contained string a beneficiary can copy/paste/print, independent of any invite token (see Beneficiary's model comment for why the token and the share are two separate secrets, distributed out-of-band). */
export function encodeShare(share: Share): string {
  if (!Number.isInteger(share.index) || share.index < 1 || share.index > MAX_SHARES) {
    throw new RangeError(`share.index must be an integer between 1 and ${MAX_SHARES}`);
  }
  return [SHARE_FORMAT_VERSION, String(share.index), toBase64Url(share.value), toBase64Url(checksum4(share.value))].join(
    ":",
  );
}

/** Throws on any malformed input, wrong format version, or checksum mismatch — never returns a share it isn't confident was copy/pasted correctly. */
export function decodeShare(encoded: string): Share {
  const parts = encoded.trim().split(":");
  if (parts.length !== 4 || parts[0] !== SHARE_FORMAT_VERSION) {
    throw new RangeError(`Unrecognized share format: expected "${SHARE_FORMAT_VERSION}:index:value:checksum"`);
  }
  const [, indexStr, valueB64, checksumB64] = parts;

  const index = Number(indexStr);
  if (!Number.isInteger(index) || index < 1 || index > MAX_SHARES) {
    throw new RangeError(`Invalid share index: ${indexStr}`);
  }

  const value = fromBase64Url(valueB64);
  const expectedChecksum = fromBase64Url(checksumB64);
  const actualChecksum = checksum4(value);
  const checksumMatches = expectedChecksum.length === actualChecksum.length && expectedChecksum.every((b, i) => b === actualChecksum[i]);
  if (!checksumMatches) {
    throw new RangeError("Share checksum mismatch — this share was mistyped, truncated, or corrupted");
  }

  return { index, value };
}
