/**
 * Shamir's Secret Sharing over GF(256) (AGENTS.md §3t).
 *
 * Pure math, no crypto.subtle/Node-crypto dependency and no DAL access —
 * same `src/lib/` convention as every other engine (§3b): testable with
 * plain byte-array literals, importable from both the browser (splitting
 * the vault master key at setup, src/lib/dead-mans-switch-crypto.ts) and
 * the server (combining submitted shares during recovery,
 * src/server/dead-mans-switch/recovery-service.ts) — unlike zk-crypto.ts,
 * this module needs no client-only guard, because the math itself reveals
 * nothing on its own; what must stay client-only is generating the ORIGINAL
 * secret and calling `splitSecret` on it, which is enforced in
 * dead-mans-switch-crypto.ts instead.
 *
 * Hand-written rather than a dependency, matching this project's habit of
 * owning small, well-understood algorithms directly (the CSV tokenizer,
 * the seeded RNG, Monte Carlo's Box-Muller transform, the subscription
 * radar's Levenshtein distance) — GF(256) Shamir sharing is exactly that
 * kind of algorithm: the security comes from well-established finite-field
 * math, not from any cleverness in this file, and owning it keeps the
 * whole cryptographic surface auditable in one place with no supply-chain
 * risk from an unvetted npm package.
 *
 * Uses the same GF(256) field AES does (reduction polynomial 0x11B,
 * generator 3) purely because it's a well-known, well-tested set of
 * log/exp tables — there is no cryptographic relationship to AES itself,
 * this is just finite-field arithmetic reused for a different purpose
 * (secret sharing, not a cipher).
 */

const FIELD_SIZE = 256;
/** AES's reduction polynomial (x^8 + x^4 + x^3 + x + 1), used here purely as a well-known GF(256) modulus — no cryptographic relationship to AES. */
const REDUCTION_POLYNOMIAL = 0x11b;
/** 3 (used directly in buildTables' multiply-by-3 step below, not as a named constant) generates the full multiplicative group of GF(256) under this reduction polynomial — 2 does NOT, see buildTables' comment. */

const EXP_TABLE = new Uint8Array(FIELD_SIZE * 2);
const LOG_TABLE = new Uint8Array(FIELD_SIZE);

(function buildTables() {
  let value = 1;
  for (let exponent = 0; exponent < FIELD_SIZE - 1; exponent++) {
    EXP_TABLE[exponent] = value;
    LOG_TABLE[value] = exponent;
    // Advance to generator^(exponent+1) by multiplying by GENERATOR (3),
    // computed as (value*2) XOR value — GF(2^n) multiplication
    // distributes over XOR, and 3 = 2 XOR 1. This is NOT the same as
    // plain doubling (value << 1 alone, i.e. multiplying by 2): verified
    // by hand that 2 has multiplicative order only 51 under this
    // reduction polynomial (0x11B), not 255 — it does NOT generate the
    // full field, and using it here silently produced a broken table
    // (only 51 of 255 nonzero field elements ever appeared), caught by
    // this module's own round-trip tests failing before this comment was
    // written, not by inspection alone. 3 genuinely has order 255 here.
    let doubled = value << 1;
    if (doubled & FIELD_SIZE) doubled ^= REDUCTION_POLYNOMIAL;
    doubled &= 0xff;
    value = doubled ^ value;
  }
  // Extend past 255 so gfMul can index exp[log(a) + log(b)] without a
  // separate mod-255 branch on every multiplication.
  for (let i = FIELD_SIZE - 1; i < EXP_TABLE.length; i++) {
    EXP_TABLE[i] = EXP_TABLE[i - (FIELD_SIZE - 1)];
  }
})();

function gfAdd(a: number, b: number): number {
  return a ^ b; // GF(2^n) addition/subtraction is XOR — there is no separate gfSub.
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError("Division by zero in GF(256)");
  if (a === 0) return 0;
  return EXP_TABLE[(LOG_TABLE[a] + (FIELD_SIZE - 1) - LOG_TABLE[b]) % (FIELD_SIZE - 1)];
}

/** Evaluates a polynomial (coefficients low-to-high, coefficients[0] is the secret byte) at x, in GF(256). */
function evaluatePolynomial(coefficients: Uint8Array, x: number): number {
  let result = 0;
  // Horner's method, high-to-low.
  for (let i = coefficients.length - 1; i >= 0; i--) {
    result = gfAdd(gfMul(result, x), coefficients[i]);
  }
  return result;
}

export type Share = {
  /** 1..255 — the polynomial's x-coordinate for this share. 0 is reserved (it would reveal the secret directly) and there are only 255 non-zero elements in GF(256), which caps totalShares at 255. */
  index: number;
  /** Same length as the original secret — one GF(256) y-value per secret byte. */
  value: Uint8Array;
};

const MAX_SHARES = 255;

export type RandomBytesFn = (length: number) => Uint8Array;

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Splits `secret` into `totalShares` shares, any `threshold` of which
 * reconstruct it exactly (Lagrange interpolation at x=0) — see
 * `combineShares`. Fewer than `threshold` shares reveal nothing about
 * the secret at all (information-theoretic security, not just
 * computational hardness) — that's the actual security property this
 * whole feature rests on, not merely "hard to guess".
 *
 * `randomBytesFn` defaults to `crypto.getRandomValues` (a real CSPRNG —
 * this is genuine secret-splitting, not a place to skimp on randomness
 * quality) and is injectable only so tests can assert exact byte-level
 * behavior deterministically; production call sites should never pass
 * a substitute.
 */
export function splitSecret(
  secret: Uint8Array,
  totalShares: number,
  threshold: number,
  randomBytesFn: RandomBytesFn = defaultRandomBytes,
): Share[] {
  if (secret.length === 0) throw new RangeError("secret must be at least 1 byte");
  if (!Number.isInteger(totalShares) || totalShares < 2 || totalShares > MAX_SHARES) {
    throw new RangeError(`totalShares must be an integer between 2 and ${MAX_SHARES}, got ${totalShares}`);
  }
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > totalShares) {
    throw new RangeError(`threshold must be an integer between 2 and totalShares (${totalShares}), got ${threshold}`);
  }

  // One independent random polynomial per secret byte, all evaluated at
  // the same set of x-coordinates (1..totalShares) — this is what lets a
  // single Share.value array hold one y-value per byte and still combine
  // coherently: each byte position's polynomial only ever mixes with
  // itself across the M shares used in combineShares.
  const shares: Share[] = Array.from({ length: totalShares }, (_, i) => ({
    index: i + 1,
    value: new Uint8Array(secret.length),
  }));

  for (let byteIndex = 0; byteIndex < secret.length; byteIndex++) {
    const coefficients = new Uint8Array(threshold);
    coefficients[0] = secret[byteIndex];
    const randomCoefficients = randomBytesFn(threshold - 1);
    for (let i = 1; i < threshold; i++) coefficients[i] = randomCoefficients[i - 1];

    for (const share of shares) {
      share.value[byteIndex] = evaluatePolynomial(coefficients, share.index);
    }
  }

  return shares;
}

/**
 * Reconstructs the secret from `shares` via Lagrange interpolation at
 * x=0. Requires at least `threshold`-many DISTINCT-index shares to
 * reconstruct correctly — this function has no way to know what the
 * original threshold was, so it always uses every share it's given; the
 * caller (recovery-service.ts) is what enforces "don't attempt this
 * until >= DeadMansSwitch.thresholdShares distinct beneficiaries have
 * submitted". Passing fewer than the true threshold does NOT throw —
 * it silently produces the WRONG secret (this is the same
 * information-theoretic property `splitSecret` describes, working in
 * reverse) — which is exactly why every real caller in this app verifies
 * the result against `vaultCanaryCiphertext` before trusting it, never
 * this function's return value alone.
 */
export function combineShares(shares: Share[]): Uint8Array {
  if (shares.length < 2) throw new RangeError("combineShares needs at least 2 shares");

  const secretLength = shares[0].value.length;
  for (const share of shares) {
    if (share.value.length !== secretLength) {
      throw new RangeError("All shares must have the same byte length");
    }
  }

  const indices = new Set(shares.map((s) => s.index));
  if (indices.size !== shares.length) {
    throw new RangeError("combineShares was given duplicate share indices");
  }

  const secret = new Uint8Array(secretLength);

  for (let byteIndex = 0; byteIndex < secretLength; byteIndex++) {
    // Lagrange interpolation at x=0: secret = sum_i( y_i * product_{j != i}( x_j / (x_j - x_i) ) ).
    let result = 0;
    for (const shareI of shares) {
      let term = shareI.value[byteIndex];
      for (const shareJ of shares) {
        if (shareJ.index === shareI.index) continue;
        // x_j - x_i, in GF(256), where subtraction is XOR (gfAdd).
        const denominator = gfAdd(shareJ.index, shareI.index);
        term = gfMul(term, gfDiv(shareJ.index, denominator));
      }
      result = gfAdd(result, term);
    }
    secret[byteIndex] = result;
  }

  return secret;
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
