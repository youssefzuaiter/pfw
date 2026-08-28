import Anthropic from "@anthropic-ai/sdk";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getAnthropicApiKey } from "../../../server/env";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../server/api/responses";
import { runAdvisorConversation } from "../../../server/advisor/run-conversation";

const MAX_MESSAGES = 40;
const MAX_MESSAGE_LENGTH = 4000;

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

const BodySchema = z.object({
  messages: z.array(MessageSchema).min(1).max(MAX_MESSAGES),
});

/**
 * Streams the advisor's replies as raw text chunks — never JSON, never
 * tool calls or reasoning (Section 1). A tighter rate limit than the
 * default mutation guard: each request can trigger several Anthropic API
 * calls (the tool-use loop), so it's the Section 6 "Cost & DoS Backstop"
 * as much as it is CSRF/identity plumbing.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "advisor:chat", { windowMs: 10 * 60_000, maxRequests: 10 });
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

  // The client only ever sends user/assistant turns — the system prompt
  // is always server-defined (server/advisor/system-prompt.ts) and can
  // never be supplied or overridden by the request body.
  if (parsed.data.messages[parsed.data.messages.length - 1].role !== "user") {
    return jsonBadRequest("The last message must be from the user");
  }

  let apiKey: string;
  try {
    apiKey = getAnthropicApiKey();
  } catch (error) {
    console.error("Advisor route missing ANTHROPIC_API_KEY", error);
    return jsonServerError();
  }

  const client = new Anthropic({ apiKey });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        await runAdvisorConversation(client, user.id, parsed.data.messages, (delta) => {
          controller.enqueue(encoder.encode(delta));
        });
      } catch (error) {
        console.error("POST /api/advisor streaming failed", error);
        controller.enqueue(encoder.encode("\n\n_Something went wrong while generating a response. Please try again._"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
