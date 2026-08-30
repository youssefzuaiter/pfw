/**
 * A tiny id-correlated request/response protocol over `postMessage`,
 * shared by every crypto Web Worker in this app (AGENTS.md §3x) — both
 * `zk-crypto.worker.ts` and `dead-mans-switch-crypto.worker.ts` need
 * exactly this machinery (call a named method with a payload, get back a
 * result or an error, correlate concurrent in-flight calls by id) and
 * nothing about it is specific to either one's actual cryptography, so it
 * lives here once rather than being copy-pasted twice.
 *
 * Deliberately structurally typed against the minimal `postMessage` /
 * `addEventListener("message", ...)` surface (`PostMessageTarget` below)
 * rather than against `lib.dom.d.ts`'s `Worker` or `lib.webworker.d.ts`'s
 * `DedicatedWorkerGlobalScope` — this project's tsconfig has a single
 * project-wide `lib` array that includes `"dom"` (for every ordinary
 * client/server file) but not `"webworker"`, and mixing the two globally
 * would mistype every other file's `self`/`window`. Typing against a
 * small local interface instead sidesteps that entirely, and as a bonus
 * makes both sides of this protocol trivially fakeable in tests — see
 * `worker-rpc.test.ts` — without a real `Worker` thread, which
 * `jsdom`/Node (this project's test environments) don't provide.
 */

export type PostMessageTarget = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
};

type RpcRequest = { id: number; method: string; payload: unknown };
type RpcResponse = { id: number } & ({ ok: true; result: unknown } | { ok: false; error: string });

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Worker-side: wires `handlers` (method name -> payload handler) up to
 * `target`'s message channel. Call once, at worker top level. Every
 * response carries back only what the handler explicitly returns — a
 * handler that never returns key material (every handler in this app's
 * two crypto workers) is what actually keeps that key material inside
 * the worker's own memory, not this function's plumbing.
 */
export function serveRpc(
  // `payload: any` (not `unknown`) deliberately: this dispatch table holds
  // handlers with their own specific, mutually different payload types
  // (see zk-crypto.worker.ts/dead-mans-switch-crypto.worker.ts), and
  // TypeScript's contravariant parameter checking would otherwise reject
  // every one of them here even though each handler's payload comes only
  // from this app's own main-thread client for that exact method name —
  // a same-origin, same-codebase protocol, not attacker-controlled input.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers: Record<string, (payload: any) => unknown | Promise<unknown>>,
  target: PostMessageTarget = self as unknown as PostMessageTarget,
): void {
  target.addEventListener("message", (event) => {
    const { id, method, payload } = event.data as RpcRequest;
    void (async () => {
      let response: RpcResponse;
      try {
        const handler = handlers[method];
        if (!handler) throw new Error(`Unknown RPC method: ${method}`);
        response = { id, ok: true, result: await handler(payload) };
      } catch (err) {
        response = { id, ok: false, error: errorMessage(err) };
      }
      target.postMessage(response);
    })();
  });
}

export type RpcCall = <T>(method: string, payload?: unknown) => Promise<T>;

/**
 * Main-thread side: returns a `call(method, payload)` function that posts
 * a request to `target` and resolves/rejects with that request's own
 * response, matched by id — so concurrent calls (e.g. encrypting several
 * documents at once) never cross-resolve each other. A worker-level
 * `error` event (the script itself throwing outside a handler, e.g. a
 * syntax error) rejects every still-pending call, since no per-id
 * response will ever arrive for them otherwise.
 */
export function createRpcClient(target: PostMessageTarget): RpcCall {
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  target.addEventListener("message", (event) => {
    const data = event.data as RpcResponse;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error));
  });

  target.addEventListener("error", (event) => {
    const err = new Error(event.message ?? "Worker error");
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  });

  return function call<T>(method: string, payload?: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      target.postMessage({ id, method, payload } satisfies RpcRequest);
    });
  };
}
