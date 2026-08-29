import { afterEach, describe, expect, it } from "vitest";
import { checkOllamaAvailability } from "./ollama-client";

/**
 * The copilot's entire premise is "zero financial text ever touches a
 * cloud server" (AGENTS.md §3o) — these tests pin down the one guard
 * that actually enforces it: a misconfigured `OLLAMA_BASE_URL` pointing
 * at a real remote host must be refused outright, not silently used.
 */
describe("ollama-client: local-only address enforcement", () => {
  const originalBaseUrl = process.env.OLLAMA_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.OLLAMA_BASE_URL;
    } else {
      process.env.OLLAMA_BASE_URL = originalBaseUrl;
    }
  });

  it("refuses a public/remote host outright", async () => {
    process.env.OLLAMA_BASE_URL = "https://some-cloud-llm-provider.example.com";
    const result = await checkOllamaAvailability();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/does not resolve to a local\/private host/);
    }
  });

  it("refuses a public IP address", async () => {
    process.env.OLLAMA_BASE_URL = "http://8.8.8.8:11434";
    const result = await checkOllamaAvailability();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/does not resolve to a local\/private host/);
    }
  });

  it("refuses a malformed URL with a clear error, not a crash", async () => {
    process.env.OLLAMA_BASE_URL = "not-a-url";
    const result = await checkOllamaAvailability();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/not a valid URL/);
    }
  });

  describe("accepts every allowed local/private form (network call itself may still fail in this sandbox)", () => {
    const allowedHosts = [
      "http://localhost:11434",
      "http://127.0.0.1:11434",
      "http://10.0.0.5:11434",
      "http://172.16.0.5:11434",
      "http://172.31.255.255:11434",
      "http://192.168.1.50:11434",
    ];

    for (const host of allowedHosts) {
      it(`does not reject ${host} for being non-local`, async () => {
        process.env.OLLAMA_BASE_URL = host;
        const result = await checkOllamaAvailability();
        // No real Ollama server is running in this environment, so the
        // fetch itself fails — the point of this test is only that the
        // failure reason is a connection error, never the "not local"
        // refusal, proving the allowlist genuinely accepts these hosts.
        if (!result.available) {
          expect(result.reason).not.toMatch(/does not resolve to a local\/private host/);
        }
      });
    }
  });

  it("rejects a private-range-looking address just outside the actual RFC1918 bounds", async () => {
    // 172.32.x.x is NOT in the 172.16.0.0/12 private range (that's 172.16-172.31) — a
    // naive prefix check ("starts with 172.") would wrongly allow this.
    process.env.OLLAMA_BASE_URL = "http://172.32.0.1:11434";
    const result = await checkOllamaAvailability();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/does not resolve to a local\/private host/);
    }
  });
});
