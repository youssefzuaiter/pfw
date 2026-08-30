/**
 * Client-side semantic embedding for the Self-Learning Vector
 * Categorization Engine (AGENTS.md §3u) — turns a transaction's
 * merchant/description text into a 384-dimension vector entirely in the
 * browser, via Transformers.js (`@huggingface/transformers`) running a
 * real sentence-embedding model over WebAssembly. No transaction text
 * ever leaves the device to compute an embedding — a stronger property
 * than the pre-existing Python/ONNX sidecar (`sidecar/`, AGENTS.md §3b),
 * which the sidecar's own docstring already flagged as shipping a
 * placeholder random-projection model rather than a trained one. This
 * module is a genuine upgrade path for that gap, taken client-side
 * rather than by training and redeploying the Python sidecar, per the
 * explicit "Transformers.js running in-browser" ask.
 *
 * Model: `Xenova/all-MiniLM-L6-v2`, mean-pooled + L2-normalized, 384
 * dimensions — deliberately the SAME dimension the schema and Tier 3 KNN
 * engine already documented ("384-dimension embeddings",
 * `MerchantEmbedding.embedding Float[]`) before this pass ever wired
 * anything real into them (confirmed by grep: nothing in the app read or
 * wrote that table until this feature — see AGENTS.md §3u for the full
 * verification). KNOWN LIMITATION, stated plainly rather than
 * overclaimed: this model is primarily English-trained; it is NOT a
 * dedicated multilingual model, so similarity quality for Hebrew-heavy
 * merchant text (this app's seeded mock data, §3h) is expected to be
 * weaker than for English text — the same class of honest caveat the
 * Python sidecar's own placeholder-model docstring already gives.
 *
 * Enforced client-only by tests/guards/local-embedder-client-only.test.ts
 * (same import-graph-guard pattern as zk-crypto.ts, dead-mans-switch-
 * crypto.ts, and receipt-ocr.ts) — no file under src/server/** may
 * import this module. Dynamically `import()`-ed only when a real
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
 */

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");

      // Self-hosted WASM runtime — see this file's header comment.
      env.backends.onnx.wasm!.wasmPaths = "/onnx-runtime/";
      env.backends.onnx.wasm!.numThreads = 1;
      // Model weights still come from the Hugging Face Hub (data, not
      // code) — env.allowRemoteModels stays at its default `true`.
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      return (await pipeline("feature-extraction", MODEL_ID)) as unknown as FeatureExtractionPipeline;
    })();
  }
  return pipelinePromise;
}

/**
 * Computes a 384-dimension, L2-normalized semantic embedding for `text`.
 * Normalization at the model layer (`normalize: true`) means
 * `src/lib/vector-math.ts`'s `cosineSimilarity` reduces to a plain dot
 * product for any two vectors this function returns — still called
 * through the general cosine-similarity function rather than assuming
 * that, so a future embedding source that ISN'T pre-normalized doesn't
 * silently produce wrong similarity scores.
 */
export async function embedText(text: string): Promise<number[]> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

const DEFAULT_EMBEDDING_TIMEOUT_MS = 3_000;

/**
 * Races `embedText` against a timeout and swallows any error, resolving
 * `undefined` instead of rejecting. The one call every UI integration
 * point (inline recategorization, manual transaction entry) should use
 * rather than calling `embedText` directly — a slow first-time model
 * download (a one-time, multi-MB fetch, cached afterward via
 * `env.useBrowserCache`) must never meaningfully block an otherwise-fast
 * interactive action, and an unsupported browser or offline model fetch
 * must degrade to "no embedding this time," never a thrown error the
 * caller has to handle specially.
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

/** Test-only: resets the cached pipeline so tests can inject a fresh mock. */
export function _resetLocalEmbedderForTests(): void {
  pipelinePromise = null;
}
