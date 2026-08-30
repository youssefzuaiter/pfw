import "server-only";
import { normalizeEvmAddress } from "../../lib/crypto/evm-address";
import { withUserScope } from "../db/with-user-scope";

/**
 * DAL for `CryptoWallet` (AGENTS.md §3w) — CRUD for a user's tracked
 * public addresses only. The actual live balance is never read or
 * written here — see `src/server/crypto/build-wallet-balances.ts`.
 */

export async function listCryptoWallets(userId: string) {
  return withUserScope(userId, (tx) =>
    tx.cryptoWallet.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  );
}

/** Returns `null` both when the wallet doesn't exist AND when it belongs to a different user — same IDOR-safe convention as `bank-accounts.ts`'s `getBankAccountById` (Section 2.2). */
export async function getCryptoWalletById(userId: string, id: string) {
  return withUserScope(userId, (tx) => tx.cryptoWallet.findFirst({ where: { id, userId } }));
}

export type CreateCryptoWalletInput = {
  address: string;
  chainId?: number;
  label: string;
  stakingYieldBps?: number;
  cumulativeGasFeesWei?: bigint;
};

export type CreateCryptoWalletResult = { ok: true; wallet: Awaited<ReturnType<typeof getCryptoWalletById>> } | { ok: false; error: "invalid_address" | "already_tracked" };

/**
 * `address` is normalized (lowercased, format-validated) here — the ONE
 * place a raw address string becomes the canonical stored form — so
 * every other read/write in this module can compare addresses with a
 * plain string equality, never a case-insensitive comparison scattered
 * across call sites.
 */
export async function createCryptoWallet(userId: string, input: CreateCryptoWalletInput): Promise<CreateCryptoWalletResult> {
  let address: string;
  try {
    address = normalizeEvmAddress(input.address);
  } catch {
    return { ok: false, error: "invalid_address" };
  }

  const chainId = input.chainId ?? 1;

  return withUserScope(userId, async (tx) => {
    const existing = await tx.cryptoWallet.findFirst({ where: { userId, address, chainId } });
    if (existing) return { ok: false, error: "already_tracked" };

    const wallet = await tx.cryptoWallet.create({
      data: {
        userId,
        address,
        chainId,
        label: input.label,
        stakingYieldBps: input.stakingYieldBps,
        cumulativeGasFeesWei: input.cumulativeGasFeesWei,
      },
    });
    return { ok: true, wallet };
  });
}

export type DeleteCryptoWalletResult = { ok: true } | { ok: false; error: "not_found" };

export async function deleteCryptoWallet(userId: string, id: string): Promise<DeleteCryptoWalletResult> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.cryptoWallet.findFirst({ where: { id, userId } });
    if (!existing) return { ok: false, error: "not_found" };

    await tx.cryptoWallet.delete({ where: { id } });
    return { ok: true };
  });
}
