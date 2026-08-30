import { afterEach, describe, expect, it, vi } from "vitest";
import { EvmRpcError, getEthBalanceWei } from "./evm-rpc-client";

const ADDRESS = "0x1ad7c10de6a97ad325ef1bff74f5b47a448885c7";
const PRIMARY_URL = "http://primary.rpc.test";
const FALLBACK_A_URL = "http://fallback-a.rpc.test";
const FALLBACK_B_URL = "http://fallback-b.rpc.test";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "Content-Type": "application/json" } });
}

/** A `fetchImpl` double that resolves per-URL, per viem's `fetchFn(url, options)` calling convention — lets a test assert exactly which endpoint(s) in the fallback chain were actually reached, and in what order. */
function fetchImplFor(responses: Record<string, () => Response | Promise<Response>>) {
  const calledUrls: string[] = [];
  const fetchImpl: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
    // viem normalizes a bare-origin URL to include a trailing slash before
    // calling fetchFn (e.g. "http://x.test" -> "http://x.test/") — strip it
    // back off so this test double's keys/assertions can use the plain
    // URLs callers actually configured.
    const url = String(input).replace(/\/$/, "");
    calledUrls.push(url);
    const respond = responses[url];
    if (!respond) throw new Error(`Unexpected URL in test double: ${url}`);
    return respond();
  }) as typeof fetch;
  return { fetchImpl: fetchImpl as typeof fetch & ReturnType<typeof vi.fn>, calledUrls };
}

describe("getEthBalanceWei()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a well-formed eth_getBalance JSON-RPC request to the primary endpoint and returns the parsed wei balance", async () => {
    // 0xde0b6b3a7640000 = 1 ETH in wei.
    const { fetchImpl, calledUrls } = fetchImplFor({
      [PRIMARY_URL]: () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }),
    });

    const result = await getEthBalanceWei(ADDRESS, { baseUrl: PRIMARY_URL, fallbackUrls: [], fetchImpl });

    expect(result).toBe(1_000_000_000_000_000_000n);
    expect(calledUrls).toEqual([PRIMARY_URL]);
    const [, options] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body as string);
    expect(body.method).toBe("eth_getBalance");
    expect(body.params).toEqual([ADDRESS, "latest"]);
  });

  it("returns exact wei for a whale-sized balance beyond Number.MAX_SAFE_INTEGER", async () => {
    // 0x21e19e0c9bab2400000 = 10,000 ETH in wei.
    const { fetchImpl } = fetchImplFor({
      [PRIMARY_URL]: () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x21e19e0c9bab2400000" }),
    });
    const result = await getEthBalanceWei(ADDRESS, { baseUrl: PRIMARY_URL, fallbackUrls: [], fetchImpl });
    expect(result).toBe(10_000n * 10n ** 18n);
  });

  it("returns 0n for a zero balance", async () => {
    const { fetchImpl } = fetchImplFor({ [PRIMARY_URL]: () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x0" }) });
    expect(await getEthBalanceWei(ADDRESS, { baseUrl: PRIMARY_URL, fallbackUrls: [], fetchImpl })).toBe(0n);
  });

  it("rejects a malformed address before ever making a network call", async () => {
    const { fetchImpl, calledUrls } = fetchImplFor({});
    await expect(getEthBalanceWei("not-an-address", { fetchImpl })).rejects.toThrow(EvmRpcError);
    expect(calledUrls).toEqual([]);
  });

  it("throws EvmRpcError when the only endpoint returns a non-OK HTTP response", async () => {
    const { fetchImpl } = fetchImplFor({ [PRIMARY_URL]: () => jsonResponse({}, { status: 500 }) });
    await expect(getEthBalanceWei(ADDRESS, { baseUrl: PRIMARY_URL, fallbackUrls: [], fetchImpl })).rejects.toThrow(
      EvmRpcError,
    );
  });

  it("throws EvmRpcError when the only endpoint returns a JSON-RPC-level error (HTTP 200, error field)", async () => {
    const { fetchImpl } = fetchImplFor({
      [PRIMARY_URL]: () =>
        jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid argument 0: json: cannot unmarshal" } }),
    });
    await expect(getEthBalanceWei(ADDRESS, { baseUrl: PRIMARY_URL, fallbackUrls: [], fetchImpl })).rejects.toThrow(
      /invalid argument/,
    );
  });

  it("throws EvmRpcError for a malformed/unexpected payload shape", async () => {
    const { fetchImpl } = fetchImplFor({ [PRIMARY_URL]: () => jsonResponse({ unexpected: "shape" }) });
    await expect(getEthBalanceWei(ADDRESS, { baseUrl: PRIMARY_URL, fallbackUrls: [], fetchImpl })).rejects.toThrow(
      EvmRpcError,
    );
  });

  it("wraps a network failure in EvmRpcError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      getEthBalanceWei(ADDRESS, { baseUrl: PRIMARY_URL, fallbackUrls: [], fetchImpl }),
    ).rejects.toThrow(EvmRpcError);
  });

  it("wraps a timeout in EvmRpcError with a clear message", async () => {
    // A hanging request that DOES respect the abort signal viem passes
    // through `init.signal` — the same contract a real, slow `fetch()`
    // has — so viem's own internal timeout mechanism fires for real
    // rather than this test injecting a pre-shaped error string.
    const fetchImpl: typeof fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as typeof fetch;
    await expect(
      getEthBalanceWei(ADDRESS, { baseUrl: PRIMARY_URL, fallbackUrls: [], fetchImpl, timeoutMs: 10 }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("getEthBalanceWei() — RPC fallback pipeline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls through to the next endpoint on an HTTP 429 (rate-limited/throttled) primary, and returns its result", async () => {
    const { fetchImpl, calledUrls } = fetchImplFor({
      [PRIMARY_URL]: () => jsonResponse({ error: "rate limited" }, { status: 429 }),
      [FALLBACK_A_URL]: () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }),
    });

    const result = await getEthBalanceWei(ADDRESS, {
      baseUrl: PRIMARY_URL,
      fallbackUrls: [FALLBACK_A_URL],
      fetchImpl,
    });

    expect(result).toBe(1_000_000_000_000_000_000n);
    expect(calledUrls).toEqual([PRIMARY_URL, FALLBACK_A_URL]);
  });

  it("falls through a JSON-RPC-level error (HTTP 200, provider 'can't fulfill' response) exactly like an HTTP-level failure", async () => {
    const { fetchImpl, calledUrls } = fetchImplFor({
      [PRIMARY_URL]: () => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error" } }),
      [FALLBACK_A_URL]: () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }),
    });

    const result = await getEthBalanceWei(ADDRESS, {
      baseUrl: PRIMARY_URL,
      fallbackUrls: [FALLBACK_A_URL],
      fetchImpl,
    });

    expect(result).toBe(1_000_000_000_000_000_000n);
    expect(calledUrls).toEqual([PRIMARY_URL, FALLBACK_A_URL]);
  });

  it("cycles through every endpoint in order — primary throttled, first fallback down, second fallback succeeds", async () => {
    const { fetchImpl, calledUrls } = fetchImplFor({
      [PRIMARY_URL]: () => jsonResponse({}, { status: 429 }),
      [FALLBACK_A_URL]: () => {
        throw new TypeError("fetch failed");
      },
      [FALLBACK_B_URL]: () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x0" }),
    });

    const result = await getEthBalanceWei(ADDRESS, {
      baseUrl: PRIMARY_URL,
      fallbackUrls: [FALLBACK_A_URL, FALLBACK_B_URL],
      fetchImpl,
    });

    expect(result).toBe(0n);
    expect(calledUrls).toEqual([PRIMARY_URL, FALLBACK_A_URL, FALLBACK_B_URL]);
  });

  it("throws EvmRpcError only once EVERY endpoint in the chain has failed, having tried each exactly once", async () => {
    const { fetchImpl, calledUrls } = fetchImplFor({
      [PRIMARY_URL]: () => jsonResponse({}, { status: 429 }),
      [FALLBACK_A_URL]: () => jsonResponse({}, { status: 503 }),
      [FALLBACK_B_URL]: () => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error" } }),
    });

    await expect(
      getEthBalanceWei(ADDRESS, { baseUrl: PRIMARY_URL, fallbackUrls: [FALLBACK_A_URL, FALLBACK_B_URL], fetchImpl }),
    ).rejects.toThrow(EvmRpcError);
    // Exactly once each — no retry-with-backoff multiplying attempts per endpoint (see this file's doc comment on retryCount:0).
    expect(calledUrls).toEqual([PRIMARY_URL, FALLBACK_A_URL, FALLBACK_B_URL]);
  });
});
