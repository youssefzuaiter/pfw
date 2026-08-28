import { afterEach, describe, expect, it, vi } from "vitest";
import { checkEmbeddingSidecarHealth, EmbeddingSidecarError, embedMerchantTexts } from "./sidecar-client";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("embedMerchantTexts()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty array immediately for an empty input, without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await embedMerchantTexts([], { fetchImpl });
    expect(result).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the texts and returns the embeddings from a successful response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ embeddings: [[0.1, 0.2]], dimensions: 2, model_version: "v1" }),
    );
    const result = await embedMerchantTexts(["Netflix"], { baseUrl: "http://sidecar.test", fetchImpl });

    expect(result).toEqual([[0.1, 0.2]]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://sidecar.test/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ texts: ["Netflix"] }),
      }),
    );
  });

  it("throws EmbeddingSidecarError on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ detail: "bad request" }, { status: 422 }));
    await expect(embedMerchantTexts(["x"], { fetchImpl })).rejects.toThrow(EmbeddingSidecarError);
  });

  it("wraps a network failure in EmbeddingSidecarError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(embedMerchantTexts(["x"], { fetchImpl })).rejects.toThrow(EmbeddingSidecarError);
  });

  it("wraps a timeout (AbortError) in EmbeddingSidecarError with a clear message", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    });
    await expect(embedMerchantTexts(["x"], { fetchImpl, timeoutMs: 10 })).rejects.toThrow(/timed out/);
  });
});

describe("checkEmbeddingSidecarHealth()", () => {
  it("returns true when the sidecar reports ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", dimensions: 384, model_version: "v1" }));
    expect(await checkEmbeddingSidecarHealth({ fetchImpl })).toBe(true);
  });

  it("returns false on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { status: 503 }));
    expect(await checkEmbeddingSidecarHealth({ fetchImpl })).toBe(false);
  });

  it("returns false rather than throwing when the sidecar is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect(await checkEmbeddingSidecarHealth({ fetchImpl })).toBe(false);
  });
});
