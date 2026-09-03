/**
 * Client-side cache of this user's transaction search-embedding vectors
 * (AGENTS.md §3cc's `NotableTransaction.searchEmbedding`), stored in
 * IndexedDB — the browser-side half of the Local RAG retrieval pipeline.
 * KNN similarity search against these cached vectors runs entirely in
 * the browser (a later pass, not this file), so a copilot question never
 * needs to send a raw transaction description — or even a query
 * embedding — to the server just to find which transactions are
 * relevant. Only the already-anonymous 384-float vectors and their
 * transaction ids are ever cached here; the underlying transaction TEXT
 * never round-trips into this store.
 *
 * Enforced client-only by
 * tests/guards/local-vector-store-client-only.test.ts, same pattern as
 * every other browser-only module in this app (local-embedder.ts,
 * receipt-ocr.ts, zk-crypto.ts) — `indexedDB` doesn't exist under Node,
 * so a server import would throw the moment any function here actually
 * ran, not merely be redundant.
 *
 * A full re-fetch-and-replace on every sync, not an incremental diff —
 * this app's real scale is a personal ledger (hundreds, not millions, of
 * transactions), the same "an in-memory/full-table pass is the right
 * trade-off here" call `MerchantEmbedding`'s own KNN scan and
 * `listEmbeddingCorrections` already make (AGENTS.md §3c/§3u). The one
 * cheap optimization that IS worth it: skip writing anything at all when
 * the server-reported count matches what's already cached (`needsResync`,
 * exported specifically so this diffing decision is unit-testable
 * without touching IndexedDB at all).
 */

const DB_NAME = "pfw-local-vector-store";
const DB_VERSION = 1;
const VECTORS_STORE = "transactionVectors";
const META_STORE = "meta";
const REMOTE_COUNT_KEY = "remoteCount";

export type CachedVector = { transactionId: string; embedding: number[] };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VECTORS_STORE)) {
        db.createObjectStore(VECTORS_STORE, { keyPath: "transactionId" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open the local vector store"));
  });
}

function readCachedCount(db: IDBDatabase): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(META_STORE, "readonly").objectStore(META_STORE).get(REMOTE_COUNT_KEY);
    request.onsuccess = () => resolve(request.result as number | undefined);
    request.onerror = () => reject(request.error ?? new Error("Failed to read the cached vector count"));
  });
}

function replaceAll(db: IDBDatabase, vectors: readonly CachedVector[], remoteCount: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([VECTORS_STORE, META_STORE], "readwrite");
    const store = tx.objectStore(VECTORS_STORE);
    store.clear();
    for (const vector of vectors) store.put(vector);
    tx.objectStore(META_STORE).put(remoteCount, REMOTE_COUNT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to write the local vector store"));
  });
}

/**
 * Pure — whether a re-sync is worth doing, given what's cached vs. what
 * the server currently reports. `cachedCount === undefined` means
 * "never synced on this device," which always needs a sync. Exported
 * specifically so this decision is directly unit-testable without any
 * IndexedDB involved.
 */
export function needsResync(cachedCount: number | undefined, remoteCount: number): boolean {
  return cachedCount !== remoteCount;
}

export type SyncResult = { synced: boolean; count: number };

/**
 * Fetches this user's current search-embedding vectors from
 * `GET /api/embeddings/export` and, only if the server's count differs
 * from what's already cached on this device, replaces the entire local
 * cache with the fresh set. Safe to call on every copilot open — the
 * common case (nothing changed since last sync) is a cheap network round
 * trip plus a `needsResync` check, no IndexedDB write at all.
 */
export async function syncLocalVectorStore(): Promise<SyncResult> {
  const response = await fetch("/api/embeddings/export");
  if (!response.ok) {
    throw new Error(`Failed to export embeddings: ${response.status}`);
  }
  const body = (await response.json()) as { transactions: CachedVector[]; count: number };

  const db = await openDb();
  const cachedCount = await readCachedCount(db);
  if (!needsResync(cachedCount, body.count)) {
    return { synced: false, count: body.count };
  }

  await replaceAll(db, body.transactions, body.count);
  return { synced: true, count: body.count };
}

/** Every cached vector, for the (not-yet-built) local KNN search step. */
export async function getCachedVectors(): Promise<CachedVector[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(VECTORS_STORE, "readonly").objectStore(VECTORS_STORE).getAll();
    request.onsuccess = () => resolve(request.result as CachedVector[]);
    request.onerror = () => reject(request.error ?? new Error("Failed to read the local vector store"));
  });
}

/** Test/sign-out-only: wipes the cache so a subsequent sync starts fresh. */
export async function clearLocalVectorStore(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([VECTORS_STORE, META_STORE], "readwrite");
    tx.objectStore(VECTORS_STORE).clear();
    tx.objectStore(META_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to clear the local vector store"));
  });
}
