import "server-only";
import type { Prisma } from "../../generated/prisma/client";
import { withUserScope } from "../db/with-user-scope";

export async function listManualAssets(userId: string) {
  return withUserScope(userId, (tx) => tx.manualAsset.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }));
}

/** See bank-accounts.ts for why this returns `null` rather than throwing on a mismatch. */
export async function getManualAssetById(userId: string, id: string) {
  return withUserScope(userId, (tx) => tx.manualAsset.findFirst({ where: { id, userId } }));
}

export async function createManualAsset(
  userId: string,
  input: {
    name: string;
    assetType: Prisma.ManualAssetCreateInput["assetType"];
    currentValue: bigint;
    valuedAt: Date;
    taxAdvantaged?: boolean;
    liquidityDate?: Date;
    /** The Real-Time Liquidity Runway & Burn-Rate Engine's per-asset override (AGENTS.md §3v) — omit to use `assetType`'s default tier (see schema.prisma's `ManualAsset.liquidityTier` comment for why null, not a stored default, means "derive it"). No dedicated UI sets this yet (out of this pass's scope, per its own known-limitations note); wired here so it's usable via the API today rather than dead schema nothing can reach. */
    liquidityTier?: Prisma.ManualAssetCreateInput["liquidityTier"];
  },
) {
  return withUserScope(userId, (tx) => tx.manualAsset.create({ data: { userId, ...input } }));
}

/** Refreshing the valuation is the whole point of this mutation — it's what moves an asset from "stale" back to "fresh" (src/lib/valuation-freshness.ts). */
export async function updateManualAssetValuation(
  userId: string,
  id: string,
  input: { currentValue: bigint; valuedAt: Date },
) {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.manualAsset.findFirst({ where: { id, userId } });
    if (!existing) return null;
    return tx.manualAsset.update({ where: { id }, data: input });
  });
}
