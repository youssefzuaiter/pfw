import "server-only";
import { createAnthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { formatAgorot } from "../../../lib/money";
import { executeAdvisorTool, RecentTransactionsSchema } from "../../../server/advisor/tools";
import { buildAdvisorSystemPrompt } from "../../../server/advisor/system-prompt";
import { buildLiquidityRunwayData } from "../../../server/analytics/build-liquidity-runway-data";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest } from "../../../server/api/responses";
import { getAnthropicApiKey } from "../../../server/env";
import { getAgentTradeWinRate } from "../../../server/dal/portfolio";

const MODEL = "claude-sonnet-5";
const MAX_OUTPUT_TOKENS = 1024;
/** Bounds how many tool round-trips one request can spend before a final text-only turn is forced — the same DoS/cost backstop the cloud advisor's own `MAX_TOOL_ROUNDS` already applies (`run-conversation.ts`), not a quality knob. */
const MAX_STEPS = 4;
const MAX_MESSAGES = 40;

// The AI SDK's `useChat` sends the full `UIMessage[]` array (id, role,
// parts), not a `{role, content}` string pair — validated loosely
// (`.passthrough()` on `parts` entries) since `convertToModelMessages`
// itself is the real, already-battle-tested parser for the many
// legitimate part shapes (text, tool calls, file, etc.); this boundary
// check exists to cap array/string sizes against abuse and to reject a
// `role` this app never accepts from a client, not to reimplement that
// parsing.
const IncomingPartSchema = z.object({ type: z.string().min(1).max(60) }).loose();
const IncomingMessageSchema = z
  .object({
    id: z.string().min(1).max(200),
    role: z.enum(["user", "assistant", "system"]),
    parts: z.array(IncomingPartSchema).min(1).max(50),
  })
  .loose();

const BodySchema = z.object({
  messages: z.array(IncomingMessageSchema).min(1).max(MAX_MESSAGES),
});

/**
 * "AI CFO" natural-language query engine (Phase 1, ad hoc) — a THIRD AI
 * surface alongside the existing cloud `/advisor` (Anthropic, full page)
 * and local `/copilot` (Ollama, persistent sidebar), but deliberately
 * NOT a third copy of their tool logic: `getRecentTransactions` below
 * dispatches straight into the existing, already-security-audited
 * `executeAdvisorTool("list_recent_transactions", ...)` (IDOR-checked,
 * Zod-re-validated) rather than re-querying the DAL directly, following
 * the same "one tool registry, reused" precedent §3o already established
 * for the local copilot. Uses Anthropic (via `@ai-sdk/anthropic`), not
 * OpenAI as first drafted — reuses the `ANTHROPIC_API_KEY` already
 * configured and trusted for this exact purpose, at the user's own
 * choice, rather than introducing a new vendor/secret for an
 * unrelated-to-OpenAI-specifically feature.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "chat:cfo", { windowMs: 10 * 60_000, maxRequests: 20 });
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

  // The system prompt is always server-defined — a client-supplied
  // "system" message is dropped rather than forwarded, the same
  // "the client only ever sends user/assistant turns" rule
  // `/api/copilot/chat` already enforces.
  const conversation = parsed.data.messages.filter((message) => message.role !== "system") as UIMessage[];

  const anthropic = createAnthropic({ apiKey: getAnthropicApiKey() });

  const tools = {
    getRecentTransactions: tool({
      description:
        "List the user's most recent transactions, optionally filtered by category name or income/expense direction.",
      inputSchema: RecentTransactionsSchema,
      execute: async (input) => {
        const result = await executeAdvisorTool(user.id, "list_recent_transactions", input);
        return result.ok ? result.result : { error: result.error };
      },
    }),
    getMonthlyBurnRate: tool({
      description:
        "The user's current monthly burn rate (committed spend), and which figure produced it — a trailing spending average or their known recurring bills, whichever is higher.",
      inputSchema: z.object({}),
      execute: async () => {
        const { burnRate } = await buildLiquidityRunwayData(user.id);
        return {
          monthlyBurnRate: formatAgorot(burnRate.monthlyBurnRateAgorot),
          source: burnRate.source,
          monthsAveraged: burnRate.monthsAveraged,
        };
      },
    }),
    getAgentWinRate: tool({
      description:
        "The account's trading win rate: of settled sell trades with a realized gain/loss, what fraction closed profitably. Covers every settled sell on the account (manual desk trades included), not exclusively the paper-trading agent's own fills — Trade rows carry no field distinguishing the two sources.",
      inputSchema: z.object({}),
      execute: async () => {
        const { settledSellCount, winningSellCount } = await getAgentTradeWinRate(user.id);
        if (settledSellCount === 0) {
          return { settledSellCount: 0, winRate: null, note: "No settled sell trades with a recorded realized gain/loss yet." };
        }
        return {
          settledSellCount,
          winningSellCount,
          winRate: `${((winningSellCount / settledSellCount) * 100).toFixed(1)}%`,
        };
      },
    }),
  };

  const result = streamText({
    model: anthropic(MODEL),
    system: buildAdvisorSystemPrompt("PFW AI CFO"),
    messages: await convertToModelMessages(conversation),
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  return result.toUIMessageStreamResponse();
}
