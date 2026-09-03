import "server-only";
import { ADVISOR_TOOLS, executeAdvisorTool } from "../advisor/tools";
import { buildRelevantTransactionsMessage } from "./relevant-transactions";
import { buildCopilotSystemPrompt } from "./system-prompt";
import { toOllamaTools, type OllamaMessage, type OllamaTool } from "./ollama-client";

/** Bounds how many tool round-trips one request can spend — the same DoS/cost
 * backstop the cloud advisor has (run-conversation.ts), applied here even
 * though a local model has no per-token API cost: an unbounded loop is still
 * a liveness hazard against a slow local model. */
const MAX_TOOL_ROUNDS = 4;

/** Ollama doesn't report token usage as uniformly/cheaply as Anthropic across every
 * local model, so a plain character count is the simplest reliable proxy for the
 * same "stop eventually" backstop the cloud advisor gets from MAX_TOTAL_OUTPUT_TOKENS. */
const MAX_TOTAL_OUTPUT_CHARS = 8_000;

export type ConversationMessage = { role: "user" | "assistant"; content: string };

/** Injectable so tests can substitute a fake without any real HTTP/Ollama process
 * — mirrors the cloud advisor's injected `Anthropic` client for the same reason. */
export type OllamaChatFn = (messages: OllamaMessage[], tools: OllamaTool[] | undefined) => Promise<OllamaMessage>;

/** Tool NAME only, never arguments or results — a progress signal the UI can use
 * ("Checking your transactions…") without needing true token streaming. */
export type CopilotToolActivity = { toolName: string };

const TOOL_DEFINITIONS = toOllamaTools(ADVISOR_TOOLS);

/**
 * Runs the copilot's tool-use loop against a local Ollama model, reusing
 * the cloud advisor's exact tool registry and DAL-backed execution
 * (`executeAdvisorTool`) unchanged — the model can only ever reach the
 * authenticated user's own data through those same Zod-revalidated,
 * RLS-scoped tools (AGENTS.md §3o).
 *
 * Deliberately NOT token-streamed, unlike the cloud advisor
 * (`src/server/advisor/run-conversation.ts`): Claude's stream cleanly
 * separates narrated text from a `tool_use` block mid-response, but
 * local tool-calling models are far less consistent about that, so
 * streaming a round that might turn out to be a tool call risks leaking
 * a half-formed sentence to the client before yanking it back. Every
 * round is a complete, non-streaming turn instead; only the final
 * answer (once the model stops requesting tools) is returned, once, in
 * full — a deliberate simplicity-over-polish trade-off, not an
 * oversight.
 *
 * `relevantTransactionIds` (Local RAG plan) is optional and additive —
 * appended after `onToolCall` rather than folded into an options object,
 * so every existing call site (the route, `tests/integration/
 * copilot-tools.test.ts`) keeps working unchanged. When present, the
 * ids are hydrated (`buildRelevantTransactionsMessage`, itself
 * RLS/ownership-scoped) into ONE `role: "tool"` message inserted right
 * after the system prompt, before the conversation history — available
 * as context for the whole tool-use loop below, not re-injected per
 * round.
 */
export async function runCopilotConversation(
  chat: OllamaChatFn,
  userId: string,
  history: ConversationMessage[],
  onToolCall?: (activity: CopilotToolActivity) => void,
  relevantTransactionIds?: readonly string[],
): Promise<string> {
  const relevantTransactionsMessage = await buildRelevantTransactionsMessage(userId, relevantTransactionIds);

  const messages: OllamaMessage[] = [
    { role: "system", content: buildCopilotSystemPrompt() },
    ...(relevantTransactionsMessage ? [relevantTransactionsMessage] : []),
    ...history.map((message): OllamaMessage => ({ role: message.role, content: message.content })),
  ];

  let totalOutputChars = 0;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const allowTools = round < MAX_TOOL_ROUNDS;

    const message = await chat(messages, allowTools ? TOOL_DEFINITIONS : undefined);
    messages.push(message);
    totalOutputChars += message.content?.length ?? 0;

    const requestedTools = Boolean(message.tool_calls && message.tool_calls.length > 0);

    // `!allowTools` here matters, not just `!requestedTools`: a model
    // that returns a tool call on the round tools weren't even offered
    // is confused at best — executing it anyway would let a
    // misbehaving/adversarial local model smuggle an extra DAL
    // round-trip past MAX_TOOL_ROUNDS by simply ignoring the fact that
    // no `tools` were sent, which is exactly the round-trip cap this
    // constant exists to enforce, not merely a hint offered to well-
    // behaved models.
    if (!requestedTools || !allowTools) {
      return (
        message.content ||
        "I wasn't able to finish looking that up within this session's limits — try asking a narrower question."
      );
    }

    if (totalOutputChars >= MAX_TOTAL_OUTPUT_CHARS) {
      return "I've reached this session's response budget for now — feel free to ask a follow-up.";
    }

    for (const call of message.tool_calls!) {
      onToolCall?.({ toolName: call.function.name });
      const outcome = await executeAdvisorTool(userId, call.function.name, call.function.arguments);
      messages.push({
        role: "tool",
        content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }),
      });
    }
  }

  // Unreachable at runtime: round === MAX_TOOL_ROUNDS always sets
  // `allowTools` to false, which always returns inside the loop above —
  // this only satisfies the type checker, which can't reason about the
  // loop bound that far.
  return "I wasn't able to finish looking that up within this session's limits — try asking a narrower question.";
}
