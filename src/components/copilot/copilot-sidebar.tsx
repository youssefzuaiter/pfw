"use client";

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "../badge/badge";
import { Spinner } from "../spinner/spinner";

type ChatMessage = { role: "user" | "assistant"; content: string };
type Availability = "checking" | "available" | "unavailable";

const SUGGESTED_PROMPTS = [
  "How much did I spend on dining out last month?",
  "What's my net worth right now?",
  "Am I on pace with my budgets?",
];

/** Three bouncing dots, staggered — the "thinking locally" indicator shown while
 * waiting for a non-streamed reply (see run-conversation.ts for why the copilot
 * doesn't token-stream like the cloud advisor). */
function TypingIndicator() {
  return (
    <span className="uv-typing-dots flex items-center gap-1" aria-label="The copilot is thinking">
      <span className="uv-typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
      <span className="uv-typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
      <span className="uv-typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
    </span>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed [&_code]:rounded [&_code]:bg-bg [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-tabular-figures [&_code]:text-xs [&_li]:ml-4 [&_ol]:list-decimal [&_p:not(:last-child)]:mb-2 [&_strong]:font-semibold [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export function CopilotSidebar() {
  const [isOpen, setIsOpen] = useState(false);
  const [availability, setAvailability] = useState<Availability>("checking");
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // A ref, not state: "have we already checked" doesn't need to trigger a
  // re-render, and using state here would call setState synchronously at
  // the top of the effect body (react-hooks/set-state-in-effect).
  const hasCheckedAvailabilityRef = useRef(false);

  useEffect(() => {
    if (!isOpen || hasCheckedAvailabilityRef.current) return;
    hasCheckedAvailabilityRef.current = true;

    fetch("/api/copilot/status")
      .then((response) => response.json())
      .then((body: { available: boolean; reason?: string }) => {
        setAvailability(body.available ? "available" : "unavailable");
        setUnavailableReason(body.reason ?? null);
      })
      .catch(() => {
        setAvailability("unavailable");
        setUnavailableReason("Couldn't reach the local Ollama server");
      });
  }, [isOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, isSending]);

  async function sendMessage(content: string) {
    const trimmed = content.trim();
    if (!trimmed || isSending || availability !== "available") return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setDraft("");
    setIsSending(true);
    setError(null);

    try {
      const response = await fetch("/api/copilot/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const body = await response.json().catch(() => ({}));

      if (response.status === 503) {
        setAvailability("unavailable");
        setUnavailableReason(body.reason ?? "The local Ollama server became unavailable");
        setMessages(nextMessages);
        return;
      }
      if (!response.ok) {
        throw new Error(body.error ?? "The copilot is unavailable right now");
      }

      setMessages([...nextMessages, { role: "assistant", content: body.reply as string }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The copilot is unavailable right now");
      setMessages(messages);
    } finally {
      setIsSending(false);
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

  function handleToggle() {
    setIsOpen((open) => !open);
  }

  function handleClose() {
    setIsOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={isOpen}
        aria-controls="copilot-panel"
        className="uv-btn-press fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2.5 text-sm font-medium text-bg shadow-lg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:bottom-6 md:right-6"
      >
        {isOpen ? "Close copilot" : "Copilot"}
      </button>

      <div
        id="copilot-panel"
        role="dialog"
        aria-label="PFW Copilot"
        aria-hidden={!isOpen}
        // A real axe finding (`aria-hidden-focus`), caught while
        // verifying an unrelated change: `aria-hidden` alone doesn't stop
        // its off-screen (`translate-x-full`) contents from staying
        // focusable — the panel's own "Close copilot" button was still
        // reachable via Tab while hidden. `inert` (native, React 19
        // passes it straight through) removes the whole closed subtree
        // from both the tab order and the accessibility tree at once,
        // which `aria-hidden` on its own never did.
        inert={!isOpen}
        className={`uv-copilot-panel fixed inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col border-l border-border bg-surface shadow-2xl ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border p-4">
          <div>
            <p className="font-display text-sm font-semibold text-fg">PFW Copilot</p>
            <p className="text-xs text-muted">Runs 100% locally — nothing here reaches a cloud AI provider.</p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close copilot"
            className="uv-btn-press rounded-md p-1 text-muted hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ✕
          </button>
        </div>

        {availability === "unavailable" && (
          <div className="border-b border-border bg-negative/10 p-3 text-xs text-negative">
            <p className="font-medium">Local model unavailable</p>
            <p className="mt-1 text-muted">
              {unavailableReason ?? "Ollama isn't reachable."} Install Ollama, run{" "}
              <code className="rounded bg-bg px-1 py-0.5 font-tabular-figures">ollama pull llama3.1</code>, and reopen
              this panel.
            </p>
          </div>
        )}

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="flex flex-col gap-2">
              <Badge variant="neutral">On-device</Badge>
              <p className="text-xs text-muted">
                Ask about your spending, budgets, or net worth. Every answer is generated by a model running on this
                device — no financial data is ever sent to a cloud AI service.
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    data-prompt={prompt}
                    onClick={handleSuggestedPromptClick}
                    disabled={availability !== "available"}
                    className="uv-btn-press rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div aria-live="polite" className="flex flex-col gap-3">
            {messages.map((message, index) => (
              <div
                key={index}
                className={`max-w-[90%] rounded-lg px-3 py-2 ${
                  message.role === "user"
                    ? "self-end whitespace-pre-wrap bg-accent text-sm text-bg"
                    : "self-start bg-bg text-fg"
                }`}
              >
                {message.role === "assistant" ? <MarkdownMessage content={message.content} /> : message.content}
              </div>
            ))}
            {isSending && (
              <div className="self-start rounded-lg bg-bg px-3 py-2">
                <TypingIndicator />
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {error && <p className="px-4 text-xs text-negative">{error}</p>}

        <form onSubmit={handleSubmit} className="flex items-end gap-2 border-t border-border p-3">
          <label className="sr-only" htmlFor="copilot-input">
            Ask the copilot
          </label>
          <textarea
            id="copilot-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage(draft);
              }
            }}
            rows={2}
            disabled={availability !== "available"}
            placeholder={availability === "available" ? "Ask about your finances…" : "Copilot unavailable"}
            className="flex-1 resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isSending || !draft.trim() || availability !== "available"}
            className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-3 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {isSending && <Spinner />}
            Send
          </button>
        </form>
      </div>
    </>
  );
}
