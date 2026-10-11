import { describe, expect, it } from "vitest";
import { SENTRY_PRIVACY_OPTIONS } from "./sentry-config";

type Named = { name: string };

describe("SENTRY_PRIVACY_OPTIONS", () => {
  it("never sends personal data and never records traces or sessions", () => {
    expect(SENTRY_PRIVACY_OPTIONS.sendDefaultPii).toBe(false);
    expect(SENTRY_PRIVACY_OPTIONS.tracesSampleRate).toBe(0);
    expect(SENTRY_PRIVACY_OPTIONS.beforeBreadcrumb()).toBeNull();
  });

  it("removes every integration that would record data, and keeps the rest", () => {
    const defaults: Named[] = [
      "Breadcrumbs",
      "Console",
      "Http",
      "NodeFetch",
      "RequestData",
      "LocalVariables",
      "LocalVariablesAsync",
      "Replay",
      "Dedupe",
      "LinkedErrors",
      "GlobalHandlers",
    ].map((name) => ({ name }));

    const kept = SENTRY_PRIVACY_OPTIONS.integrations(defaults).map((i) => i.name);
    expect(kept).toEqual(["Dedupe", "LinkedErrors", "GlobalHandlers"]);
  });
});
