import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { safeMessage, scrubSentryEvent } from "./scrub-sentry-event";

function eventWith(overrides: Record<string, unknown>): ErrorEvent {
  return overrides as unknown as ErrorEvent;
}

describe("safeMessage", () => {
  it("keeps plain prose messages that name a problem without carrying data", () => {
    expect(safeMessage("Unable to start a transaction in the given time")).toBe(
      "Unable to start a transaction in the given time",
    );
    expect(safeMessage("notableTransaction.updateMany is not supported by the field-encryption extension yet")).toBe(
      "notableTransaction.updateMany is not supported by the field-encryption extension yet",
    );
  });

  it("redacts anything that could carry a value: digits, quotes, braces, backticks, emails, newlines", () => {
    for (const text of [
      "P2028 Unable to start a transaction", // a Prisma error code is a digit
      "Dinner at \"Cafe Cafe\" for 125",
      "Invalid `prisma.notableTransaction.findMany()` invocation",
      "where: { description: 'Dinner out' }",
      "owner owner@example.com could not sign in",
      "first line\nsecond line",
    ]) {
      expect(safeMessage(text)).toBe("[redacted]");
    }
  });
});

describe("scrubSentryEvent", () => {
  it("keeps only the route path and method of a request, dropping query, headers, cookies and body", () => {
    const scrubbed = scrubSentryEvent(
      eventWith({
        request: {
          url: "https://pfw-nu.vercel.app/api/transactions/cm123?search=rent&token=abc",
          method: "PATCH",
          cookies: { "__Host-session": "secret" },
          headers: { authorization: "Bearer x" },
          data: { description: "Dinner out", amount: "-125.50" },
        },
      }),
    );
    expect(scrubbed.request).toEqual({ url: "/api/transactions/cm123", method: "PATCH" });
  });

  it("removes user, extra, contexts, breadcrumbs and server name", () => {
    const scrubbed = scrubSentryEvent(
      eventWith({
        user: { email: "owner@example.com", ip_address: "1.2.3.4" },
        extra: { transactionDescription: "Dinner out" },
        contexts: { state: { value: "Dinner out" } },
        breadcrumbs: [{ message: "fetch /api/transactions?search=rent" }],
        server_name: "vercel-host-42",
        tags: { route: "/api/transactions" },
      }),
    );
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.contexts).toBeUndefined();
    expect(scrubbed.breadcrumbs).toBeUndefined();
    expect(scrubbed.server_name).toBeUndefined();
    expect(scrubbed.tags).toEqual({ route: "/api/transactions" });
  });

  it("redacts a Prisma error whose message embeds a transaction description, but keeps its type and stack", () => {
    const prismaMessage =
      "Invalid `prisma.notableTransaction.findMany()` invocation:\n{ where: { description: \"Dinner at Cafe Cafe\", amount: -12550 } }";
    const scrubbed = scrubSentryEvent(
      eventWith({
        exception: {
          values: [
            {
              type: "PrismaClientKnownRequestError",
              value: prismaMessage,
              stacktrace: {
                frames: [
                  {
                    filename: "app:///src/server/dal/transactions.ts",
                    function: "listTransactions",
                    vars: { description: "Dinner at Cafe Cafe" },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const [value] = scrubbed.exception?.values ?? [];
    expect(value?.type).toBe("PrismaClientKnownRequestError");
    expect(value?.value).toBe("[redacted]");
    expect(JSON.stringify(scrubbed)).not.toContain("Dinner");
    expect(value?.stacktrace?.frames?.[0]).toEqual({
      filename: "app:///src/server/dal/transactions.ts",
      function: "listTransactions",
    });
  });

  it("keeps the useful part of a real internal error and redacts an email that leaked into a message", () => {
    const scrubbed = scrubSentryEvent(
      eventWith({
        exception: {
          values: [
            {
              type: "Error",
              value: "notableTransaction.updateMany is not supported by the field-encryption extension yet",
            },
            { type: "Error", value: "could not send mail to owner@example.com" },
          ],
        },
      }),
    );
    const [first, second] = scrubbed.exception?.values ?? [];
    expect(first?.value).toBe("notableTransaction.updateMany is not supported by the field-encryption extension yet");
    expect(second?.value).toBe("[redacted]");
    expect(JSON.stringify(scrubbed)).not.toContain("josephzuaiter");
  });
});
