/**
 * Zero-knowledge client-side encryption primitives for
 * `GoalContribution.note` (AGENTS.md §3m).
 *
 * Everything here runs on the standard WebCrypto `SubtleCrypto` API
 * (`crypto.subtle`), which is spec-identical in the browser and in
 * Node — so this module is plain, pure-function testable like every
 * other `src/lib/` engine (§3b), with no environment-detection branch to
 * fake in a test. What actually keeps this client-only is
 * `tests/guards/zk-client-only.test.ts`, an import-graph guard exactly
 * like `admin-client-boundary.test.ts` (§3a) — the correct enforcement
 * point is "no `src/server/**` file ever imports this," not a runtime
 * `typeof window` check, which would only break testability while adding
 * no real protection (a server file that imported this and called it
 * with a real passphrase would already have the passphrase in hand;
 * the guard test is what stops that file from existing in the first
 * place).
 *
 * The master passphrase and every derived key live in browser memory
 * only (see `src/lib/stores/zk-vault-store.ts`) — never sent to the
 * server, never written to `localStorage`/`sessionStorage`, never
 * logged. The server only ever sees: a random salt, an iteration count,
 * a canary ciphertext, and note ciphertext blobs — none of which reveal
 * the passphrase or the key (see `deriveZkKey`/`ZK_CANARY_PLAINTEXT`).
 */

/** OWASP's 2023 minimum for PBKDF2-HMAC-SHA256. Stored per-user (not hardcoded at
 * the read site) so a future stronger default doesn't invalidate already-derived keys. */
export const PBKDF2_ITERATIONS = 600_000;

const SALT_LENGTH_BYTES = 16;
const IV_LENGTH_BYTES = 12; // 96-bit IV, the AES-GCM-recommended size (matches field-encryption.ts).

/** This module's ciphertext format version. Deliberately distinct from
 * field-encryption.ts's "v1:" — that format's ciphertext is decryptable
 * with the server's ENCRYPTION_KEY; this one, by construction, never is.
 * A note still carrying the OLD "v1:" prefix is a pre-migration legacy
 * row — see zk-vault.ts's migration path. */
export const ZK_FORMAT_VERSION = "zk1";

/** A fixed, non-secret plaintext encrypted under a freshly-derived key at
 * setup time. Verifying a re-entered passphrase means attempting to
 * decrypt this and checking both that AES-GCM's auth tag accepts it
 * (a wrong key fails to decrypt at all) and that the plaintext matches —
 * this reveals nothing about the passphrase itself, only whether a
 * candidate key happens to be the right one. */
export const ZK_CANARY_PLAINTEXT = "pfw-zero-knowledge-canary-v1";

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

/** A fresh random salt for a new vault setup. Not secret — stored server-side as-is. */
export function generateZkSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES)));
}

/**
 * Derives the AES-256-GCM key from a passphrase + salt via PBKDF2-HMAC-SHA256.
 * `extractable: false` — the key material can never be pulled back out of the
 * `CryptoKey` object once derived (not even by this module), which forecloses
 * an entire class of accidental-leak bug (e.g. someone later adding a
 * "log the key for debugging" line) at the platform level rather than by
 * convention alone.
 */
export async function deriveZkKey(passphrase: string, saltBase64: string, iterations: number): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    // `as BufferSource` works around a TS lib.dom.d.ts quirk where a
    // freshly-allocated Uint8Array types as Uint8Array<ArrayBufferLike>
    // rather than the narrower Uint8Array<ArrayBuffer> BufferSource wants
    // — the runtime value is exactly the concrete-buffer array it always
    // was, this only appeases the type checker.
    { name: "PBKDF2", salt: fromBase64(saltBase64) as BufferSource, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** `zk1:<iv base64>:<ciphertext+tag base64>` — WebCrypto's AES-GCM appends the
 * auth tag to the ciphertext itself, unlike Node's `createCipheriv`, which is
 * why this format has one fewer segment than field-encryption.ts's "v1:". */
export async function encryptWithZkKey(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return [ZK_FORMAT_VERSION, toBase64(iv), toBase64(new Uint8Array(ciphertext))].join(":");
}

/** Throws (auth-tag failure) if `key` is wrong or `stored` was tampered with. */
export async function decryptWithZkKey(key: CryptoKey, stored: string): Promise<string> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== ZK_FORMAT_VERSION) {
    throw new RangeError(`Unrecognized zero-knowledge ciphertext format: expected "${ZK_FORMAT_VERSION}:iv:ciphertext"`);
  }
  const [, ivB64, ciphertextB64] = parts;

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivB64) as BufferSource },
    key,
    fromBase64(ciphertextB64) as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

/** True for a value already in this module's format — used to tell an
 * already-migrated note apart from a pre-migration legacy ("v1:") one. */
export function isZkCiphertext(value: string): boolean {
  return value.startsWith(`${ZK_FORMAT_VERSION}:`);
}

/**
 * Verifies a candidate key against the stored canary. Never throws on a
 * wrong passphrase — that's an expected, not exceptional, outcome here.
 */
export async function verifyZkKey(key: CryptoKey, canaryCiphertext: string): Promise<boolean> {
  try {
    return (await decryptWithZkKey(key, canaryCiphertext)) === ZK_CANARY_PLAINTEXT;
  } catch {
    return false;
  }
}
