import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { linkBankConnection } from "../../../../server/dal/bank-connections";
import { connectToInstitution, Psd2ApiError, UnknownInstitutionError } from "../../../../lib/banking/psd2-client";

/**
 * EU Open Banking PSD2 Ingestion (ad hoc) — links a new (mock)
 * institution: completes the simulated consent flow, then creates the
 * `BankAccount` + `BankConnection` pair (`linkBankConnection`). An
 * authenticated Settings action, `guardMutation`-fronted like every
 * other mutation in this app.
 */
const BodySchema = z.object({ institutionId: z.string().min(1) });

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "banking:connections:create");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Invalid JSON body");
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }

  try {
    const connectResult = await connectToInstitution(parsed.data.institutionId);
    const connection = await linkBankConnection(user.id, parsed.data.institutionId, connectResult);
    return NextResponse.json({ ok: true, connection }, { status: 201 });
  } catch (error) {
    if (error instanceof UnknownInstitutionError) {
      return jsonBadRequest("Unknown institution");
    }
    if (error instanceof Psd2ApiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 502 });
    }
    console.error("POST /api/banking/connections failed", error);
    return jsonServerError();
  }
}
