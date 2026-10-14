/**
 * ntfy.sh topic names (AGENTS.md §3qqq). Pure, so the settings form and the
 * server validate with the same rule.
 *
 * On ntfy.sh a topic is its own password: there is no account, and anyone
 * who knows the name can subscribe and read every message sent to it. So the
 * minimum length here is about guessability, not ntfy's own limit (which is
 * 1). Only the NAME is ever accepted or stored, never a server: a pasted
 * `https://ntfy.sh/<topic>` is reduced to its name, and any other host is
 * refused, so a stored value can never make the server post somewhere else.
 */
export const NTFY_ORIGIN = "https://ntfy.sh";
export const MIN_TOPIC_LENGTH = 12;
export const MAX_TOPIC_LENGTH = 64;

const TOPIC_PATTERN = /^[A-Za-z0-9_-]+$/;
const NTFY_SH_PREFIX = /^(?:https?:\/\/)?ntfy\.sh\//i;

export const TOPIC_RULE = `${MIN_TOPIC_LENGTH}–${MAX_TOPIC_LENGTH} letters, digits, - or _`;

/** The topic name in `input`, or null if it is not a usable ntfy.sh topic. */
export function parseNtfyTopic(input: string): string | null {
  let value = input.trim();
  const prefix = value.match(NTFY_SH_PREFIX);
  if (prefix) value = value.slice(prefix[0].length).replace(/\/+$/, "");
  if (value.length < MIN_TOPIC_LENGTH || value.length > MAX_TOPIC_LENGTH) return null;
  return TOPIC_PATTERN.test(value) ? value : null;
}

/** Enough of a topic to recognise it, not enough to subscribe to it. */
export function maskTopic(topic: string): string {
  return `…${topic.slice(-4)}`;
}
