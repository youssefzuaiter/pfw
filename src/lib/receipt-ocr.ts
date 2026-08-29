/**
 * Client-side OCR wrapper around Tesseract.js (AGENTS.md §3q) — the
 * entire reason this feature can claim "the image never leaves your
 * device before you review and submit it": text extraction runs fully
 * in-browser via WebAssembly, and this function is never called from
 * anywhere but a "use client" component (enforced by
 * tests/guards/receipt-ocr-client-only.test.ts, same pattern as
 * `src/lib/zk-crypto.ts`'s guard).
 *
 * The worker script and WASM core are self-hosted under `public/tesseract/`
 * (a single pinned SIMD build — see AGENTS.md §3q for why only one
 * variant is shipped) so `worker-src`/`script-src` in the CSP
 * (src/proxy.ts) can stay scoped to `'self'` rather than a third-party
 * origin for *executable code*. Only the English language training data
 * — a static data file, never executed — is fetched from a CDN at scan
 * time, which is the one narrowly-scoped `connect-src` exception in the
 * CSP.
 */

const WORKER_PATH = "/tesseract/worker.min.js";
const CORE_PATH = "/tesseract/tesseract-core-simd-lstm.wasm.js";
const LANG_PATH = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int";

export type OcrProgress = { status: string; progress: number };

/**
 * Runs OCR on an image file entirely client-side and returns the raw
 * extracted text. Accepts only images (JPEG/PNG/etc.) — PDF text
 * extraction is a deliberately separate concern (a PDF with a text
 * layer needs no OCR at all) and out of scope for this pass; see
 * AGENTS.md §3q's known-limitations note.
 */
export async function recognizeReceiptText(
  image: File | Blob,
  onProgress?: (progress: OcrProgress) => void,
): Promise<string> {
  const { createWorker } = await import("tesseract.js");

  const worker = await createWorker("eng", 1, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    gzip: true,
    logger: onProgress ? (message) => onProgress({ status: message.status, progress: message.progress }) : undefined,
  });

  try {
    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
