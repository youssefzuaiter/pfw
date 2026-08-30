import "server-only";
import { z } from "zod";
import { parseHexQuantity } from "../../lib/crypto/token-units";
import { getEvmRpcUrl } from "../env";

const DEFAULT_TIMEOUT_MS = 5_000;

export class EvmRpcError extends Error {}

const JsonRpcSuccessSchema = z.object({
  jsonrpc: z.string(),
  id: z.union([z.string(), z.number()]),
  result: z.string(),
});
const JsonRpcErrorSchema = z.object({
  jsonrpc: z.string(),
  id: z.union([z.string(), z.number()]),
  error: z.object({ code: z.number(), message: z.string() }),
});

export type EvmRpcConfig = {
  baseUrl?: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Calls a public EVM JSON-RPC endpoint's `eth_getBalance` method — the
 * Advanced Crypto & On-Chain Asset Tracking module's one wallet-balance
 * integration point (AGENTS.md §3w), read-only, no key or credential
 * involved at any point (a public RPC endpoint accepts anonymous
 * requests by design). Returns the balance as `wei` — an exact `bigint`,
 * never a `number` — via `src/lib/crypto/token-units.ts`'s
 * `parseHexQuantity`, since the raw JSON-RPC response is untrusted input
 * crossing a trust boundary like any other and its `result` field must
 * be shape-validated before being trusted as a hex quantity at all.
 *
 * `"latest"` is the standard `eth_getBalance` block-tag parameter,
 * meaning "the current chain tip" — this app never queries a historical
 * balance at a specific block, since a wallet's PAST balance isn't
 * something a runway/net-worth calculation needs (see
 * `computeLiveNetWorth`'s "derived truth, always live" law).
 *
 * Deliberately a thin, low-level function that DOES throw
 * (`EvmRpcError`) on any failure — the resilience/graceful-degradation
 * behavior (never let one unreachable wallet break net-worth
 * computation) lives one layer up, in
 * `src/server/crypto/build-wallet-balances.ts`, matching the same split
 * `sidecar-client.ts`'s `embedMerchantTexts` (throws) vs. its callers'
 * own fallback handling already establishes.
 */
export async function getEthBalanceWei(address: string, config: EvmRpcConfig = {}): Promise<bigint> {
  const baseUrl = config.baseUrl ?? getEvmRpcUrl();
  const fetchImpl = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new EvmRpcError(`EVM RPC endpoint returned HTTP ${response.status}`);
    }

    const body: unknown = await response.json();

    const errorParsed = JsonRpcErrorSchema.safeParse(body);
    if (errorParsed.success) {
      throw new EvmRpcError(`EVM RPC error ${errorParsed.data.error.code}: ${errorParsed.data.error.message}`);
    }

    const successParsed = JsonRpcSuccessSchema.safeParse(body);
    if (!successParsed.success) {
      throw new EvmRpcError(`EVM RPC endpoint returned an unexpected payload: ${successParsed.error.message}`);
    }

    return parseHexQuantity(successParsed.data.result);
  } catch (error) {
    if (error instanceof EvmRpcError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new EvmRpcError(`EVM RPC request timed out after ${config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
    }
    throw new EvmRpcError(`EVM RPC request failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}
