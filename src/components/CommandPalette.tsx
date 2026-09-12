"use client";

import { useChat } from "@ai-sdk/react";
import { getToolName, isToolUIPart } from "ai";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "cmdk";
import { setNonce } from "get-nonce";
import { ArrowLeft, ArrowLeftRight, LineChart, PiggyBank, Radar, Receipt, Sparkles, TrendingUp, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Spinner } from "./spinner/spinner";

type PaletteDestination = {
  href: string;
  label: string;
  icon: LucideIcon;
};

// Same six destinations the dashboard's own quick-links grid surfaces
// (`src/app/(finance)/dashboard/_components/quick-links-grid.tsx`),
// same icon per destination — one visual vocabulary for "this icon means
// this screen" everywhere it appears, not a second, different mapping
// here.
const DESTINATIONS: PaletteDestination[] = [
  { href: "/budgets", label: "Budget", icon: PiggyBank },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/transactions/subscriptions", label: "Subscriptions", icon: Radar },
  { href: "/trading", label: "Trading", icon: LineChart },
  { href: "/analytics", label: "Retirement", icon: TrendingUp },
  { href: "/trading/tax", label: "Tax", icon: Receipt },
];

/**
 * A single tool-call part rendered as a compact, collapsed badge — the
 * "complete with tool-call results" ask, without dumping a raw JSON blob
 * into the transcript. `getToolName`/`isToolUIPart` handle both a
 * statically-typed `tool-${name}` part and a `dynamic-tool` part with the
 * same code path (see `ai`'s own doc comment on `isToolUIPart`).
 */
function ToolCallBadge({ part }: { part: Parameters<typeof getToolName>[0] }) {
  const name = getToolName(part);
  const state = "state" in part ? part.state : undefined;

  return (
    <div className="mt-1 rounded-md border border-border bg-bg px-2 py-1.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-muted">
        <Sparkles className="h-3 w-3" aria-hidden="true" />
        {name}
        {state !== "output-available" && state !== "output-error" && <Spinner size="sm" />}
      </div>
      {state === "output-available" && "output" in part && (
        <pre className="mt-1 whitespace-pre-wrap break-words font-tabular text-fg">
          {JSON.stringify(part.output, null, 2)}
        </pre>
      )}
      {state === "output-error" && "errorText" in part && (
        <p className="mt-1 text-negative">{part.errorText}</p>
      )}
    </div>
  );
}

/**
 * Global `Cmd+K` (`Ctrl+K` on non-Mac) command palette, mounted once in
 * the root layout so it's reachable from both the `(finance)` and
 * `/trading` shells alike.
 *
 * Two modes in one dialog: the default is plain destination routing
 * (unchanged from Phase 2); typing a query and selecting "Ask the AI
 * CFO" switches the same dialog into a `useChat`-backed natural-language
 * query mode, streaming the reply — and any tool calls it makes — into
 * the palette itself, per the Phase 1 "AI CFO" ask. Closing the dialog
 * resets the chat (`setMessages([])`) rather than preserving it across
 * opens — a deliberate v1 simplification, not an oversight.
 */
export function CommandPalette({ nonce }: { nonce?: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"nav" | "chat">("nav");
  const [navQuery, setNavQuery] = useState("");
  const [followUp, setFollowUp] = useState("");
  const router = useRouter();
  const { messages, sendMessage, status, error, setMessages } = useChat();

  // The dialog's underlying `react-remove-scroll` body-scroll-lock
  // injects a `<style>` tag at open time — this app's strict CSP has no
  // `style-src 'unsafe-inline'`, so that tag needs the same per-request
  // nonce the root layout reads from `headers()`, or the browser
  // silently drops the whole rule (verified
  // against `react-style-singleton`'s own source, which reads exactly
  // this `get-nonce` global before falling back to no nonce at all).
  useEffect(() => {
    if (nonce) setNonce(nonce);
  }, [nonce]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleOpenChange(value: boolean) {
    setOpen(value);
    if (!value) {
      setMode("nav");
      setNavQuery("");
      setFollowUp("");
      setMessages([]);
    }
  }

  function navigateTo(href: string) {
    handleOpenChange(false);
    router.push(href);
  }

  function askAiCfo(question: string) {
    const trimmed = question.trim();
    if (!trimmed) return;
    setMode("chat");
    setNavQuery("");
    sendMessage({ text: trimmed });
  }

  function handleBackToNav() {
    setMode("nav");
  }

  function handleFollowUpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = followUp.trim();
    if (!trimmed) return;
    setFollowUp("");
    sendMessage({ text: trimmed });
  }

  const busy = status === "submitted" || status === "streaming";

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      label="Command palette"
      overlayClassName="fixed inset-0 z-50 bg-black/50"
      contentClassName="fixed left-1/2 top-24 z-50 w-full max-w-md -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
      shouldFilter={mode === "nav"}
    >
      {mode === "nav" ? (
        <>
          <CommandInput
            value={navQuery}
            onValueChange={setNavQuery}
            placeholder="Jump to, or ask the AI CFO a question…"
            className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-fg outline-none placeholder:text-muted"
          />
          <CommandList className="max-h-80 overflow-y-auto p-2">
            <CommandEmpty className="px-2 py-6 text-center text-sm text-muted">No matching screen.</CommandEmpty>
            {navQuery.trim().length > 0 && (
              <CommandGroup heading="Ask" className="text-xs font-medium uppercase tracking-wide text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                <CommandItem
                  value={`ask-ai-cfo-${navQuery}`}
                  onSelect={() => askAiCfo(navQuery)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-fg aria-selected:bg-accent/10 aria-selected:text-accent"
                >
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  Ask the AI CFO: &ldquo;{navQuery}&rdquo;
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading="Go to" className="text-xs font-medium uppercase tracking-wide text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              {DESTINATIONS.map((destination) => {
                const Icon = destination.icon;
                return (
                  <CommandItem
                    key={destination.href}
                    value={destination.label}
                    onSelect={() => navigateTo(destination.href)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-fg aria-selected:bg-accent/10 aria-selected:text-accent"
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {destination.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </>
      ) : (
        <div className="flex max-h-[28rem] flex-col">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <button
              type="button"
              onClick={handleBackToNav}
              aria-label="Back to navigation"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-bg hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
              AI CFO
            </span>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {messages.map((message) => (
              <div key={message.id} className="mb-3 text-sm text-fg">
                <div className="mb-0.5 text-xs font-medium uppercase tracking-wide text-muted">
                  {message.role === "user" ? "You" : "AI CFO"}
                </div>
                {message.parts.map((part, index) =>
                  part.type === "text" ? (
                    <p key={index} className="whitespace-pre-wrap">
                      {part.text}
                    </p>
                  ) : isToolUIPart(part) ? (
                    <ToolCallBadge key={index} part={part} />
                  ) : null,
                )}
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-xs text-muted">
                <Spinner size="sm" />
                Thinking…
              </div>
            )}
            {error && <p className="text-xs text-negative">Something went wrong: {error.message}</p>}
          </div>

          <form onSubmit={handleFollowUpSubmit} className="border-t border-border p-2">
            <input
              value={followUp}
              onChange={(event) => setFollowUp(event.target.value)}
              placeholder="Ask a follow-up…"
              autoFocus
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-ring"
            />
          </form>
        </div>
      )}
    </CommandDialog>
  );
}
