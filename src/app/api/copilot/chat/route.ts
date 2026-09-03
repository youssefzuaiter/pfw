import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { callOllamaChat, checkOllamaAvailability } from "../../../../server/copilot/ollama-client";
import { runCopilotConversation } from "../../../../server/copilot/run-conversation";

const MAX_MESSAGES = 40;
const MAX_MESSAGE_LENGTH = 4_000;
/** Mirrors `relevant-transactions.ts`'s own `MAX_RELEVANT_TRANSACTIONS` ceiling — validated here too so an oversized array 400s at the request boundary rather than being silently truncated deep inside the conversation loop. */
const MAX_RELEVANT_TRANSACTION_IDS = 10;

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

const BodySchema = z.object({
  messages: z.array(MessageSchema).min(1).max(MAX_MESSAGES),
  // Local RAG plan: transaction ids the browser's own local KNN search
  // (over its IndexedDB-cached embedding vectors) resolved as relevant
  // to the user's question — never the vectors or the query text
  // itself. Untrusted client input like any other request field;
  // `run-conversation.ts` re-validates ownership via the DAL before
  // using any of it.
  relevantTransactionIds: z.array(z.string().min(1)).max(MAX_RELEVANT_TRANSACTION_IDS).optional(),
});

/**
 * The local-LLM copilot's chat endpoint (AGENTS.md §3o) — same shape as
 * `POST /api/advisor`, minus streaming (see `run-conversation.ts` for
 * why) and pointed at a local Ollama model instead of the Anthropic API.
 * A tighter rate limit than the default mutation guard, same reasoning
 * as the cloud advisor: one request can trigger several tool round-trips.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "copilot:chat", { windowMs: 10 * 60_000, maxRequests: 10 });
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
  // is always server-defined (server/copilot/system-prompt.ts) and can
  // never be supplied or overridden by the request body.
  if (parsed.data.messages[parsed.data.messages.length - 1].role !== "user") {
    return jsonBadRequest("The last message must be from the user");
  }

  const availability = await checkOllamaAvailability();
  if (!availability.available) {
    return NextResponse.json({ error: "copilot_unavailable", reason: availability.reason }, { status: 503 });
  }

  try {
    const reply = await runCopilotConversation(
      callOllamaChat,
      user.id,
      parsed.data.messages,
      undefined,
      parsed.data.relevantTransactionIds,
    );
    return NextResponse.json({ ok: true, reply });
  } catch (error) {
    console.error("POST /api/copilot/chat failed", error);
    return jsonServerError();
  }
}
