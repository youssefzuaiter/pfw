import { describe, expect, it } from "vitest";
import { maskTopic, parseNtfyTopic } from "./ntfy-topic";

describe("parseNtfyTopic", () => {
  it("accepts a bare topic name, trimmed", () => {
    expect(parseNtfyTopic("  pfw-alerts_2026-x  ")).toBe("pfw-alerts_2026-x");
  });

  it("reduces a pasted ntfy.sh URL to its name", () => {
    expect(parseNtfyTopic("https://ntfy.sh/pfw-alerts-abc123")).toBe("pfw-alerts-abc123");
    expect(parseNtfyTopic("ntfy.sh/pfw-alerts-abc123/")).toBe("pfw-alerts-abc123");
    expect(parseNtfyTopic("HTTP://NTFY.SH/pfw-alerts-abc123")).toBe("pfw-alerts-abc123");
  });

  it("refuses any other host, so a stored topic can never point the server elsewhere", () => {
    expect(parseNtfyTopic("https://ntfy.example.com/pfw-alerts-abc123")).toBeNull();
    expect(parseNtfyTopic("https://evil.example/ntfy.sh/pfw-alerts-abc123")).toBeNull();
    expect(parseNtfyTopic("https://ntfy.sh.evil.example/pfw-alerts-abc123")).toBeNull();
  });

  it("refuses a name that is too short to be hard to guess, or too long", () => {
    expect(parseNtfyTopic("a".repeat(11))).toBeNull();
    expect(parseNtfyTopic("a".repeat(12))).toBe("a".repeat(12));
    expect(parseNtfyTopic("a".repeat(64))).toBe("a".repeat(64));
    expect(parseNtfyTopic("a".repeat(65))).toBeNull();
  });

  it("refuses characters ntfy does not allow in a topic", () => {
    expect(parseNtfyTopic("pfw alerts abc123")).toBeNull();
    expect(parseNtfyTopic("pfw-alerts/abc123")).toBeNull();
    expect(parseNtfyTopic("pfw-alerts-ünicode")).toBeNull();
    expect(parseNtfyTopic("https://ntfy.sh/pfw-alerts-abc123?auth=x")).toBeNull();
  });
});

describe("maskTopic", () => {
  it("keeps only the last four characters", () => {
    expect(maskTopic("pfw-alerts-abc123")).toBe("…c123");
  });
});
