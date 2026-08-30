import { afterEach, describe, expect, it, vi } from "vitest";
import { EvmRpcError, getEthBalanceWei } from "./evm-rpc-client";

const ADDRESS = "0x1ad7c10de6a97ad325ef1bff74f5b47a448885c7";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "Content-Type": "application/json" } });
}

describe("getEthBalanceWei()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a well-formed eth_getBalance JSON-RPC request and returns the parsed wei balance", async () => {
    // 0xde0b6b3a7640000 = 1 ETH in wei.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }));

    const result = await getEthBalanceWei(ADDRESS, { baseUrl: "http://rpc.test", fetchImpl });

    expect(result).toBe(1_000_000_000_000_000_000n);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://rpc.test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [ADDRESS, "latest"] }),
      }),
    );
  });

  it("returns exact wei for a whale-sized balance beyond Number.MAX_SAFE_INTEGER", async () => {
    // 0x21e19e0c9bab2400000 = 10,000 ETH in wei.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x21e19e0c9bab2400000" }));
    const result = await getEthBalanceWei(ADDRESS, { fetchImpl });
    expect(result).toBe(10_000n * 10n ** 18n);
  });

  it("returns 0n for a zero balance", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x0" }));
    expect(await getEthBalanceWei(ADDRESS, { fetchImpl })).toBe(0n);
  });

  it("throws EvmRpcError on a non-OK HTTP response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 }));
    await expect(getEthBalanceWei(ADDRESS, { fetchImpl })).rejects.toThrow(EvmRpcError);
  });

  it("throws EvmRpcError with the provider's message on a JSON-RPC-level error response (HTTP 200, error field)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid argument 0: json: cannot unmarshal" } }),
    );
    await expect(getEthBalanceWei(ADDRESS, { fetchImpl })).rejects.toThrow(/invalid argument/);
  });

  it("throws EvmRpcError for a malformed/unexpected payload shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ unexpected: "shape" }));
    await expect(getEthBalanceWei(ADDRESS, { fetchImpl })).rejects.toThrow(EvmRpcError);
  });

  it("throws EvmRpcError for a non-hex result field (untrusted input crossing a trust boundary)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: "not-hex" }));
    await expect(getEthBalanceWei(ADDRESS, { fetchImpl })).rejects.toThrow(EvmRpcError);
  });

  it("wraps a network failure in EvmRpcError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(getEthBalanceWei(ADDRESS, { fetchImpl })).rejects.toThrow(EvmRpcError);
  });

  it("wraps a timeout (AbortError) in EvmRpcError with a clear message", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    });
    await expect(getEthBalanceWei(ADDRESS, { fetchImpl, timeoutMs: 10 })).rejects.toThrow(/timed out/);
  });
});
