import * as Sentry from "@sentry/nextjs";
import { getSentryDsn } from "./server/env";
import { SENTRY_PRIVACY_OPTIONS } from "./lib/observability/sentry-config";

/**
 * Server-side error reporting (Sentry). Off unless SENTRY_DSN is set, so
 * local development and any deployment that has not opted in report
 * nothing. Only the server reports: the browser is not connected to Sentry,
 * so errors that happen only in the page itself are not reported. Route,
 * Server Component and Server Action failures are, which is where the
 * server-side data lives.
 */
export async function register() {
  const dsn = getSentryDsn();
  if (!dsn || process.env.NEXT_RUNTIME !== "nodejs") return;
  Sentry.init({ dsn, ...SENTRY_PRIVACY_OPTIONS });
}

/** Every error that reaches a route, Server Component or Server Action is reported here. */
export const onRequestError = Sentry.captureRequestError;
