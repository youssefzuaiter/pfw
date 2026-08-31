import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_EMBEDDING_MODEL_ID } from "./embedding-model";

/**
 * Mocks `@huggingface/transformers` entirely — this suite never loads a
 * real model or WASM runtime (that would need a real browser and a
 * multi-MB network fetch, neither available/desirable in a unit test).
 * What's actually under test is `createLocalEmbedderHandlers`'s own
 * logic around the model: the pooling/normalize options passed to the
 * pipeline, and the pipeline singleton caching within one handler
 * instance — see local-embedder.ts's own doc comment for why the
 * model's semantic quality itself isn't something a unit test can
 * meaningfully assert on anyway.
 *
 * This tests `local-embedder-worker-handlers.ts` directly, not
 * `local-embedder.ts` — the latter is now a thin main-thread client that
 * constructs a real `Worker`, which neither this project's "unit" (Node)
 * nor "component" (jsdom) vitest environment provides (same reasoning
 * `zk-crypto-worker-handlers.ts`/`dead-mans-switch-crypto-worker-
 * handlers.ts` are tested directly rather than through their `.worker.ts`
 * entry files, §3x). `local-embedder.ts`'s own Worker-lifecycle
 * orchestration (`embedBatch`'s terminate-after-batch behavior) is
 * verified live, in a real browser, instead — see AGENTS.md §3y.
 */
const pipelineMock = vi.fn();
vi.mock("@huggingface/transformers", () => ({
  pipeline: (...args: unknown[]) => pipelineMock(...args),
  env: { backends: { onnx: { wasm: {} } } },
}));

describe("createLocalEmbedderHandlers", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("embed() returns the pipeline's mean-pooled, normalized output as a plain array", async () => {
    pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2, 0.3]) }));
    const { createLocalEmbedderHandlers } = await import("./local-embedder-worker-handlers");
    const handlers = createLocalEmbedderHandlers();

    const result = await handlers.embed({ text: "coffee shop" });
    expect(result).toEqual({ embedding: [Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)] });
  });

  it("embed() calls the pipeline with pooling=mean and normalize=true", async () => {
    const extractor = vi.fn().mockResolvedValue({ data: [1, 2, 3] });
    pipelineMock.mockResolvedValue(extractor);
    const { createLocalEmbedderHandlers } = await import("./local-embedder-worker-handlers");
    const handlers = createLocalEmbedderHandlers();

    await handlers.embed({ text: "supermarket" });
    expect(extractor).toHaveBeenCalledWith("supermarket", { pooling: "mean", normalize: true });
  });

  it("only initializes the pipeline once across multiple embed() calls on the SAME handlers instance (singleton caching)", async () => {
    const extractor = vi.fn().mockResolvedValue({ data: [1] });
    pipelineMock.mockResolvedValue(extractor);
    const { createLocalEmbedderHandlers } = await import("./local-embedder-worker-handlers");
    const handlers = createLocalEmbedderHandlers();

    await handlers.embed({ text: "a" });
    await handlers.embed({ text: "b" });
    await handlers.embed({ text: "c" });

    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(3);
  });

  it("a FRESH handlers instance (mirroring a respawned Worker) re-initializes its own pipeline independently", async () => {
    const extractor = vi.fn().mockResolvedValue({ data: [1] });
    pipelineMock.mockResolvedValue(extractor);
    const { createLocalEmbedderHandlers } = await import("./local-embedder-worker-handlers");

    await createLocalEmbedderHandlers().embed({ text: "a" });
    await createLocalEmbedderHandlers().embed({ text: "b" });

    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it("loads the current multilingual model at explicit q8 (quantized) precision, not the device-default resolution (AGENTS.md §3aa)", async () => {
    const extractor = vi.fn().mockResolvedValue({ data: [1] });
    pipelineMock.mockResolvedValue(extractor);
    const { createLocalEmbedderHandlers } = await import("./local-embedder-worker-handlers");
    const handlers = createLocalEmbedderHandlers();

    await handlers.embed({ text: "coffee shop" });

    expect(pipelineMock).toHaveBeenCalledWith("feature-extraction", CURRENT_EMBEDDING_MODEL_ID, { dtype: "q8" });
  });

  it("propagates a pipeline failure as a rejection (no silent swallowing at this layer — that's local-embedder.ts's embedTextWithTimeout's job)", async () => {
    pipelineMock.mockRejectedValue(new Error("model failed to load"));
    const { createLocalEmbedderHandlers } = await import("./local-embedder-worker-handlers");
    const handlers = createLocalEmbedderHandlers();

    await expect(handlers.embed({ text: "broken" })).rejects.toThrow("model failed to load");
  });
});
