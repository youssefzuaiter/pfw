import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Mocks `@huggingface/transformers` entirely — this suite never loads a
 * real model or WASM runtime (that would need a real browser and a
 * multi-MB network fetch, neither available/desirable in a unit test).
 * What's actually under test is this module's OWN logic around the
 * model: the timeout race in `embedTextWithTimeout` and the pipeline
 * singleton caching in `getPipeline` — see local-embedder.ts's own doc
 * comment for why the model's semantic quality itself isn't something a
 * unit test can meaningfully assert on anyway.
 */
const pipelineMock = vi.fn();
vi.mock("@huggingface/transformers", () => ({
  pipeline: (...args: unknown[]) => pipelineMock(...args),
  env: { backends: { onnx: { wasm: {} } } },
}));

describe("embedText / embedTextWithTimeout", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();
    const { _resetLocalEmbedderForTests } = await import("./local-embedder");
    _resetLocalEmbedderForTests();
  });

  it("embedText returns the pipeline's mean-pooled, normalized output as a plain array", async () => {
    pipelineMock.mockResolvedValue(
      vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2, 0.3]) }),
    );
    const { embedText } = await import("./local-embedder");

    const result = await embedText("coffee shop");
    expect(result).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
  });

  it("embedText calls the pipeline with pooling=mean and normalize=true", async () => {
    const extractor = vi.fn().mockResolvedValue({ data: [1, 2, 3] });
    pipelineMock.mockResolvedValue(extractor);
    const { embedText } = await import("./local-embedder");

    await embedText("supermarket");
    expect(extractor).toHaveBeenCalledWith("supermarket", { pooling: "mean", normalize: true });
  });

  it("only initializes the pipeline once across multiple embedText calls (singleton caching)", async () => {
    const extractor = vi.fn().mockResolvedValue({ data: [1] });
    pipelineMock.mockResolvedValue(extractor);
    const { embedText } = await import("./local-embedder");

    await embedText("a");
    await embedText("b");
    await embedText("c");

    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(3);
  });

  it("embedTextWithTimeout resolves the real embedding when it completes before the timeout", async () => {
    const extractor = vi.fn().mockResolvedValue({ data: [9, 9, 9] });
    pipelineMock.mockResolvedValue(extractor);
    const { embedTextWithTimeout } = await import("./local-embedder");

    const result = await embedTextWithTimeout("fast", 1000);
    expect(result).toEqual([9, 9, 9]);
  });

  it("embedTextWithTimeout resolves undefined (never rejects) when the pipeline never resolves in time", async () => {
    vi.useFakeTimers();
    pipelineMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { embedTextWithTimeout } = await import("./local-embedder");

    const resultPromise = embedTextWithTimeout("slow", 50);
    await vi.advanceTimersByTimeAsync(51);

    await expect(resultPromise).resolves.toBeUndefined();
  });

  it("embedTextWithTimeout resolves undefined (never rejects) when the pipeline itself throws", async () => {
    pipelineMock.mockRejectedValue(new Error("model failed to load"));
    const { embedTextWithTimeout } = await import("./local-embedder");

    await expect(embedTextWithTimeout("broken", 1000)).resolves.toBeUndefined();
  });
});
