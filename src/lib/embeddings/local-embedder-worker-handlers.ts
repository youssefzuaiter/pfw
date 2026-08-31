/**
 * The actual Transformers.js pipeline logic `local-embedder.worker.ts`
 * serves (AGENTS.md §3u, §3y) — split into its own module, with no
 * top-level `self`/`postMessage` reference of its own, specifically so
 * it's importable and testable directly (see `local-embedder.test.ts`)
 * without a real Worker global, same reasoning
 * `zk-crypto-worker-handlers.ts` already established (§3x).
 */

import { CURRENT_EMBEDDING_MODEL_ID } from "./embedding-model";

const MODEL_ID = CURRENT_EMBEDDING_MODEL_ID;

type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

export type LocalEmbedderHandlers = {
  embed(payload: { text: string }): Promise<{ embedding: number[] }>;
};

/**
 * One fresh, independent pipeline-cache closure per call — mirrors
 * `createZkCryptoHandlers`'s "one instance per real worker, tests get
 * fresh isolated instances" shape. In production, `local-embedder.worker.ts`
 * calls this exactly once per Worker instance; the WASM runtime and
 * loaded model this closure caches are released for real the moment
 * that Worker is terminated (`local-embedder.ts`'s aggressive
 * terminate/respawn lifecycle, §3y) — something no amount of clearing a
 * main-thread module-level cache could ever actually achieve, since the
 * underlying WASM linear memory only gets reclaimed when its owning
 * realm (the Worker) is destroyed.
 */
export function createLocalEmbedderHandlers(): LocalEmbedderHandlers {
  let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  async function getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");

        // Self-hosted WASM runtime — see local-embedder.ts's header comment.
        env.backends.onnx.wasm!.wasmPaths = "/onnx-runtime/";
        env.backends.onnx.wasm!.numThreads = 1;
        // Model weights still come from the Hugging Face Hub (data, not
        // code) — env.allowRemoteModels stays at its default `true`.
        env.allowLocalModels = false;
        env.useBrowserCache = true;

        // dtype is explicit, not left to Transformers.js's own
        // device-based default resolution (AGENTS.md §3aa) — this
        // model's full-precision weights are ~470MB, confirmed via a
        // real HTTP HEAD against Hugging Face; "q8" (quantized) is
        // ~118MB, still a real increase over the previous model's ~23MB
        // quantized size but the only one of the two worth ever shipping
        // to a browser on a lazy first use.
        return (await pipeline("feature-extraction", MODEL_ID, {
          dtype: "q8",
        })) as unknown as FeatureExtractionPipeline;
      })();
    }
    return pipelinePromise;
  }

  return {
    async embed({ text }) {
      const extractor = await getPipeline();
      const output = await extractor(text, { pooling: "mean", normalize: true });
      return { embedding: Array.from(output.data) };
    },
  };
}
