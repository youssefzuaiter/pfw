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
