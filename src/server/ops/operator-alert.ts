import "server-only";
import { sendEmail } from "../email/resend-client";
import { getAppUrl, getOperatorAlertEmail } from "../env";

/**
 * Operator alerting (AGENTS.md §3yy) — the one channel a scheduled job
 * has to say "I failed" to a human. Until this existed, `/api/cron`'s
 * outcomes went to Vercel's function log and nowhere else: a Frankfurter
 * outage, a tripped stale-data breaker or a sleeping trader could repeat
 * every night for a month unnoticed.
 *
 * Deliberately NOT a `Notification` row: those are per-user, and none of
 * these jobs has a user (§3pp's own note on why the cron writes none).
 * The operator is a person with an inbox, so this is an email, sent
 * through the same Resend client the password-reset flow uses — no new
 * dependency, no new secret, one optional non-secret env var
 * (`OPERATOR_ALERT_EMAIL`) that switches it on.
 *
 * Never throws: an alert is best-effort by nature, and a failure to send
 * one must not change the outcome of the job that raised it (the same
 * "a send failure never changes the response" rule `password-reset.ts`
 * follows). Returns whether an email was actually handed to Resend, so a
 * caller (and a test) can tell "sent" from "not configured".
 */
export type OperatorAlert = {
  subject: string;
  /** Plain-text lines; rendered as both text and a minimal HTML body. */
  lines: string[];
};

export type OperatorAlertOutcome = "sent" | "not_configured" | "failed";

export function renderOperatorAlert(alert: OperatorAlert): { subject: string; text: string; html: string } {
  const origin = getAppUrl();
  const text = [...alert.lines, "", `Deployment: ${origin}`, `Sent at: ${new Date().toISOString()}`].join("\n");
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escape(text)}</pre>`;
  return { subject: `[PFW] ${alert.subject}`, text, html };
}

export async function sendOperatorAlert(
  alert: OperatorAlert,
  send: typeof sendEmail = sendEmail,
): Promise<OperatorAlertOutcome> {
  const to = getOperatorAlertEmail();
  if (!to) {
    console.warn(`operator-alert: OPERATOR_ALERT_EMAIL not set — not sent: ${alert.subject}`);
    return "not_configured";
  }
  try {
    const rendered = renderOperatorAlert(alert);
    await send({ to, ...rendered });
    return "sent";
  } catch (error) {
    console.error(`operator-alert: failed to send "${alert.subject}"`, error);
    return "failed";
  }
}
