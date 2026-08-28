import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isTrustedOrigin } from "./verify-origin";

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("https://pfw.example/api/transactions/1", { headers });
}

describe("isTrustedOrigin()", () => {
  it("allows a request with no Origin header (some legitimate same-origin requests omit it)", () => {
    expect(isTrustedOrigin(makeRequest({ host: "pfw.example" }))).toBe(true);
  });

  it("allows a same-origin request", () => {
    expect(isTrustedOrigin(makeRequest({ origin: "https://pfw.example", host: "pfw.example" }))).toBe(true);
  });

  it("rejects a cross-origin request", () => {
    expect(isTrustedOrigin(makeRequest({ origin: "https://evil.example", host: "pfw.example" }))).toBe(false);
  });

  it("rejects a malformed Origin header rather than throwing", () => {
    expect(isTrustedOrigin(makeRequest({ origin: "not-a-url", host: "pfw.example" }))).toBe(false);
  });

  it("rejects when Host is missing but Origin is present, rather than throwing", () => {
    expect(isTrustedOrigin(makeRequest({ origin: "https://pfw.example" }))).toBe(false);
  });

  it("rejects an origin that only differs by length (exercises the constant-time comparison's length guard)", () => {
    expect(isTrustedOrigin(makeRequest({ origin: "https://pfw.example.evil", host: "pfw.example" }))).toBe(false);
  });

  it("rejects a same-length origin that differs only in its last character", () => {
    expect(isTrustedOrigin(makeRequest({ origin: "https://pfw.exampld", host: "pfw.example" }))).toBe(false);
  });
});
