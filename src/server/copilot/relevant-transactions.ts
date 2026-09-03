import "server-only";
import { agorot, formatAgorot } from "../../lib/money";
import { listTransactionsByIds } from "../dal/transactions";
import type { OllamaMessage } from "./ollama-client";

/** Independent of, and typically smaller than, `local-vector-search.ts`'s own `DEFAULT_TOP_K` — a hard server-side ceiling on a client-supplied id list, not a tuning knob. */
const MAX_RELEVANT_TRANSACTIONS = 10;

/**
 * Hydrates the transaction ids the browser's local KNN search resolved
 * (Local RAG plan) into a `role: "tool"` message — deliberately the
 * SAME shape `executeAdvisorTool`'s real tool-call results already
 * arrive in (`run-conversation.ts`), not folded into the system prompt.
 * The system prompt is trusted instruction content;
 * `merchantName`/`description` are free text the user (or a CSV import)
 * entered, the exact injection surface `system-prompt.ts`'s
 * `<untrusted_data_boundary>` section already exists to defend against
 * — giving this message the "tool result" shape is what puts it under
 * that same, already-battle-tested defense rather than inventing a
 * second one.
 *
 * Every monetary figure is pre-formatted via `formatAgorot`, same rule
 * every advisor tool result already follows (AGENTS.md §3d) — the model
 * is never handed a raw agorot integer to reformat or do arithmetic on
 * itself.
 *
 * Returns `null` (never throws) when there's nothing to inject — no ids
 * supplied, or every supplied id failed the DAL's ownership check — so
 * a caller can unconditionally splice this into the message list.
 */
export async function buildRelevantTransactionsMessage(
  userId: string,
  transactionIds: readonly string[] | undefined,
): Promise<OllamaMessage | null> {
  if (!transactionIds || transactionIds.length === 0) return null;

  const rows = await listTransactionsByIds(userId, transactionIds.slice(0, MAX_RELEVANT_TRANSACTIONS));
  if (rows.length === 0) return null;

  const transactions = rows.map((row) => ({
    date: row.occurredAt.toISOString().slice(0, 10),
    merchantName: row.merchantName,
    description: row.description,
    category: row.category.name,
    amount: formatAgorot(agorot(Number(row.amount))),
  }));

  return {
    role: "tool",
    content: JSON.stringify({
      note: "Transactions the user's own device found locally relevant to their question, via on-device semantic search over the user's own data — not the result of a tool call this turn.",
      transactions,
    }),
  };
}
