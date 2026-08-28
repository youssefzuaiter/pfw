"use client";

import { useState, type FormEvent, type MouseEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";

type ChatMessage = { role: "user" | "assistant"; content: string };

const SUGGESTED_PROMPTS = [
  "How is my net worth trending?",
  "Where is most of my spending going this month?",
  "Am I on pace with my budgets?",
  "Which debt should I pay off first?",
];

export function AdvisorChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendMessage(content: string) {
    const trimmed = content.trim();
    if (!trimmed || isStreaming) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages([...nextMessages, { role: "assistant", content: "" }]);
    setDraft("");
    setIsStreaming(true);
    setError(null);

    try {
      const response = await fetch("/api/advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });

      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "The advisor is unavailable right now");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((current) => {
          const updated = [...current];
          const last = updated[updated.length - 1];
          updated[updated.length - 1] = { ...last, content: last.content + chunk };
          return updated;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The advisor is unavailable right now");
      setMessages((current) => current.slice(0, -1));
    } finally {
      setIsStreaming(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(draft);
  }

  function handleSuggestedPromptClick(event: MouseEvent<HTMLButtonElement>) {
    const prompt = event.currentTarget.dataset.prompt;
    if (prompt) void sendMessage(prompt);
  }

  return (
    <div className="flex flex-col gap-4">
      {messages.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              data-prompt={prompt}
              onClick={handleSuggestedPromptClick}
              className="uv-btn-press rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      <div aria-live="polite" className="flex flex-col gap-3">
        {messages.map((message, index) => (
          <div
            key={index}
            className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-4 py-3 text-sm ${
              message.role === "user" ? "self-end bg-accent text-bg" : "self-start bg-surface text-fg"
            }`}
          >
            {message.content || (message.role === "assistant" && isStreaming ? <Spinner /> : "")}
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-negative">{error}</p>}

      <form onSubmit={handleSubmit} className="flex items-end gap-2">
        <label className="sr-only" htmlFor="advisor-input">
          Ask the advisor
        </label>
        <textarea
          id="advisor-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage(draft);
            }
          }}
          rows={2}
          placeholder="Ask about your spending, budgets, goals, debts, or portfolio…"
          className="flex-1 resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          disabled={isStreaming || !draft.trim()}
          className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isStreaming && <Spinner />}
          {isStreaming ? "Thinking…" : "Send"}
        </button>
      </form>
    </div>
  );
}
