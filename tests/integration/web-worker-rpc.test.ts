import { describe, expect, it } from "vitest";
import { createRpcClient, serveRpc, type PostMessageTarget } from "../../src/lib/workers/worker-rpc";
import { createZkCryptoHandlers } from "../../src/lib/workers/zk-crypto-worker-handlers";
import { createDmsCryptoHandlers } from "../../src/lib/workers/dead-mans-switch-crypto-worker-handlers";

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
});
