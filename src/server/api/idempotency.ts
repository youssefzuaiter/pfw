import "server-only";

/**
 * Idempotency-Key verification (Section 2.4): a client-supplied key lets
 * a retried request (e.g. after a dropped connection) return the exact
 * same result instead of executing the mutation twice. Keyed per-user so
 * one user's key can never collide with another's.
 *
 * In-memory, single-process only — same caveat as rate-limit.ts. A
 * multi-instance Tier 3 deployment needs a shared store instead of this
 * Map, behind the same function signatures.
 */

type StoredResponse = {
  status: number;
  body: unknown;
  storedAt: number;
};

const store = new Map<string, StoredResponse>();
const TTL_MS = 24 * 60 * 60 * 1000;

function scopedKey(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

/** Returns the previously-stored response for this (user, key) pair, or undefined if none exists or it expired. */
export function getIdempotentResponse(userId: string, idempotencyKey: string): StoredResponse | undefined {
  const key = scopedKey(userId, idempotencyKey);
  const cached = store.get(key);
  if (!cached) return undefined;

  if (Date.now() - cached.storedAt > TTL_MS) {
    store.delete(key);
    return undefined;
  }
  return cached;
}

export function storeIdempotentResponse(userId: string, idempotencyKey: string, status: number, body: unknown): void {
  store.set(scopedKey(userId, idempotencyKey), { status, body, storedAt: Date.now() });
}

/** Test-only: clears all stored responses. */
export function _resetIdempotencyStoreForTests(): void {
  store.clear();
}
