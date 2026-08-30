import "server-only";
import { createPublicClient, fallback, http, isAddress, type Address } from "viem";
import { mainnet } from "viem/chains";
import { getEvmRpcUrl } from "../env";

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Two well-known, keyless public Ethereum RPC gateways, tried in this
 * exact order after the primary (AGENTS.md §3x) — same "no new secret to
 * provision" preference `getEvmRpcUrl()`'s own doc comment already
 * states, extended from one endpoint to a real fallback chain so a
 * single provider throttling or outage no longer takes down every
 * wallet balance in one shot.
 *
 * Verified by hand against the live endpoints while building this, not
 * assumed correct from documentation alone — worth recording exactly
 * what was seen, since it directly explains this file's ordering and
 * `shouldThrow`/`retryCount` choices below: a real `eth_getBalance` call
 * against LlamaNodes returned a Cloudflare 521 (origin down) at the
 * time; the identical call against `cloudflare-eth.com` returned HTTP
 * 200 with a JSON-RPC-level `{"error":{"code":-32603,"message":
 * "Internal error"}}` — the same class of failure `getEvmRpcUrl()`'s doc
 * comment already documented for Cloudflare specifically (a different
 * error code that time, -32046, but the same "returns an error for a
 * real balance query" behavior) while `eth_getBalance` calls against
 * `eth_blockNumber`/`eth_chainId` succeed against both. Neither failure
 * mode is a reason to drop either provider from the list — the whole
 * point of a fallback CHAIN is that it tolerates exactly this: any one
 * provider being unreliable at any given moment, transiently or
 * persistently, without breaking the balance lookup as long as at least
 * one of the three is actually up.
 */
const LLAMANODES_RPC_URL = "https://eth.llamarpc.com";
const CLOUDFLARE_RPC_URL = "https://cloudflare-eth.com";

export class EvmRpcError extends Error {}

export type EvmRpcConfig = {
  /** Overrides only the PRIMARY endpoint (defaults to `getEvmRpcUrl()`) — the fallback chain below is always appended after it. */
  baseUrl?: string;
  /** Overrides the fallback chain itself — defaults to [LlamaNodes, Cloudflare]. Injectable so tests can assert cycling behavior against fake URLs instead of the real ones. */
  fallbackUrls?: string[];
  /** Injectable for tests — defaults to the global `fetch`, passed through to every transport in the fallback chain (viem calls it as `fetchFn(url, options)`, so a test double can discriminate by which endpoint was actually reached). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Calls a public EVM JSON-RPC endpoint's `eth_getBalance` method — the
 * Advanced Crypto & On-Chain Asset Tracking module's one wallet-balance
 * integration point (AGENTS.md §3w), read-only, no key or credential
 * involved at any point (a public RPC endpoint accepts anonymous
 * requests by design). Returns the balance as `wei` — an exact `bigint`,
 * never a `number`, which is what `viem`'s own `getBalance` already
 * returns, so `src/lib/crypto/token-units.ts` never has to touch a raw
 * hex string itself anymore.
 *
 * `"latest"` is `getBalance`'s default block tag, meaning "the current
 * chain tip" — this app never queries a historical balance at a specific
 * block, since a wallet's PAST balance isn't something a runway/net-worth
 * calculation needs (see `computeLiveNetWorth`'s "derived truth, always
 * live" law).
 *
 * RPC MULTIPLEXING (§3x): the primary endpoint (`getEvmRpcUrl()`, or
 * `config.baseUrl` to override it) is tried first; on ANY failure —
 * HTTP-level (a 429/5xx, a timeout, a connection error) or JSON-RPC-level
 * (a `{"error": ...}` response body with a 200 status, e.g. a provider
 * that "accepts" but can't fulfill a request) — `viem`'s `fallback`
 * transport moves to the next URL in the chain, in order, until one
 * succeeds or all of them have failed. Each individual transport gets
 * exactly one attempt (`retryCount: 0`, both per-transport and on the
 * fallback wrapper itself) rather than viem's own default retry-with-
 * backoff behavior — deliberately, so the total worst-case latency stays
 * bounded by `timeoutMs` times the number of endpoints, preserving
 * `build-wallet-balances.ts`'s existing per-wallet timeout budget
 * (`PER_WALLET_TIMEOUT_MS`) instead of silently multiplying it by however
 * many retries viem would otherwise attempt per endpoint.
 *
 * Deliberately a thin, low-level function that DOES throw
 * (`EvmRpcError`) when every endpoint in the chain has failed — the
 * resilience/graceful-degradation behavior (never let one unreachable
 * wallet break net-worth computation) lives one layer up, in
 * `src/server/crypto/build-wallet-balances.ts`, matching the same split
 * `sidecar-client.ts`'s `embedMerchantTexts` (throws) vs. its callers'
 * own fallback handling already establishes.
 */
export async function getEthBalanceWei(address: string, config: EvmRpcConfig = {}): Promise<bigint> {
  if (!isAddress(address)) {
    throw new EvmRpcError(`Invalid EVM address: ${address}`);
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const urls = [config.baseUrl ?? getEvmRpcUrl(), ...(config.fallbackUrls ?? [LLAMANODES_RPC_URL, CLOUDFLARE_RPC_URL])];

  const client = createPublicClient({
    chain: mainnet,
    transport: fallback(
      urls.map((url) =>
        http(url, {
          fetchFn: config.fetchImpl,
          timeout: timeoutMs,
          retryCount: 0,
        }),
      ),
      { retryCount: 0 },
    ),
  });

  try {
    return await client.getBalance({ address: address as Address });
  } catch (error) {
    if (error instanceof Error && /timed out|timeout/i.test(error.message)) {
      throw new EvmRpcError(`EVM RPC request timed out after ${timeoutMs}ms across every fallback transport`);
    }
    throw new EvmRpcError(
      `EVM RPC request failed across every fallback transport (${urls.length} tried): ${(error as Error).message}`,
    );
  }
}
