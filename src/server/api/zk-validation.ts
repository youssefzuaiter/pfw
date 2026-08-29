import "server-only";
import { z } from "zod";

/**
 * Server-side shape validation for zero-knowledge vault input (AGENTS.md
 * §3m). The server can never verify these values are *cryptographically*
 * correct — it has no key to check them against — but every one of them
 * is untrusted input crossing a trust boundary like any other request
 * body, so its *shape* is still validated: a malformed or absurdly long
 * value can only fail the request, never get written to the DB or
 * silently corrupt a later read.
 *
 * These constants intentionally duplicate values from `src/lib/zk-crypto.ts`
 * rather than importing them — that module must never be imported from
 * `src/server/**` (`tests/guards/zk-client-only.test.ts`), so the
 * iteration floor here is a server-side floor on client-supplied input,
 * not a shared source of truth with the client's own default.
 */

/** Matches src/lib/zk-crypto.ts's PBKDF2_ITERATIONS — a floor, not an
 * enforced exact match, so a future stronger client default doesn't need
 * a server change to be accepted. */
export const ZK_MIN_PBKDF2_ITERATIONS = 600_000;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+=*$/;

/** A PBKDF2 salt, base64-encoded. Not secret — bounded generously against a garbage/oversized payload. */
export const ZkSaltSchema = z.string().min(8).max(128).regex(BASE64_PATTERN, "must be base64");

/** `zk1:<iv base64>:<ciphertext base64>` — see zk-crypto.ts's format comment. Bounded well above what a short goal-contribution note needs. */
export const ZkCiphertextSchema = z
  .string()
  .min(1)
  .max(4000)
  .regex(/^zk1:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/, "must be a zero-knowledge (zk1:) ciphertext blob");

export const ZkIterationsSchema = z.number().int().min(ZK_MIN_PBKDF2_ITERATIONS).max(10_000_000);
