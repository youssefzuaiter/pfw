import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../lib/money";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { createManualAsset } from "../../../server/dal/manual-assets";

const ASSET_TYPES = ["PROPERTY", "VEHICLE", "CRYPTO", "PENSION", "KEREN_HISHTALMUT", "OTHER"] as const;

const BodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  assetType: z.enum(ASSET_TYPES),
  currentValue: z.string().min(1),
  valuedAt: z.string().datetime().optional(),
  taxAdvantaged: z.boolean().optional(),
  liquidityDate: z.string().datetime().optional(),
});

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "assets:create");
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

  let currentValueAgorot: ReturnType<typeof parseShekelsToAgorot>;
  try {
    currentValueAgorot = parseShekelsToAgorot(parsed.data.currentValue);
  } catch {
    return jsonBadRequest("Invalid current value");
  }
  if (currentValueAgorot <= 0) {
    return jsonBadRequest("Current value must be positive");
  }

  try {
    const asset = await createManualAsset(user.id, {
      name: parsed.data.name,
      assetType: parsed.data.assetType,
      currentValue: BigInt(currentValueAgorot),
      valuedAt: parsed.data.valuedAt ? new Date(parsed.data.valuedAt) : new Date(),
      taxAdvantaged: parsed.data.taxAdvantaged,
      liquidityDate: parsed.data.liquidityDate ? new Date(parsed.data.liquidityDate) : undefined,
    });

    await recordAuditLog(user.id, {
      entityType: "ManualAsset",
      entityId: asset.id,
      action: "CREATE",
      afterData: { name: asset.name, currentValue: currentValueAgorot },
    });

    return NextResponse.json(
      {
        ok: true,
        asset: {
          id: asset.id,
          name: asset.name,
          assetType: asset.assetType,
          currentValue: Number(asset.currentValue),
          valuedAt: asset.valuedAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST /api/assets failed", error);
    return jsonServerError();
  }
}
