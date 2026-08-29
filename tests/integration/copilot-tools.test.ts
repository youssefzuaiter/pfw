import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeAdvisorTool } from "../../src/server/advisor/tools";
import { createAdminClient } from "../../src/server/db/admin-client";
import type { OllamaChatFn } from "../../src/server/copilot/run-conversation";
import { runCopilotConversation } from "../../src/server/copilot/run-conversation";

/**
 * Integration coverage for the local-LLM copilot's tool execution
 * (AGENTS.md §3o) — proves the exact same security invariant the cloud
 * advisor already has (tests/integration/idor.test.ts's spirit, applied
 * to the copilot's own conversation loop): tool calls are scoped to the
 * authenticated `userId` passed in by the route handler, never anything
 * the model itself could influence, and cross-user data never leaks
 * through. `runCopilotConversation` is exercised with a scripted fake
 * `OllamaChatFn` — no real Ollama process is needed to prove the
 * DAL/RLS scoping is correct, since that's a property of
 * `executeAdvisorTool` and the userId threading, not of the model.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("copilot tool execution", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `copilot-test-a-${Date.now()}@pfw.local`, displayName: "Copilot Test A" },
    });
    userB = await admin.user.create({
      data: { email: `copilot-test-b-${Date.now()}@pfw.local`, displayName: "Copilot Test B" },
    });

    const categoryA = await admin.category.create({
      data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    const accountA = await admin.bankAccount.create({
      data: {
        userId: userA.id,
        institutionName: "Test Bank",
        last4: "1234",
        accountType: "CHECKING",
        nativeBalance: 500_00n,
      },
    });
    await admin.notableTransaction.create({
      data: {
        userId: userA.id,
        bankAccountId: accountA.id,
        categoryId: categoryA.id,
        occurredAt: new Date(),
        amount: -12_34n,
        nativeAmount: -12_34n,
        description: "User A's private dinner",
        merchantName: "User A's Restaurant",
      },
    });

    const categoryB = await admin.category.create({
      data: { userId: userB.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    const accountB = await admin.bankAccount.create({
      data: {
        userId: userB.id,
        institutionName: "Test Bank",
        last4: "5678",
        accountType: "CHECKING",
        nativeBalance: 9_999_00n,
      },
    });
    await admin.notableTransaction.create({
      data: {
        userId: userB.id,
        bankAccountId: accountB.id,
        categoryId: categoryB.id,
        occurredAt: new Date(),
        amount: -56_78n,
        nativeAmount: -56_78n,
        description: "User B's private groceries",
        merchantName: "User B's Grocer",
      },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  it("executeAdvisorTool returns only the calling user's transactions", async () => {
    const resultA = await executeAdvisorTool(userA.id, "list_recent_transactions", { limit: 10, direction: "all" });
    expect(resultA.ok).toBe(true);
    const transactionsA = resultA.ok ? (resultA.result as { merchantName: string }[]) : [];
    expect(transactionsA.some((t) => t.merchantName === "User A's Restaurant")).toBe(true);
    expect(transactionsA.some((t) => t.merchantName === "User B's Grocer")).toBe(false);
  });

  it("executeAdvisorTool never leaks another user's data — cross-user IDOR check", async () => {
    const resultB = await executeAdvisorTool(userB.id, "list_recent_transactions", { limit: 10, direction: "all" });
    expect(resultB.ok).toBe(true);
    const transactionsB = resultB.ok ? (resultB.result as { merchantName: string }[]) : [];
    expect(transactionsB.some((t) => t.merchantName === "User A's Restaurant")).toBe(false);
    expect(transactionsB.some((t) => t.merchantName === "User B's Grocer")).toBe(true);
  });

  it("rejects an unknown tool name without throwing", async () => {
    const result = await executeAdvisorTool(userA.id, "drop_all_tables", {});
    expect(result).toEqual({ ok: false, error: "Unknown tool: drop_all_tables" });
  });

  it("rejects malformed tool input without throwing", async () => {
    const result = await executeAdvisorTool(userA.id, "list_recent_transactions", { limit: "not-a-number" });
    expect(result.ok).toBe(false);
  });

  function scriptedChat(script: { content: string; toolCall?: { name: string; arguments: Record<string, unknown> } }[]) {
    const calls: unknown[][] = [];
    let round = 0;
    const chat: OllamaChatFn = async (messages) => {
      calls.push(structuredClone(messages) as unknown[]);
      const step = script[round];
      round++;
      return {
        role: "assistant",
        content: step.content,
        tool_calls: step.toolCall ? [{ function: step.toolCall }] : undefined,
      };
    };
    return { chat, calls };
  }

  it("runs a full tool-calling round trip, scoped to the correct user, end to end", async () => {
    const { chat, calls } = scriptedChat([
      { content: "", toolCall: { name: "list_recent_transactions", arguments: { limit: 10, direction: "all" } } },
      { content: "You spent ₪12.34 at User A's Restaurant." },
    ]);
    const toolActivity: string[] = [];

    const reply = await runCopilotConversation(
      chat,
      userA.id,
      [{ role: "user", content: "What did I spend recently?" }],
      (activity) => toolActivity.push(activity.toolName),
    );

    expect(reply).toBe("You spent ₪12.34 at User A's Restaurant.");
    expect(toolActivity).toEqual(["list_recent_transactions"]);

    // The tool result fed back into the second `chat` call must contain
    // User A's real data (proving the loop threaded the correct userId
    // into `executeAdvisorTool`) and never User B's.
    const secondCallMessages = calls[1] as { role: string; content: string }[];
    const toolResultMessage = secondCallMessages.find((m) => m.role === "tool");
    expect(toolResultMessage?.content).toContain("User A's Restaurant");
    expect(toolResultMessage?.content).not.toContain("User B's Grocer");
  });

  it("the same conversation run for a different user only ever sees that user's data", async () => {
    const { chat, calls } = scriptedChat([
      { content: "", toolCall: { name: "list_recent_transactions", arguments: { limit: 10, direction: "all" } } },
      { content: "You spent ₪56.78 at User B's Grocer." },
    ]);

    const reply = await runCopilotConversation(chat, userB.id, [{ role: "user", content: "What did I spend?" }]);

    expect(reply).toBe("You spent ₪56.78 at User B's Grocer.");
    const secondCallMessages = calls[1] as { role: string; content: string }[];
    const toolResultMessage = secondCallMessages.find((m) => m.role === "tool");
    expect(toolResultMessage?.content).toContain("User B's Grocer");
    expect(toolResultMessage?.content).not.toContain("User A's Restaurant");
  });

  it("returns the model's answer directly when no tool call is requested", async () => {
    const { chat } = scriptedChat([{ content: "I don't need a tool to answer that — hi!" }]);
    const reply = await runCopilotConversation(chat, userA.id, [{ role: "user", content: "Hello" }]);
    expect(reply).toBe("I don't need a tool to answer that — hi!");
  });

  it("stops after the maximum number of tool rounds and never executes a tool call the round tools weren't offered", async () => {
    // An adversarial/confused script that keeps requesting a tool call on
    // every round, even the final round where `tools` isn't sent at all.
    const relentlessToolCalls = Array.from({ length: 6 }, () => ({
      content: "",
      toolCall: { name: "list_recent_transactions", arguments: { limit: 1, direction: "all" } },
    }));
    const { chat } = scriptedChat(relentlessToolCalls);
    const toolActivity: string[] = [];

    const reply = await runCopilotConversation(
      chat,
      userA.id,
      [{ role: "user", content: "Keep going forever" }],
      (activity) => toolActivity.push(activity.toolName),
    );

    // Exactly 4 tool rounds actually executed (MAX_TOOL_ROUNDS) — the
    // 5th call's tool_calls were never honored since tools weren't
    // offered that round, which is what actually caps DAL round-trips
    // rather than merely capping what's offered to the model.
    expect(toolActivity).toHaveLength(4);
    expect(reply).toBe(
      "I wasn't able to finish looking that up within this session's limits — try asking a narrower question.",
    );
  });
});
