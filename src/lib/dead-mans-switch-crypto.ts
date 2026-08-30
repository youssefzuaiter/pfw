/**
 * Client-side crypto for the Cryptographic Dead Man's Switch's Emergency
 * Vault (AGENTS.md §3t).
 *
 * Deliberately its own module, not a reuse of src/lib/zk-crypto.ts —
 * that module's `deriveZkKey` produces a key with `extractable: false`
 * specifically so the raw key bytes can NEVER be pulled out of the
 * browser, by design (§3m). Shamir's Secret Sharing (src/lib/shamir-
 * secret-sharing.ts) fundamentally needs the raw key bytes to split, so
 * this vault necessarily derives its own, separately-keyed, EXTRACTABLE
 * master key — a deliberately different, weaker-sounding but
 * functionally NECESSARY security property (recoverable custody) than
 * the zk-vault's true zero-knowledge. See DeadMansSwitch's model comment
 * for the full rationale.
 *
 * Like zk-crypto.ts, everything here runs on the standard WebCrypto
 * `SubtleCrypto` API, spec-identical in the browser and Node, so this
 * module is plain pure-function testable. What actually keeps key
 * DERIVATION and document ENCRYPTION client-only is
 * tests/guards/dead-mans-switch-crypto-client-only.test.ts (mirroring
 * zk-client-only.test.ts) — the correct enforcement point is "no
 * src/server/** file ever imports this," not a runtime check.
 *
 * The one deliberate asymmetry with zk-crypto.ts: DECRYPTING an
 * EmergencyDocument during a successful recovery happens server-side
 * (src/server/dead-mans-switch/vault-cipher-node.ts, a Node-crypto
 * companion producing byte-identical output for this module's "dms1:"
 * ciphertext format) — not a client-only operation, because recovery
 * fundamentally requires the server to combine >= threshold shares
 * server-side first (see RecoveryShareSubmission's model comment); once
 * it holds the reconstructed key it decrypts every document in that one
 * response and never persists the plaintext or the key. This module's
 * own decrypt function still exists and is still used client-side too
 * (the vault owner reading their own documents back while ACTIVE).
 */

import { assertFiniteInteger } from "./money";

export const DMS_PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH_BYTES = 16;
const IV_LENGTH_BYTES = 12; // 96-bit IV, the AES-GCM-recommended size.
/** Raw AES-256 key material — 32 bytes, exactly what splitSecret shards. */
export const DMS_KEY_LENGTH_BYTES = 32;

/** This module's ciphertext format version — distinct from zk-crypto.ts's "zk1:" and field-encryption.ts's "v1:", so a value's prefix alone tells you which scheme (and therefore which custody model) it's under. */
export const DMS_FORMAT_VERSION = "dms1";

/** A fixed, non-secret plaintext encrypted under the freshly-derived (or freshly-reconstructed) master key. Verifying a candidate key — whether from a re-entered passphrase, or from combining recovered shares — means attempting to decrypt this and checking the result, exactly the same non-leaking verification `zk-crypto.ts`'s canary already established (§3m). */
export const DMS_CANARY_PLAINTEXT = "pfw-dead-mans-switch-vault-canary-v1";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A fresh random salt for a new vault setup. Not secret — stored server-side as-is, same as `User.zkSalt`. */
export function generateVaultSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES)));
}

/**
 * Derives raw AES-256 key bytes from a recovery passphrase + salt via
 * PBKDF2-HMAC-SHA256, using `deriveBits` (not `deriveKey`) specifically
 * because the whole point of this module — unlike zk-crypto.ts's
 * `deriveZkKey` — is to hand back bytes that `splitSecret` can shard.
 * The returned bytes are exactly `DMS_KEY_LENGTH_BYTES` long; callers
 * that only need to encrypt/decrypt (not split) should import them via
 * `importVaultAesKey` immediately and let the raw `Uint8Array` go out of
 * scope rather than holding onto it any longer than necessary.
 */
export async function deriveVaultKeyBytes(passphrase: string, saltBase64: string, iterations: number): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveBits",
  ]);

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromBase64(saltBase64) as BufferSource, iterations, hash: "SHA-256" },
    baseKey,
    DMS_KEY_LENGTH_BYTES * 8,
  );

  return new Uint8Array(bits);
}

/** Imports raw key bytes as a non-extractable AES-256-GCM `CryptoKey` for actual encrypt/decrypt operations — the raw bytes themselves are what gets split/reconstructed; the imported `CryptoKey` never needs to be extractable again once this is called. */
export async function importVaultAesKey(rawKeyBytes: Uint8Array): Promise<CryptoKey> {
  if (rawKeyBytes.length !== DMS_KEY_LENGTH_BYTES) {
    throw new RangeError(`Vault key must be exactly ${DMS_KEY_LENGTH_BYTES} bytes, got ${rawKeyBytes.length}`);
  }
  return crypto.subtle.importKey("raw", rawKeyBytes as BufferSource, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** `dms1:<iv base64>:<ciphertext+tag base64>` — WebCrypto's AES-GCM appends the auth tag to the ciphertext itself. */
export async function encryptVaultValue(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return [DMS_FORMAT_VERSION, toBase64(iv), toBase64(new Uint8Array(ciphertext))].join(":");
}

/** Throws (auth-tag failure) if `key` is wrong or `stored` was tampered with. */
export async function decryptVaultValue(key: CryptoKey, stored: string): Promise<string> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== DMS_FORMAT_VERSION) {
    throw new RangeError(`Unrecognized vault ciphertext format: expected "${DMS_FORMAT_VERSION}:iv:ciphertext"`);
  }
  const [, ivB64, ciphertextB64] = parts;

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivB64) as BufferSource },
    key,
    fromBase64(ciphertextB64) as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

/** Never throws on a wrong key — that's an expected, not exceptional, outcome (mirrors `verifyZkKey`). Used both by the owner (confirming a re-entered passphrase) and by the recovery service (confirming combined shares reconstructed the right key before it ever attempts to decrypt a real document). */
export async function verifyVaultKey(key: CryptoKey, canaryCiphertext: string): Promise<boolean> {
  try {
    return (await decryptVaultValue(key, canaryCiphertext)) === DMS_CANARY_PLAINTEXT;
  } catch {
    return false;
  }
}

/** Validates totalShares/thresholdShares against Shamir's own limits (src/lib/shamir-secret-sharing.ts) plus this feature's own sanity bounds, shared by the setup form and (redundantly, defense-in-depth) the server-side Zod validation — same "validate at every trust boundary" law every other input in this app follows. */
export function assertValidShareConfig(totalShares: number, thresholdShares: number): void {
  assertFiniteInteger(totalShares, "totalShares");
  assertFiniteInteger(thresholdShares, "thresholdShares");
  if (totalShares < 2 || totalShares > 255) {
    throw new RangeError(`totalShares must be between 2 and 255, got ${totalShares}`);
  }
  if (thresholdShares < 2 || thresholdShares > totalShares) {
    throw new RangeError(`thresholdShares must be between 2 and totalShares (${totalShares}), got ${thresholdShares}`);
  }
}
