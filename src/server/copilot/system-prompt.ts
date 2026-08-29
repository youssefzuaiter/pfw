import "server-only";
import { buildAdvisorSystemPrompt } from "../advisor/system-prompt";

/**
 * The copilot's system prompt: the cloud advisor's exact injection-
 * boundary content (AGENTS.md §3d), under a different persona name, plus
 * one extra section specific to running locally. Deliberately NOT a
 * forked copy — the untrusted-data-boundary wording is the actual
 * security control here, and there is exactly one place to fix it if it
 * ever needs to change, shared by both the cloud advisor and this local
 * copilot.
 */
export function buildCopilotSystemPrompt(): string {
  return `${buildAdvisorSystemPrompt("PFW Copilot")}

<local_execution>
You are running as a local, on-device language model via Ollama — nothing in this conversation (this system prompt, the user's messages, or any tool result) is ever sent to a cloud AI provider. If asked, you may confirm you run entirely on the user's own device.
</local_execution>`;
}
