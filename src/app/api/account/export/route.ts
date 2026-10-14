import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { gatherUserExport } from "../../../../server/dal/data-export";
import { packageCsvExport, packageJsonExport } from "../../../../server/data-export/package-export";

/**
 * POST /api/account/export — everything the signed-in user owns, decrypted,
 * as one JSON document or a ZIP of CSVs (AGENTS.md §3uuu).
 *
 * POST behind the mutation guard rather than a plain GET link: the Origin
 * check means another site cannot make a signed-in browser fetch the file,
 * and the identity comes from the session, never the request. Ten exports an
 * hour. Recorded in the audit log, which the next export then includes.
 * `no-store`: the response is the user's whole financial history and must
 * not sit in any cache.
 */
const RATE_LIMIT = { windowMs: 60 * 60 * 1000, maxRequests: 10 };

const BodySchema = z.object({ format: z.enum(["json", "csv"]) });

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "account:export", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Invalid JSON body");
  }
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) return jsonBadRequest("format must be json or csv", parsed.error.issues);

  try {
    const data = await gatherUserExport(user.id);
    if (!data) return jsonNotFound();

    const now = new Date();
    const packaged = parsed.data.format === "json" ? packageJsonExport(data, now) : packageCsvExport(data, now);
    await recordAuditLog(user.id, { entityType: "DataExport", entityId: user.id, action: "CREATE", afterData: { format: parsed.data.format } });

    return new NextResponse(packaged.body as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": packaged.contentType,
        "Content-Disposition": `attachment; filename="${packaged.filename}"`,
        "Content-Length": String(packaged.body.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("POST /api/account/export failed", error);
    return jsonServerError();
  }
}
