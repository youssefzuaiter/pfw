import { NextResponse, type NextRequest } from "next/server";
import { sendNtfy } from "../../../../server/alerts/ntfy-client";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { getPhoneAlertDelivery } from "../../../../server/dal/phone-alerts";
import { getAppUrl } from "../../../../server/env";

/**
 * Sends one test notification to the user's own topic (AGENTS.md §3qqq), so
 * they can see the subscription works before the first real alert. A POST
 * behind the mutation guard with a tight limit: every call is a real
 * message through ntfy.sh, which rate-limits this server's address.
 *
 * 404 when alerts are off; 502 when ntfy.sh refuses or is unreachable, with
 * the reason (never the topic).
 */
const RATE_LIMIT = { windowMs: 10 * 60_000, maxRequests: 3 };

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "phone-alerts:test", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  try {
    const delivery = await getPhoneAlertDelivery(user.id);
    if (!delivery) return jsonNotFound();

    const outcome = await sendNtfy(delivery.topic, {
      title: "PFW: test alert",
      message: "Phone alerts work. You will hear from PFW when an envelope goes overdrawn, a large expense arrives, or it is time to import.",
      priority: 3,
      click: `${getAppUrl()}/settings`,
    });
    if (!outcome.ok) return NextResponse.json({ error: `The test alert was not delivered: ${outcome.error}.` }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/phone-alerts/test failed", error instanceof Error ? error.message : error);
    return jsonServerError();
  }
}
