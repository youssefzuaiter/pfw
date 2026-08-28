import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../../../lib/money";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { updateManualAssetValuation } from "../../../../../server/dal/manual-assets";

const BodySchema = z.object({
  currentValue: z.string().min(1),
  valuedAt: z.string().datetime().optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "assets:revalue");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id: assetId } = await params;

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
    const updated = await updateManualAssetValuation(user.id, assetId, {
      currentValue: BigInt(currentValueAgorot),
      valuedAt: parsed.data.valuedAt ? new Date(parsed.data.valuedAt) : new Date(),
    });
    if (!updated) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "ManualAsset",
      entityId: assetId,
      action: "UPDATE",
      afterData: { currentValue: currentValueAgorot },
    });

    return NextResponse.json(
      {
        ok: true,
        asset: {
          id: updated.id,
          currentValue: Number(updated.currentValue),
          valuedAt: updated.valuedAt.toISOString(),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("POST /api/assets/[id]/valuation failed", error);
    return jsonServerError();
  }
}
