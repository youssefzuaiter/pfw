import "server-only";
import { getOllamaConfig } from "../env";
import type { AdvisorToolDefinition } from "../advisor/tools";

/**
 * A thin, dependency-free HTTP client for Ollama's `/api/chat` and
 * `/api/tags` endpoints (AGENTS.md §3o) — plain `fetch`, no Ollama SDK,
 * matching this project's habit of owning small, well-understood
 * surfaces directly (the CSV tokenizer, the seeded RNG) rather than
 * taking on a dependency for a handful of HTTP calls.
 */

const CHAT_TIMEOUT_MS = 60_000;
const AVAILABILITY_TIMEOUT_MS = 2_000;

export type OllamaToolCall = { function: { name: string; arguments: Record<string, unknown> } };

export type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
};

export type OllamaTool = {
  type: "function";
  function: { name: string; description: string; parameters: AdvisorToolDefinition["input_schema"] };
};

/** Converts the advisor's existing tool registry into Ollama's function-calling wire format — same JSON-schema-shaped `input_schema`, no duplicated tool definitions. */
export function toOllamaTools(tools: readonly AdvisorToolDefinition[]): OllamaTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
}

/**
 * The copilot's entire premise is that inference never leaves the
 * device — so `OLLAMA_BASE_URL` is checked against a loopback/private-
 * address allowlist on every call, not just trusted because of its
 * name. A misconfigured env var pointing at a real remote host must
 * fail loudly here, before a single byte of financial data is sent,
 * rather than "just working" against an address that defeats the whole
 * point of this feature.
 */
function isLoopbackOrPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  const octets = hostname.split(".").map(Number);
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

function resolveLocalOllamaUrl(path: string): URL {
  const { baseUrl } = getOllamaConfig();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`OLLAMA_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (!isLoopbackOrPrivateHost(base.hostname)) {
    throw new Error(
      `OLLAMA_BASE_URL ("${baseUrl}") does not resolve to a local/private host. Refusing to send financial data to it — this copilot only ever runs against a model on this device.`,
    );
  }
  return new URL(path, base);
}

export type OllamaAvailability = { available: true } | { available: false; reason: string };

/** A short-timeout health check, surfaced to the UI so "Ollama isn't running" reads as a clear, expected state rather than a hang or a crash. */
export async function checkOllamaAvailability(): Promise<OllamaAvailability> {
  const { model } = getOllamaConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVAILABILITY_TIMEOUT_MS);
  try {
    const url = resolveLocalOllamaUrl("/api/tags");
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { available: false, reason: `The local Ollama server responded with HTTP ${response.status}` };
    }
    const body = (await response.json()) as { models?: { name: string }[] };
    const hasModel = (body.models ?? []).some((m) => m.name === model || m.name.startsWith(`${model}:`));
    if (!hasModel) {
      return { available: false, reason: `Model "${model}" isn't pulled yet — run \`ollama pull ${model}\`` };
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof Error
          ? `Couldn't reach the local Ollama server: ${error.message}`
          : "Couldn't reach the local Ollama server",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One complete, non-streaming chat turn. Used for every round of the
 * copilot's tool-use loop (`run-conversation.ts`) — local tool-calling
 * models are far less consistent than Claude about cleanly separating
 * narrated text from a tool call mid-stream, so every round here is a
 * plain request/response rather than attempting to stream a round that
 * might turn out to be a tool call.
 */
export async function callOllamaChat(messages: OllamaMessage[], tools: OllamaTool[] | undefined): Promise<OllamaMessage> {
  const { model } = getOllamaConfig();
  const url = resolveLocalOllamaUrl("/api/chat");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, tools, stream: false }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Ollama chat request failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { message: OllamaMessage };
    return body.message;
  } finally {
    clearTimeout(timeout);
  }
}
