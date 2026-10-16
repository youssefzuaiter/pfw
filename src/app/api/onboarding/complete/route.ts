import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonServerError } from "../../../../server/api/responses";
import { markOnboardingComplete } from "../../../../server/dal/onboarding";

/**
 * "I'm done" or "skip setup": records that the first-run wizard is finished
 * for the signed-in user, so the dashboard stops sending them there. Takes no
 * body (there is nothing to choose), and calling it again changes nothing.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "onboarding:complete");
  if ("response" in guard) return guard.response;

  try {
    const completedAt = await markOnboardingComplete(guard.user.id);
    return NextResponse.json({ ok: true, completedAt: completedAt.toISOString() });
  } catch (error) {
    console.error("POST /api/onboarding/complete failed", error);
    return jsonServerError();
  }
}
