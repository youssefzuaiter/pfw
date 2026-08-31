import { describe, expect, it, vi } from "vitest";
import { createRpcClient, serveRpc, type PostMessageTarget } from "../../src/lib/workers/worker-rpc";
import { createZkCryptoHandlers } from "../../src/lib/workers/zk-crypto-worker-handlers";
import { createDmsCryptoHandlers } from "../../src/lib/workers/dead-mans-switch-crypto-worker-handlers";
import { createLocalEmbedderHandlers } from "../../src/lib/embeddings/local-embedder-worker-handlers";

// local-embedder-worker-handlers.ts dynamically imports
// @huggingface/transformers — mocked here the same way
// local-embedder.test.ts mocks it, so this file never loads a real
// model/WASM runtime either.
const embeddingPipelineMock = vi.fn().mockResolvedValue(
  vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2, 0.3]) }),
);
vi.mock("@huggingface/transformers", () => ({
  pipeline: (...args: unknown[]) => embeddingPipelineMock(...args),
  env: { backends: { onnx: { wasm: {} } } },
}));

/**
 * Integration coverage for this app's Web Worker message-passing protocol
 * (AGENTS.md §3x) — no real `Worker` thread (neither this project's
 * "node" nor "jsdom" vitest environment provides one), but a real,
 * two-sided `postMessage`/`addEventListener` channel connecting an
 * ACTUAL `createRpcClient` (the main-thread side) to an ACTUAL
 * `serveRpc` (the worker side), delivering messages asynchronously via
 * `queueMicrotask` — close enough to a real Worker's async delivery to
 * catch request/response mis-pairing bugs, while still running in plain
 * Node. `zk-crypto.worker.ts`/`dead-mans-switch-crypto.worker.ts`
 * themselves stay untested directly (they're one line of real Worker
 * wiring that can't run outside an actual Worker) — what's tested here
 * is their handler factories, which is 100% of the logic those files
 * contain.
 */

type FakeEndpoint = PostMessageTarget & {
  /** Test-only hook: fires this side's registered "error" listeners directly, simulating the worker script itself crashing (a real `Worker`'s "error" event has no message-channel equivalent to trigger it through `postMessage`). */
  emitError(event: { message: string }): void;
};

/** A minimal two-sided `postMessage` channel: whatever `a` posts, `b` receives as a "message" event, and vice versa — the same shape a real Worker's `postMessage`/`onmessage` pairing has from either side of the boundary. */
function createChannelPair(): [FakeEndpoint, FakeEndpoint] {
  const aListeners = { message: new Set<(e: { data: unknown }) => void>(), error: new Set<(e: { message: string }) => void>() };
  const bListeners = { message: new Set<(e: { data: unknown }) => void>(), error: new Set<(e: { message: string }) => void>() };

  function makeSide(own: typeof aListeners, other: typeof aListeners): FakeEndpoint {
    return {
      postMessage(message: unknown) {
        queueMicrotask(() => {
          for (const listener of other.message) listener({ data: message });
        });
      },
      addEventListener(type: "message" | "error", listener: (event: never) => void) {
        (type === "message" ? own.message : own.error).add(listener as never);
      },
      emitError(event) {
        for (const listener of own.error) listener(event);
      },
    };
  }

  return [makeSide(aListeners, bListeners), makeSide(bListeners, aListeners)];
}

describe("worker-rpc protocol", () => {
  it("resolves a call with the handler's return value, round-tripped through two real postMessage-shaped endpoints", async () => {
    const [mainSide, workerSide] = createChannelPair();
    serveRpc({ double: (payload: { n: number }) => ({ result: payload.n * 2 }) }, workerSide);
    const call = createRpcClient(mainSide);

    await expect(call("double", { n: 21 })).resolves.toEqual({ result: 42 });
  });

  it("rejects with a clear error for a method the worker doesn't serve", async () => {
    const [mainSide, workerSide] = createChannelPair();
    serveRpc({}, workerSide);
    const call = createRpcClient(mainSide);

    await expect(call("nonexistent")).rejects.toThrow("Unknown RPC method: nonexistent");
  });

  it("propagates a handler's thrown error message as the rejection", async () => {
    const [mainSide, workerSide] = createChannelPair();
    serveRpc(
      {
        explode: () => {
          throw new Error("vault is locked");
        },
      },
      workerSide,
    );
    const call = createRpcClient(mainSide);

    await expect(call("explode")).rejects.toThrow("vault is locked");
  });

  it("resolves concurrent in-flight calls to their own responses, never cross-resolved", async () => {
    const [mainSide, workerSide] = createChannelPair();
    // "slow" resolves after "fast" despite being called first, so a
    // naive implementation that matched responses by arrival order
    // (rather than by id) would pair them backwards.
    serveRpc(
      {
        slow: () => new Promise((resolve) => setTimeout(() => resolve("slow-result"), 20)),
        fast: () => "fast-result",
      },
      workerSide,
    );
    const call = createRpcClient(mainSide);

    const [slow, fast] = await Promise.all([call("slow"), call("fast")]);
    expect(slow).toBe("slow-result");
    expect(fast).toBe("fast-result");
  });

  it("rejects every still-pending call when the worker side reports an error event, e.g. the worker script itself crashing", async () => {
    const [mainSide] = createChannelPair();
    // Never wire a serveRpc to the other side at all — nothing will ever
    // respond, matching a worker that crashed before it could reply.
    const call = createRpcClient(mainSide);

    const pending = call("anything");
    mainSide.emitError({ message: "Uncaught SyntaxError in worker script" });

    await expect(pending).rejects.toThrow("Uncaught SyntaxError in worker script");
  });
});

describe("zk-crypto worker handlers, over the real RPC protocol", () => {
  it("setup -> encrypt -> decrypt round-trips a note, and the key never appears in any message that crossed the channel", async () => {
    const [mainSide, workerSide] = createChannelPair();
    const sentPayloads: unknown[] = [];
    const originalPostMessage = mainSide.postMessage.bind(mainSide);
    mainSide.postMessage = (message: unknown) => {
      sentPayloads.push(message);
      originalPostMessage(message);
    };

    serveRpc(createZkCryptoHandlers(), workerSide);
    const call = createRpcClient(mainSide);

    const { canaryCiphertext } = await call<{ canaryCiphertext: string }>("setup", {
      passphrase: "a reasonably long test passphrase",
      saltBase64: "dGVzdC1zYWx0LTE2Ynl0ZXM=",
      iterations: 100,
    });
    expect(canaryCiphertext).toMatch(/^zk1:/);

    const { ciphertext } = await call<{ ciphertext: string }>("encrypt", { plaintext: "top secret note" });
    const { plaintext } = await call<{ plaintext: string }>("decrypt", { ciphertext });
    expect(plaintext).toBe("top secret note");

    // Every response this worker ever sent back is JSON-serializable
    // (a CryptoKey isn't) — flattened to a string, none of them mention
    // a key object crossing the boundary rather than a plain payload.
    for (const payload of sentPayloads) {
      expect(JSON.stringify(payload)).not.toContain("CryptoKey");
    }
  });

  it("unlock with the wrong passphrase resolves false rather than throwing, and never activates a key", async () => {
    const [setupMain, setupWorker] = createChannelPair();
    serveRpc(createZkCryptoHandlers(), setupWorker);
    const setupCall = createRpcClient(setupMain);

    const salt = "dGVzdC1zYWx0LTE2Ynl0ZXM=";
    const { canaryCiphertext } = await setupCall<{ canaryCiphertext: string }>("setup", {
      passphrase: "the real passphrase",
      saltBase64: salt,
      iterations: 100,
    });

    // A fresh handler instance never saw the real setup — mirrors a
    // second browser tab that never unlocked.
    const [freshMain, freshWorker] = createChannelPair();
    serveRpc(createZkCryptoHandlers(), freshWorker);
    const freshCall = createRpcClient(freshMain);

    await expect(
      freshCall("unlock", { passphrase: "a wrong guess", saltBase64: salt, iterations: 100, canaryCiphertext }),
    ).resolves.toEqual({ valid: false });

    // Still locked — the wrong-passphrase unlock above never activated a key on this instance.
    await expect(freshCall("encrypt", { plaintext: "x" })).rejects.toThrow(/locked/i);
  });

  it("rotate: wrong old passphrase resolves valid:false and touches nothing", async () => {
    const [setupMain, setupWorker] = createChannelPair();
    serveRpc(createZkCryptoHandlers(), setupWorker);
    const setupCall = createRpcClient(setupMain);

    const oldSalt = "dGVzdC1zYWx0LTE2Ynl0ZXM=";
    const { canaryCiphertext: oldCanary } = await setupCall<{ canaryCiphertext: string }>("setup", {
      passphrase: "the real old passphrase",
      saltBase64: oldSalt,
      iterations: 100,
    });
    const { ciphertext: noteCiphertext } = await setupCall<{ ciphertext: string }>("encrypt", { plaintext: "a real note" });

    const result = await setupCall("rotate", {
      oldPassphrase: "a wrong guess",
      oldSaltBase64: oldSalt,
      oldIterations: 100,
      oldCanaryCiphertext: oldCanary,
      newPassphrase: "brand new passphrase",
      newSaltBase64: "bmV3LXNhbHQtMTZieXRlcyE=",
      newIterations: 100,
      notes: [{ id: "note-1", note: noteCiphertext }],
    });
    expect(result).toEqual({ valid: false });

    // Still unlocked under the ORIGINAL key — a failed rotation attempt
    // never activates anything new nor locks the vault out.
    await expect(setupCall("decrypt", { ciphertext: noteCiphertext })).resolves.toEqual({ plaintext: "a real note" });
  });

  it("rotate: decrypts every note with the old key, re-encrypts under the new key, and activates the new key — old passphrase no longer unlocks, new one does", async () => {
    const [setupMain, setupWorker] = createChannelPair();
    serveRpc(createZkCryptoHandlers(), setupWorker);
    const setupCall = createRpcClient(setupMain);

    const oldSalt = "dGVzdC1zYWx0LTE2Ynl0ZXM=";
    const oldPassphrase = "the real old passphrase";
    const { canaryCiphertext: oldCanary } = await setupCall<{ canaryCiphertext: string }>("setup", {
      passphrase: oldPassphrase,
      saltBase64: oldSalt,
      iterations: 100,
    });
    const { ciphertext: note1 } = await setupCall<{ ciphertext: string }>("encrypt", { plaintext: "first note" });
    const { ciphertext: note2 } = await setupCall<{ ciphertext: string }>("encrypt", { plaintext: "second note" });

    const newSalt = "bmV3LXNhbHQtMTZieXRlcyE=";
    const newPassphrase = "brand new passphrase";
    const result = await setupCall<{ valid: true; newCanaryCiphertext: string; notes: { id: string; note: string }[] }>(
      "rotate",
      {
        oldPassphrase,
        oldSaltBase64: oldSalt,
        oldIterations: 100,
        oldCanaryCiphertext: oldCanary,
        newPassphrase,
        newSaltBase64: newSalt,
        newIterations: 100,
        notes: [
          { id: "note-1", note: note1 },
          { id: "note-2", note: note2 },
        ],
      },
    );
    expect(result.valid).toBe(true);
    expect(result.newCanaryCiphertext).toMatch(/^zk1:/);
    expect(result.notes.map((n) => n.id).sort()).toEqual(["note-1", "note-2"]);
    for (const note of result.notes) expect(note.note).toMatch(/^zk1:/);

    // The rotate call itself already activated the new key on setupCall's
    // instance — re-encrypted note ciphertext decrypts correctly, in place.
    const rotatedNote1 = result.notes.find((n) => n.id === "note-1")!.note;
    await expect(setupCall("decrypt", { ciphertext: rotatedNote1 })).resolves.toEqual({ plaintext: "first note" });

    // NOTE on what "old credentials no longer work" actually means: PBKDF2
    // is a pure deterministic function, so re-deriving with the exact old
    // (passphrase, salt, iterations) tuple against the exact old canary
    // still succeeds here — that's correct, expected math, not a bug.
    // What actually makes the OLD credential set dead is that
    // `rotateZkVaultPassphrase` (src/server/dal/zk-vault.ts) atomically
    // OVERWRITES the stored salt/canary/note-ciphertexts server-side, so
    // there is no longer any stored old salt/canary left to combine with
    // the old passphrase in the first place — that DAL-level guarantee is
    // covered by tests/integration/zk-vault.test.ts, not here. This
    // worker-level test's job is only the crypto/orchestration: a fresh
    // instance DOES unlock with the new passphrase/salt/canary, and the
    // rotated ciphertext decrypts correctly there.
    const [newTabMain, newTabWorker] = createChannelPair();
    serveRpc(createZkCryptoHandlers(), newTabWorker);
    const newTabCall = createRpcClient(newTabMain);
    await expect(
      newTabCall("unlock", {
        passphrase: newPassphrase,
        saltBase64: newSalt,
        iterations: 100,
        canaryCiphertext: result.newCanaryCiphertext,
      }),
    ).resolves.toEqual({ valid: true });
    await expect(newTabCall("decrypt", { ciphertext: rotatedNote1 })).resolves.toEqual({ plaintext: "first note" });
  });
});

describe("dead-man's-switch worker handlers, over the real RPC protocol", () => {
  it("setup splits the master key into distributable shares and never returns raw key bytes, only encoded shares/hashes", async () => {
    const [mainSide, workerSide] = createChannelPair();
    serveRpc(createDmsCryptoHandlers(), workerSide);
    const call = createRpcClient(mainSide);

    const result = await call<{
      salt: string;
      canaryCiphertext: string;
      shares: { index: number; encodedShare: string; shareHash: string }[];
    }>("setup", { passphrase: "household emergency passphrase", iterations: 100, totalShares: 5, thresholdShares: 3 });

    expect(result.canaryCiphertext).toMatch(/^dms1:/);
    expect(result.shares).toHaveLength(5);
    for (const share of result.shares) {
      expect(Object.keys(share).sort()).toEqual(["encodedShare", "index", "shareHash"]);
      expect(share.encodedShare).toMatch(/^dms-share1:/);
      expect(share.shareHash).toMatch(/^[0-9a-f]{64}$/);
    }

    const { ciphertext } = await call<{ ciphertext: string }>("encrypt", { plaintext: "Will is in the safe." });
    const { plaintext } = await call<{ plaintext: string }>("decrypt", { ciphertext });
    expect(plaintext).toBe("Will is in the safe.");
  });

  it("unlock verifies against the stored canary and activates the key only on the correct passphrase", async () => {
    const [setupMain, setupWorker] = createChannelPair();
    serveRpc(createDmsCryptoHandlers(), setupWorker);
    const setupCall = createRpcClient(setupMain);

    const passphrase = "correct horse battery staple recovery";
    const setupResult = await setupCall<{ salt: string; canaryCiphertext: string }>("setup", {
      passphrase,
      iterations: 100,
      totalShares: 3,
      thresholdShares: 2,
    });

    const [freshMain, freshWorker] = createChannelPair();
    serveRpc(createDmsCryptoHandlers(), freshWorker);
    const freshCall = createRpcClient(freshMain);

    await expect(
      freshCall("unlock", {
        passphrase: "wrong passphrase entirely",
        saltBase64: setupResult.salt,
        iterations: 100,
        canaryCiphertext: setupResult.canaryCiphertext,
      }),
    ).resolves.toEqual({ valid: false });
    await expect(freshCall("decrypt", { ciphertext: setupResult.canaryCiphertext })).rejects.toThrow(/locked/i);

    await expect(
      freshCall("unlock", {
        passphrase,
        saltBase64: setupResult.salt,
        iterations: 100,
        canaryCiphertext: setupResult.canaryCiphertext,
      }),
    ).resolves.toEqual({ valid: true });
    // Now genuinely unlocked — a document encrypted here decrypts back correctly.
    const { ciphertext } = await freshCall<{ ciphertext: string }>("encrypt", { plaintext: "recovered document" });
    await expect(freshCall("decrypt", { ciphertext })).resolves.toEqual({ plaintext: "recovered document" });
  });

  it("resplit: wrong passphrase resolves valid:false", async () => {
    const [setupMain, setupWorker] = createChannelPair();
    serveRpc(createDmsCryptoHandlers(), setupWorker);
    const setupCall = createRpcClient(setupMain);

    const setupResult = await setupCall<{ salt: string; canaryCiphertext: string }>("setup", {
      passphrase: "household emergency passphrase",
      iterations: 100,
      totalShares: 5,
      thresholdShares: 3,
    });

    const result = await setupCall("resplit", {
      passphrase: "a wrong guess",
      saltBase64: setupResult.salt,
      iterations: 100,
      canaryCiphertext: setupResult.canaryCiphertext,
      totalShares: 7,
      thresholdShares: 4,
    });
    expect(result).toEqual({ valid: false });
  });

  it("resplit: re-verifies the passphrase, produces a fresh share set at the new total/threshold, and leaves documents untouched (same master key)", async () => {
    const [setupMain, setupWorker] = createChannelPair();
    serveRpc(createDmsCryptoHandlers(), setupWorker);
    const setupCall = createRpcClient(setupMain);

    const passphrase = "household emergency passphrase";
    const setupResult = await setupCall<{ salt: string; canaryCiphertext: string }>("setup", {
      passphrase,
      iterations: 100,
      totalShares: 5,
      thresholdShares: 3,
    });
    const { ciphertext: documentCiphertext } = await setupCall<{ ciphertext: string }>("encrypt", {
      plaintext: "Will is in the safe.",
    });

    const resplitResult = await setupCall<{
      valid: true;
      shares: { index: number; encodedShare: string; shareHash: string }[];
    }>("resplit", {
      passphrase,
      saltBase64: setupResult.salt,
      iterations: 100,
      canaryCiphertext: setupResult.canaryCiphertext,
      totalShares: 7,
      thresholdShares: 4,
    });
    expect(resplitResult.valid).toBe(true);
    expect(resplitResult.shares).toHaveLength(7);
    for (const share of resplitResult.shares) {
      expect(share.encodedShare).toMatch(/^dms-share1:/);
      expect(share.shareHash).toMatch(/^[0-9a-f]{64}$/);
    }

    // Master key is unchanged by a resplit — the document encrypted
    // under it BEFORE the resplit still decrypts correctly on this same
    // (still-unlocked) instance afterward.
    await expect(setupCall("decrypt", { ciphertext: documentCiphertext })).resolves.toEqual({
      plaintext: "Will is in the safe.",
    });
  });

  it("rotate: wrong old passphrase resolves valid:false and touches nothing", async () => {
    const [setupMain, setupWorker] = createChannelPair();
    serveRpc(createDmsCryptoHandlers(), setupWorker);
    const setupCall = createRpcClient(setupMain);

    const setupResult = await setupCall<{ salt: string; canaryCiphertext: string }>("setup", {
      passphrase: "the real old passphrase",
      iterations: 100,
      totalShares: 5,
      thresholdShares: 3,
    });
    const { ciphertext: documentCiphertext } = await setupCall<{ ciphertext: string }>("encrypt", {
      plaintext: "a real document",
    });

    const result = await setupCall("rotate", {
      oldPassphrase: "a wrong guess",
      oldSaltBase64: setupResult.salt,
      oldIterations: 100,
      oldCanaryCiphertext: setupResult.canaryCiphertext,
      newPassphrase: "brand new emergency passphrase",
      newIterations: 100,
      totalShares: 5,
      thresholdShares: 3,
      documents: [{ id: "doc-1", ciphertext: documentCiphertext }],
    });
    expect(result).toEqual({ valid: false });

    // Still unlocked under the ORIGINAL key.
    await expect(setupCall("decrypt", { ciphertext: documentCiphertext })).resolves.toEqual({
      plaintext: "a real document",
    });
  });

  it("rotate: decrypts every document with the old key, re-encrypts + re-splits under a fresh key/salt, and activates the new key — old credentials no longer unlock, new ones do", async () => {
    const [setupMain, setupWorker] = createChannelPair();
    serveRpc(createDmsCryptoHandlers(), setupWorker);
    const setupCall = createRpcClient(setupMain);

    const oldPassphrase = "the real old passphrase";
    const setupResult = await setupCall<{ salt: string; canaryCiphertext: string }>("setup", {
      passphrase: oldPassphrase,
      iterations: 100,
      totalShares: 5,
      thresholdShares: 3,
    });
    const { ciphertext: doc1 } = await setupCall<{ ciphertext: string }>("encrypt", { plaintext: "will" });
    const { ciphertext: doc2 } = await setupCall<{ ciphertext: string }>("encrypt", { plaintext: "passwords" });

    const newPassphrase = "brand new emergency passphrase";
    const result = await setupCall<{
      valid: true;
      newSalt: string;
      newCanaryCiphertext: string;
      documents: { id: string; ciphertext: string }[];
      shares: { index: number; encodedShare: string; shareHash: string }[];
    }>("rotate", {
      oldPassphrase,
      oldSaltBase64: setupResult.salt,
      oldIterations: 100,
      oldCanaryCiphertext: setupResult.canaryCiphertext,
      newPassphrase,
      newIterations: 100,
      totalShares: 5,
      thresholdShares: 3,
      documents: [
        { id: "doc-1", ciphertext: doc1 },
        { id: "doc-2", ciphertext: doc2 },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.newSalt).not.toBe(setupResult.salt);
    expect(result.newCanaryCiphertext).toMatch(/^dms1:/);
    expect(result.documents.map((d) => d.id).sort()).toEqual(["doc-1", "doc-2"]);
    for (const document of result.documents) expect(document.ciphertext).toMatch(/^dms1:/);
    expect(result.shares).toHaveLength(5);

    const rotatedDoc1 = result.documents.find((d) => d.id === "doc-1")!.ciphertext;

    // Same note as the zk-crypto rotate test above: re-deriving with the
    // exact old (passphrase, salt, canary) tuple still succeeds here —
    // PBKDF2 is deterministic, and this worker has no notion of "old" vs
    // "new" on its own. What actually retires the old credential set is
    // `rotateVaultPassphrase` (src/server/dal/dead-mans-switch.ts)
    // atomically overwriting the stored salt/canary/documents/beneficiary
    // shares server-side, covered by tests/integration/dead-mans-switch.test.ts,
    // not here. This test's job is only the crypto/orchestration: a fresh
    // instance DOES unlock with the new passphrase/salt/canary, and the
    // rotated document ciphertext decrypts correctly there.
    const [newTabMain, newTabWorker] = createChannelPair();
    serveRpc(createDmsCryptoHandlers(), newTabWorker);
    const newTabCall = createRpcClient(newTabMain);
    await expect(
      newTabCall("unlock", {
        passphrase: newPassphrase,
        saltBase64: result.newSalt,
        iterations: 100,
        canaryCiphertext: result.newCanaryCiphertext,
      }),
    ).resolves.toEqual({ valid: true });
    await expect(newTabCall("decrypt", { ciphertext: rotatedDoc1 })).resolves.toEqual({ plaintext: "will" });
  });
});

describe("local-embedder worker handlers, over the real RPC protocol", () => {
  it("embed round-trips a merchant text into an embedding vector", async () => {
    const [mainSide, workerSide] = createChannelPair();
    serveRpc(createLocalEmbedderHandlers(), workerSide);
    const call = createRpcClient(mainSide);

    const result = await call<{ embedding: number[] }>("embed", { text: "coffee shop" });
    expect(result.embedding).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
  });

  it("reuses one pipeline across several embed calls on the same channel (a batch, before local-embedder.ts's aggressive terminate/respawn kicks in)", async () => {
    const [mainSide, workerSide] = createChannelPair();
    serveRpc(createLocalEmbedderHandlers(), workerSide);
    const call = createRpcClient(mainSide);

    embeddingPipelineMock.mockClear();
    await call("embed", { text: "a" });
    await call("embed", { text: "b" });
    await call("embed", { text: "c" });

    // The pipeline (the expensive model-load step) is constructed once per
    // handlers instance, not once per call — exactly what makes batching
    // several embeds through one still-warm Worker cheaper than
    // respawning per item, per local-embedder.ts's embedBatch doc comment.
    expect(embeddingPipelineMock).toHaveBeenCalledTimes(1);
  });

  it("a fresh handlers instance (simulating a respawned Worker after termination) starts with no cached pipeline of its own", async () => {
    const [firstMain, firstWorker] = createChannelPair();
    serveRpc(createLocalEmbedderHandlers(), firstWorker);
    await createRpcClient(firstMain)("embed", { text: "before terminate" });

    embeddingPipelineMock.mockClear();

    const [secondMain, secondWorker] = createChannelPair();
    serveRpc(createLocalEmbedderHandlers(), secondWorker);
    await createRpcClient(secondMain)("embed", { text: "after respawn" });

    expect(embeddingPipelineMock).toHaveBeenCalledTimes(1);
  });
});
