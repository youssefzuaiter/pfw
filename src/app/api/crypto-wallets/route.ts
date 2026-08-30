import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { createCryptoWallet } from "../../../server/dal/crypto-wallets";

const BodySchema = z.object({
  address: z.string().trim().min(1).max(200),
  chainId: z.number().int().positive().optional(),
  label: z.string().trim().min(1).max(80),
  stakingYieldBps: z.number().int().min(0).max(100_000).optional(),
  /** A decimal ETH-denominated string (e.g. "0.05"), converted to wei server-side — never accepted as a raw integer, since a client-supplied bare number could silently mean "wei" to one caller and "ETH" to another. */
  cumulativeGasFeesEther: z.string().trim().min(1).max(40).optional(),
});

/**
 * Adds a wallet address to track (AGENTS.md §3w). Read-only tracking
 * only — this route (and this whole feature) never accepts, stores, or
 * even has a field shaped like a private key or seed phrase; `address`
 * is validated as a public EVM address format by `createCryptoWallet`
 * (which rejects anything else as `invalid_address`, never attempts to
 * "helpfully" interpret a longer string as something else).
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "crypto-wallets:create");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }

  let cumulativeGasFeesWei: bigint | undefined;
  if (parsed.data.cumulativeGasFeesEther) {
    try {
      const { etherStringToWei } = await import("../../../lib/crypto/token-units");
      cumulativeGasFeesWei = etherStringToWei(parsed.data.cumulativeGasFeesEther);
    } catch {
      return jsonBadRequest("Invalid cumulativeGasFeesEther amount");
    }
  }

  try {
    const result = await createCryptoWallet(user.id, {
      address: parsed.data.address,
      chainId: parsed.data.chainId,
      label: parsed.data.label,
      stakingYieldBps: parsed.data.stakingYieldBps,
      cumulativeGasFeesWei,
    });

    if (!result.ok) {
      return jsonBadRequest(
        result.error === "invalid_address" ? "Not a valid EVM wallet address" : "This address is already tracked",
      );
    }
    // TypeScript narrows `result` to the `{ ok: true; wallet: ... }` arm
    // here, but `wallet`'s own declared type (`Awaited<ReturnType<typeof
    // getCryptoWalletById>>`, i.e. `CryptoWallet | null`) still allows
    // `null` — the DAL function itself never actually returns null in
    // this branch (`tx.cryptoWallet.create()` always returns a real row
    // or throws), same benign type looseness `categories.ts`'s
    // `createCategory` already has. A local binding narrows it for real
    // rather than sprinkling non-null assertions at every field access.
    const wallet = result.wallet;
    if (!wallet) return jsonServerError();

    await recordAuditLog(user.id, {
      entityType: "CryptoWallet",
      entityId: wallet.id,
      action: "CREATE",
      afterData: { label: wallet.label, chainId: wallet.chainId },
    });

    return NextResponse.json(
      { ok: true, wallet: { id: wallet.id, address: wallet.address, label: wallet.label } },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST /api/crypto-wallets failed", error);
    return jsonServerError();
  }
}
