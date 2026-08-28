import { describe, expect, it } from "vitest";
import { checkEmbeddingSidecarHealth, embedMerchantTexts } from "../../src/server/embeddings/sidecar-client";

/**
 * Exercises the real Python FastAPI/ONNX sidecar (sidecar/) over HTTP —
 * not a mock. Requires `EMBEDDING_SIDECAR_URL` to be set explicitly (same
 * opt-in convention as DATABASE_URL for tests/integration/db.test.ts),
 * so a normal `npm run test` doesn't need the sidecar running:
 *
 *   cd sidecar && source .venv/bin/activate
 *   python -m app.build_model   # once, or whenever the model changes
 *   uvicorn app.main:app --port 8001 &
 *   EMBEDDING_SIDECAR_URL=http://localhost:8001 npm run test:integration
 */
describe.skipIf(!process.env.EMBEDDING_SIDECAR_URL)("embedding sidecar (live HTTP)", () => {
  it("reports healthy", async () => {
    expect(await checkEmbeddingSidecarHealth()).toBe(true);
  });

  it("embeds Hebrew and Latin merchant text into 384-dimension vectors", async () => {
    const [hebrew, latin] = await embedMerchantTexts(["רמי לוי", "Netflix"]);
    expect(hebrew).toHaveLength(384);
    expect(latin).toHaveLength(384);
  });

  it("is deterministic across repeated calls", async () => {
    const [first] = await embedMerchantTexts(["Netflix"]);
    const [second] = await embedMerchantTexts(["Netflix"]);
    expect(first).toEqual(second);
  });
});
