import * as Sentry from "@sentry/nextjs";
import { SENTRY_PRIVACY_OPTIONS } from "./lib/observability/sentry-config";

/**
 * Server-side error reporting (Sentry). Off unless NEXT_PUBLIC_SENTRY_DSN is
 * set, so local development and any deployment that has not opted in report
 * nothing. The DSN is a write-only address, not a secret; it is named
 * NEXT_PUBLIC_ only because the browser needs it too.
 */
export async function register() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn || process.env.NEXT_RUNTIME !== "nodejs") return;
  Sentry.init({ dsn, ...SENTRY_PRIVACY_OPTIONS });
}

/** Every error that reaches a route, Server Component or Server Action is reported here. */
export const onRequestError = Sentry.captureRequestError;
