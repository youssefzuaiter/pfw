import "server-only";
import { getResendApiKey, getResendFromAddress } from "../env";

/**
 * A thin, dependency-free HTTP client for Resend's `/emails` endpoint —
 * plain `fetch`, no `resend` SDK, matching this project's habit of
 * owning small, well-understood HTTP surfaces directly (the Frankfurter
 * FX client, the CoinGecko price-sync client, `ollama-client.ts`) rather
 * than taking on a dependency for one endpoint.
 *
 * Auth hardening pass (ad hoc, post-§3ff) — the only two callers are
 * `auth-emails.ts`'s password-reset and email-verification senders.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

/**
 * Throws on any failure (network error, non-2xx response) — callers
 * decide how to handle that (see `password-reset.ts`/`email-verification.ts`'s
 * own doc comments for why a send failure must never change what's
 * returned to the client: the uniform "if an account exists…" response
 * has to stay uniform regardless of whether the email actually went out).
 */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const apiKey = getResendApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: getResendFromAddress(),
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // Never include the response body in the thrown message — it could
    // echo back the recipient address or other request details into a
    // log line a less-trusted process might read; the status code alone
    // is enough to diagnose a Resend-side failure.
    throw new Error(`Resend API request failed with status ${response.status}`);
  }
}
