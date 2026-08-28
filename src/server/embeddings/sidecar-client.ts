import "server-only";
import { getEmbeddingSidecarUrl } from "../env";

const DEFAULT_TIMEOUT_MS = 5_000;

export type EmbedSidecarConfig = {
  baseUrl?: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class EmbeddingSidecarError extends Error {}

type EmbedApiResponse = {
  embeddings: number[][];
  dimensions: number;
  model_version: string;
};

type HealthApiResponse = {
  status: string;
  dimensions: number;
  model_version: string;
};

/**
 * Calls the FastAPI/ONNX sidecar's `POST /embed` endpoint (sidecar/) to
 * turn merchant-name strings into 384-dimension embeddings for Tier 3 of
 * the categorization cascade (src/lib/categorization/tier3-knn.ts). This
 * is a thin HTTP client, not a reimplementation of the model — the
 * embedding computation itself lives entirely in the Python sidecar.
 */
export async function embedMerchantTexts(texts: readonly string[], config: EmbedSidecarConfig = {}): Promise<number[][]> {
  if (texts.length === 0) return [];

  const baseUrl = config.baseUrl ?? getEmbeddingSidecarUrl();
  const fetchImpl = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${baseUrl}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new EmbeddingSidecarError(`Embedding sidecar returned ${response.status}: ${body}`);
    }

    const data = (await response.json()) as EmbedApiResponse;
    return data.embeddings;
  } catch (error) {
    if (error instanceof EmbeddingSidecarError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new EmbeddingSidecarError(`Embedding sidecar request timed out after ${config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
    }
    throw new EmbeddingSidecarError(`Embedding sidecar request failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkEmbeddingSidecarHealth(config: EmbedSidecarConfig = {}): Promise<boolean> {
  const baseUrl = config.baseUrl ?? getEmbeddingSidecarUrl();
  const fetchImpl = config.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(`${baseUrl}/health`);
    if (!response.ok) return false;
    const data = (await response.json()) as HealthApiResponse;
    return data.status === "ok";
  } catch {
    return false;
  }
}
