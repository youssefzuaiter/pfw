import "server-only";
import { cache } from "react";
import { ZERO_AGOROT, addAgorot, type Agorot } from "../../lib/money";
import { convertWeiToAgorot, weiToEtherString } from "../../lib/crypto/token-units";
import { listCryptoWallets } from "../dal/crypto-wallets";
import { getLatestCryptoRate } from "../dal/crypto-prices";
import { getEthBalanceWei } from "./evm-rpc-client";

export type WalletBalanceRow = {
  id: string;
  address: string;
  chainId: number;
  label: string;
  stakingYieldBps: number | null;
  cumulativeGasFeesWei: bigint | null;
  /** `null` when the RPC call failed (unreachable endpoint, timeout, malformed response) — the wallet still appears in the list, just with no live figure, rather than disappearing or breaking the whole page. */
  balanceWei: bigint | null;
  balanceEtherDisplay: string | null;
  valueAgorot: Agorot;
  rpcError: string | null;
};

export type WalletBalancesResult = {
  wallets: WalletBalanceRow[];
  totalValueAgorot: Agorot;
};

/** Bounds the worst case latency this adds to a caller like `computeLiveNetWorth`: N wallets fetched in parallel, each individually capped, so one unreachable wallet can never make the whole computation hang — only this one wallet's own timeout is ever paid. */
const PER_WALLET_TIMEOUT_MS = 3_000;

/**
 * Fetches every one of a user's tracked wallets' LIVE native balance
 * (AGENTS.md §3w) — never a stored figure, per `CryptoWallet`'s own
 * schema comment. `Promise.allSettled`, not `Promise.all`: one
 * unreachable or slow wallet must never take down every other wallet's
 * figure, nor the caller's entire net-worth computation — the same
 * resilience contract `rate-sync.ts`/`price-sync.ts` already have for a
 * provider outage, applied per-wallet here since a wallet's own RPC
 * endpoint can fail independently of every other wallet.
 *
 * The price lookup (`getLatestCryptoRate`) is a single fast DB read, not
 * a live external call — the actual price SYNC happens out-of-band via
 * `scripts/sync-crypto-prices.ts`, the same "live balance, cached price"
 * split every other live-conversion path in this app already uses (a
 * bank account's live FX conversion reads `getLatestRateTable`, never
 * calls Frankfurter itself).
 *
 * `cache()`-wrapped for the same per-request-scoping reason every other
 * `build-*-data.ts`/aggregator in this app is (§3c).
 */
export const buildWalletBalances = cache(async function buildWalletBalances(userId: string): Promise<WalletBalancesResult> {
  const [wallets, ethRate] = await Promise.all([listCryptoWallets(userId), getLatestCryptoRate("ETH")]);

  const settled = await Promise.allSettled(
    wallets.map((wallet) => getEthBalanceWei(wallet.address, { timeoutMs: PER_WALLET_TIMEOUT_MS })),
  );

  const rows: WalletBalanceRow[] = wallets.map((wallet, index) => {
    const outcome = settled[index];

    if (outcome.status === "rejected") {
      return {
        id: wallet.id,
        address: wallet.address,
        chainId: wallet.chainId,
        label: wallet.label,
        stakingYieldBps: wallet.stakingYieldBps,
        cumulativeGasFeesWei: wallet.cumulativeGasFeesWei,
        balanceWei: null,
        balanceEtherDisplay: null,
        valueAgorot: ZERO_AGOROT,
        rpcError: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      };
    }

    const balanceWei = outcome.value;
    return {
      id: wallet.id,
      address: wallet.address,
      chainId: wallet.chainId,
      label: wallet.label,
      stakingYieldBps: wallet.stakingYieldBps,
      cumulativeGasFeesWei: wallet.cumulativeGasFeesWei,
      balanceWei,
      balanceEtherDisplay: weiToEtherString(balanceWei),
      valueAgorot: convertWeiToAgorot(balanceWei, ethRate),
      rpcError: null,
    };
  });

  return { wallets: rows, totalValueAgorot: addAgorot(...rows.map((r) => r.valueAgorot)) };
});
