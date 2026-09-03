import { describe, expect, it } from "vitest";
import { needsResync } from "./local-vector-store";

// Only `needsResync` is unit-tested here — this project's installed
// jsdom (29.1.1) implements no IndexedDB at all (confirmed directly:
// `typeof new JSDOM().window.indexedDB === "undefined"`), so
// `openDb`/`syncLocalVectorStore`/`getCachedVectors`/`clearLocalVectorStore`
// have no test-environment IndexedDB to run against — the same category
// of gap `local-embedder.test.ts` already documents for why it mocks
// `@huggingface/transformers` entirely rather than exercising a real
// WASM runtime. `needsResync` was pulled out specifically so the one
// piece of real logic in this module (whether a sync is worth doing at
// all) doesn't share that gap.
describe("needsResync()", () => {
  it("returns true when nothing has ever been cached on this device", () => {
    expect(needsResync(undefined, 0)).toBe(true);
    expect(needsResync(undefined, 42)).toBe(true);
  });

  it("returns false when the cached count already matches the server's count", () => {
    expect(needsResync(42, 42)).toBe(false);
    expect(needsResync(0, 0)).toBe(false);
  });

  it("returns true when the server reports more rows than are cached", () => {
    expect(needsResync(10, 15)).toBe(true);
  });

  it("returns true when the server reports fewer rows than are cached (a transaction was deleted)", () => {
    expect(needsResync(15, 10)).toBe(true);
  });
});
