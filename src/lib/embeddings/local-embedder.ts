/**
 * Client-side semantic embedding for the Self-Learning Vector
 * Categorization Engine (AGENTS.md §3u, §3y) — turns a transaction's
 * merchant/description text into a 384-dimension vector entirely in the
 * browser, via Transformers.js (`@huggingface/transformers`) running a
 * real sentence-embedding model over WebAssembly, inside a dedicated Web
 * Worker (`local-embedder.worker.ts`). No transaction text ever leaves
 * the device to compute an embedding — a stronger property than the
 * pre-existing Python/ONNX sidecar (`sidecar/`, AGENTS.md §3b), which the
 * sidecar's own docstring already flagged as shipping a placeholder
 * random-projection model rather than a trained one. This module is a
 * genuine upgrade path for that gap, taken client-side rather than by
 * training and redeploying the Python sidecar, per the explicit
 * "Transformers.js running in-browser" ask.
 *
 * Model (AGENTS.md §3aa): `Xenova/paraphrase-multilingual-MiniLM-L12-v2`,
 * mean-pooled + L2-normalized, 384 dimensions — same dimension as the
 * original `Xenova/all-MiniLM-L6-v2` this replaced (confirmed against
 * the real model's published `config.json`, `hidden_size: 384`, not
 * assumed), so no schema/KNN math changed to accommodate the swap.
 * Genuinely multilingual (the underlying sentence-transformers model
 * covers 50+ languages) — a real fix for the exact gap the previous
 * model's own docstring flagged: Hebrew-heavy merchant text (this app's
 * seeded mock data, §3h) no longer sits far outside the model's training
 * distribution the way it did under an English-primary model.
 *
 * `CURRENT_EMBEDDING_MODEL_ID`/`LOCAL_EMBEDDING_DIMENSIONS` now live in
 * `./embedding-model.ts`, not here — a tiny, side-effect-free sibling
 * module that both this client-only code AND `src/server/**` can import
 * (this file itself still can't be imported server-side; a bare string/
 * number constant carries no browser dependency, so it needs no such
 * guard). `src/server/dal/merchant-embeddings.ts`'s
 * `listEmbeddingCorrections` filters on that id — every
 * `MerchantEmbedding` row is tagged with the model that produced its
 * vector, and a row tagged with a DIFFERENT model is excluded from KNN
 * voting rather than compared via cosine similarity anyway. That's not
 * a nicety: two different models' embedding spaces aren't aligned, so
 * comparing across them doesn't degrade gracefully to "low similarity,"
 * it produces a number with no real meaning — silently swapping this
 * constant without that filter would have risked confidently-wrong
 * categorizations from every pre-existing correction, not just stopped
 * matching them.
 *
 * KNOWN, DELIBERATE trade-off: the multilingual model's own weights are
 * real, verified via HTTP HEAD against the actual Hugging Face files,
 * meaningfully larger than the previous model's — quantized (`dtype:
 * "q8"`, what `local-embedder-worker-handlers.ts` now requests
 * explicitly rather than relying on Transformers.js's device-based
 * default resolution) is ~118MB here vs. ~23MB before; full fp32 would
 * have been ~470MB, which is why quantized is not optional. Still a
 * one-time, lazily-triggered, browser-cached download (same "never on
 * an ordinary page visit" lazy-loading precedent as before) — but a
 * real, larger first-use cost than the previous model had, stated
 * plainly rather than glossed over.
 *
 * Enforced client-only by tests/guards/local-embedder-client-only.test.ts
 * (same import-graph-guard pattern as zk-crypto.ts, dead-mans-switch-
 * crypto.ts, and receipt-ocr.ts) — no file under src/server/** may
 * import this module. The Worker is constructed lazily, only when a real
 * embedding is actually needed (manual transaction entry, inline
 * recategorization) — same lazy-loading precedent as Tesseract.js
 * (§3q) and the R3F hero (§3f), so its WASM runtime and the ~90MB model
 * download never load on an ordinary page visit.
 *
 * WASM runtime self-hosted under public/onnx-runtime/ (not CDN-loaded),
 * same CSP-driven reasoning §3q's Tesseract.js integration already
 * documents: this app's CSP keeps script-src/worker-src at 'self' only,
 * so onnxruntime-web's executable WASM binary is committed to the repo
 * once (~12.9MB) rather than opening those directives to a third-party
 * origin for executable code. `numThreads: 1` deliberately avoids
 * onnxruntime-web's multi-threaded build, which needs
 * SharedArrayBuffer + Cross-Origin-Opener-Policy/Cross-Origin-Embedder-
 * Policy — enabling cross-origin isolation app-wide would risk breaking
 * every other cross-origin fetch this app already relies on (the
 * Frankfurter FX API, the Hugging Face model CDN itself), a much larger
 * blast radius than this one feature justifies. The model WEIGHTS
 * themselves (the actual .onnx binary + tokenizer files, fetched from
 * huggingface.co) are data, never executed as script — same treatment
 * src/proxy.ts already gives Tesseract's English language-data fetch
 * from cdn.jsdelivr.net: a narrow connect-src exception, not a
 * script-src one.
 *
 * WASM LIFECYCLE (§3y): before this pass, the loaded pipeline lived in a
 * module-level cache on the main thread for the rest of the page's
 * life — once warmed, that WASM linear memory + model weights were
 * pinned in memory until the tab closed, no matter how the feature was
 * actually used afterward. Moving the pipeline into a Worker doesn't by
 * itself change that (a Worker that's simply never terminated holds its
 * memory exactly as long); what actually changes it is
 * `terminateEmbedderWorker()`, which `embedBatch` calls automatically
 * the moment a batch of embeddings finishes — terminating the Worker
 * tears down its whole realm, WASM memory included, something no amount
 * of main-thread cache-clearing could ever do. A single one-off
 * `embedText`/`embedTextWithTimeout` call (the common case — inline
 * recategorization, one transaction at a time) deliberately does NOT
 * auto-terminate: respawning a fresh Worker (and re-running WASM
 * instantiation) on every call would make the common case slower for no
 * memory-pressure reason worth paying for; the aggressive cleanup is
 * reserved for the case that actually justifies it, a batch of many
 * embeddings computed back to back.
 */

import { createRpcClient, type RpcCall } from "../workers/worker-rpc";

export { LOCAL_EMBEDDING_DIMENSIONS } from "./embedding-model";

let worker: Worker | null = null;
let call: RpcCall | null = null;

function getCall(): RpcCall {
  if (!call) {
    worker = new Worker(new URL("./local-embedder.worker.ts", import.meta.url), { type: "module" });
    call = createRpcClient(worker);
  }
  return call;
}

/**
 * Computes a 384-dimension, L2-normalized semantic embedding for `text`,
 * via the (lazily-constructed, then kept warm) embedding Worker.
 * Normalization at the model layer means `src/lib/vector-math.ts`'s
 * `cosineSimilarity` reduces to a plain dot product for any two vectors
 * this function returns — still called through the general
 * cosine-similarity function rather than assuming that, so a future
 * embedding source that ISN'T pre-normalized doesn't silently produce
 * wrong similarity scores.
 */
export async function embedText(text: string): Promise<number[]> {
  const { embedding } = await getCall()<{ embedding: number[] }>("embed", { text });
  return embedding;
}

const DEFAULT_EMBEDDING_TIMEOUT_MS = 3_000;

/**
 * Races `embedText` against a timeout and swallows any error, resolving
 * `undefined` instead of rejecting. The one call every UI integration
 * point (inline recategorization, manual transaction entry) should use
 * rather than calling `embedText` directly — a slow first-time model
 * download/Worker spin-up (a one-time, multi-MB fetch, cached afterward
 * via `env.useBrowserCache`) must never meaningfully block an otherwise-
 * fast interactive action, and an unsupported browser or offline model
 * fetch must degrade to "no embedding this time," never a thrown error
 * the caller has to handle specially.
 */
export async function embedTextWithTimeout(
  text: string,
  timeoutMs: number = DEFAULT_EMBEDDING_TIMEOUT_MS,
): Promise<number[] | undefined> {
  try {
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs));
    return await Promise.race([embedText(text), timeout]);
  } catch {
    return undefined;
  }
}

/**
 * Computes embeddings for several texts through the SAME warm Worker —
 * paying the model-load cost once for the whole batch, not once per
 * text — then aggressively terminates that Worker the instant every
 * item has settled (§3y). A subsequent call, whether `embedText` or
 * another `embedBatch`, lazily respawns a fresh Worker on demand; the
 * only real cost of respawning is re-running WASM instantiation, since
 * the model weights themselves stay in the browser's HTTP cache
 * (`env.useBrowserCache`) across Worker instances. Each item still goes
 * through `embedTextWithTimeout`, so one slow/stuck text degrades to
 * `undefined` for that item alone rather than holding up the rest of
 * the batch or the cleanup that follows it.
 */
export async function embedBatch(texts: string[]): Promise<(number[] | undefined)[]> {
  const results = await Promise.all(texts.map((text) => embedTextWithTimeout(text)));
  terminateEmbedderWorker();
  return results;
}

/**
 * Immediately tears down the embedding Worker, releasing its WASM
 * runtime and loaded model back to the browser — the "aggressive"
 * cleanup half of this module's WASM lifecycle policy (§3y). Safe to
 * call even when no Worker is currently running (a no-op). Exported
 * (not just used internally by `embedBatch`) so a caller with its own
 * notion of "batch" — e.g. a future bulk-import flow that embeds many
 * transactions through repeated `embedText` calls rather than one
 * `embedBatch` call — can invoke the same policy explicitly.
 */
export function terminateEmbedderWorker(): void {
  worker?.terminate();
  worker = null;
  call = null;
}

/** Test-only: tears down any active worker/client so tests get a fresh instance. */
export function _resetLocalEmbedderForTests(): void {
  terminateEmbedderWorker();
}
