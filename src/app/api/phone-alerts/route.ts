import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../lib/money";
import { parseNtfyTopic, TOPIC_RULE } from "../../../lib/ntfy-topic";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { disablePhoneAlerts, enablePhoneAlerts, updatePhoneAlertPreferences } from "../../../server/dal/phone-alerts";

/**
 * Phone alerts through ntfy.sh (AGENTS.md §3qqq): POST turns them on (or
 * changes the topic), PATCH changes the threshold and the details switch,
 * DELETE turns them off. All three behind the normal mutation guard.
 *
 * With no topic in the body, POST makes one: 24 characters, 120 random
 * bits, which is what makes a public ntfy.sh topic private in practice.
 * The topic is in the response exactly once, so the page can show what to
 * subscribe to; it is never logged, never in the audit row, and every later
 * read shows only its last four characters.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 20 };
const MAX_THRESHOLD_AGOROT = 1_000_000_000; // ₪10,000,000

const EnableSchema = z.object({ topic: z.string().max(200).optional() });
const PatchSchema = z
  .object({ largeExpense: z.string().min(1).max(20).optional(), includeDetails: z.boolean().optional() })
  .refine((body) => body.largeExpense !== undefined || body.includeDetails !== undefined, "Nothing to change");

/** An empty body is `{}`; a body that is not JSON is null. */
async function readJson(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function generateTopic(): string {
  return `pfw-${randomBytes(15).toString("base64url")}`;
}

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "phone-alerts:enable", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const parsed = EnableSchema.safeParse(await readJson(request));
  if (!parsed.success) return jsonBadRequest("Invalid request body");

  let topic = generateTopic();
  if (parsed.data.topic !== undefined && parsed.data.topic.trim() !== "") {
    const chosen = parseNtfyTopic(parsed.data.topic);
    if (!chosen) return jsonBadRequest(`Use an ntfy.sh topic name of ${TOPIC_RULE}.`);
    topic = chosen;
  }

  try {
    const settings = await enablePhoneAlerts(user.id, topic);
    await recordAuditLog(user.id, {
      entityType: "PhoneAlertSubscription",
      entityId: user.id,
      action: "UPDATE",
      afterData: { topicHint: settings.topicHint },
    });
    return NextResponse.json({ ...settings, topic }, { status: 201 });
  } catch (error) {
    console.error("POST /api/phone-alerts failed", error instanceof Error ? error.message : error);
    return jsonServerError();
  }
}

export async function PATCH(request: NextRequest) {
  const guard = await guardMutation(request, "phone-alerts:patch", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const parsed = PatchSchema.safeParse(await readJson(request));
  if (!parsed.success) return jsonBadRequest("Invalid phone alert settings", parsed.error.issues);

  let largeExpenseAgorot: number | undefined;
  if (parsed.data.largeExpense !== undefined) {
    try {
      largeExpenseAgorot = parseShekelsToAgorot(parsed.data.largeExpense);
    } catch {
      return jsonBadRequest("largeExpense must be an amount in shekels, like 1000 or 1000.50");
    }
    if (largeExpenseAgorot < 100 || largeExpenseAgorot > MAX_THRESHOLD_AGOROT) {
      return jsonBadRequest("largeExpense must be between ₪1 and ₪10,000,000");
    }
  }

  try {
    const settings = await updatePhoneAlertPreferences(user.id, { largeExpenseAgorot, includeDetails: parsed.data.includeDetails });
    if (!settings) return jsonNotFound();
    await recordAuditLog(user.id, {
      entityType: "PhoneAlertSubscription",
      entityId: user.id,
      action: "UPDATE",
      afterData: { largeExpenseAgorot: settings.largeExpenseAgorot, includeDetails: settings.includeDetails },
    });
    return NextResponse.json(settings);
  } catch (error) {
    console.error("PATCH /api/phone-alerts failed", error instanceof Error ? error.message : error);
    return jsonServerError();
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await guardMutation(request, "phone-alerts:delete", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  try {
    const removed = await disablePhoneAlerts(user.id);
    if (!removed) return jsonNotFound();
    await recordAuditLog(user.id, { entityType: "PhoneAlertSubscription", entityId: user.id, action: "DELETE" });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/phone-alerts failed", error instanceof Error ? error.message : error);
    return jsonServerError();
  }
}
