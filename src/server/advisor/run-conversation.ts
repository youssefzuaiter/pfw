import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { ADVISOR_TOOLS, executeAdvisorTool } from "./tools";
import { buildAdvisorSystemPrompt } from "./system-prompt";

const MODEL = "claude-sonnet-5";
const MAX_OUTPUT_TOKENS_PER_TURN = 1024;
/** Bounds how many tool round-trips one request can spend — a DoS/cost backstop (Section 6), not a quality knob. */
const MAX_TOOL_ROUNDS = 4;
/** A hard per-request token ceiling (Section 6's "Cost & DoS Backstop"), independent of per-call max_tokens, since a multi-round tool conversation could otherwise accumulate unboundedly. */
const MAX_TOTAL_OUTPUT_TOKENS = 4000;

export type ConversationMessage = { role: "user" | "assistant"; content: string };

const TOOL_DEFINITIONS: Anthropic.Tool[] = ADVISOR_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.input_schema,
}));

/**
 * Runs the advisor's tool-use loop against the real Anthropic API,
 * streaming only text deltas out via `onTextDelta` (Section 1: "the
 * assistant streams text deltas alone — tool calls, hidden prompts, and
 * chain-of-thought are never exposed to the client"). Tool calls are
 * executed here, server-side, against `executeAdvisorTool` — their
 * names, arguments, and results never leave this function.
 */
export async function runAdvisorConversation(
  client: Anthropic,
  userId: string,
  history: ConversationMessage[],
  onTextDelta: (delta: string) => void,
): Promise<void> {
  const messages: Anthropic.MessageParam[] = history.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  let totalOutputTokens = 0;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const allowTools = round < MAX_TOOL_ROUNDS;

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN,
      system: buildAdvisorSystemPrompt(),
      messages,
      tools: allowTools ? TOOL_DEFINITIONS : undefined,
    });

    stream.on("text", (delta) => onTextDelta(delta));

    const finalMessage = await stream.finalMessage();
    totalOutputTokens += finalMessage.usage.output_tokens;
    messages.push({ role: "assistant", content: finalMessage.content });

    if (finalMessage.stop_reason !== "tool_use") {
      return;
    }

    if (totalOutputTokens >= MAX_TOTAL_OUTPUT_TOKENS) {
      onTextDelta("\n\n_I've reached this session's response budget for now — feel free to ask a follow-up._");
      return;
    }

    const toolUseBlocks = finalMessage.content.filter(
      (block): block is Extract<Anthropic.ContentBlock, { type: "tool_use" }> => block.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const outcome = await executeAdvisorTool(userId, block.name, block.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }),
        is_error: !outcome.ok,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
}
