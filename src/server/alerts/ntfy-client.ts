import "server-only";
import { NTFY_ORIGIN, parseNtfyTopic } from "../../lib/ntfy-topic";

/**
 * Publishes one message to ntfy.sh (AGENTS.md §3qqq), the same free push
 * service the core router already uses for its own alerts. Plain `fetch`,
 * no SDK, like the Resend and Frankfurter clients.
 *
 * Always ntfy.sh, never a configurable server: the topic is the only input,
 * it is re-checked here against the same rule the settings form uses, and
 * the URL is a constant. JSON publishing (the topic inside the body, POSTed
 * to the root) rather than headers, so a Turkish or Hebrew merchant name in
 * the title survives — HTTP header values are not reliably UTF-8.
 *
 * Never throws, and never puts the topic or the message in a log line or an
 * error: the topic is a password and the message is financial data.
 */
const SEND_TIMEOUT_MS = 5_000;

export type NtfyMessage = {
  title: string;
  message: string;
  priority: 1 | 2 | 3 | 4 | 5;
  /** Opened when the notification is tapped. */
  click?: string;
};

export type NtfySendOutcome = { ok: true } | { ok: false; error: string };

export async function sendNtfy(topic: string, message: NtfyMessage, fetchImpl: typeof fetch = fetch): Promise<NtfySendOutcome> {
  if (parseNtfyTopic(topic) !== topic) return { ok: false, error: "not a valid ntfy.sh topic" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetchImpl(NTFY_ORIGIN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, ...message }),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true };
    if (response.status === 429) return { ok: false, error: "ntfy.sh is rate-limiting this server (429)" };
    return { ok: false, error: `ntfy.sh answered ${response.status}` };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: `ntfy.sh did not answer within ${SEND_TIMEOUT_MS / 1000}s` };
    return { ok: false, error: `could not reach ntfy.sh (${error instanceof Error ? error.name : "error"})` };
  } finally {
    clearTimeout(timeout);
  }
}
