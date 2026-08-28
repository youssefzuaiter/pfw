import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAnthropicApiKey,
  getAppDatabaseUrl,
  getBankApiCredentials,
  getDatabaseUrl,
  getEmbeddingSidecarUrl,
  getEncryptionKey,
  SECRET_ENV_VAR_NAMES,
} from "./env";

const VALID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

describe("server env accessors", () => {
  const originalEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    APP_DATABASE_URL: process.env.APP_DATABASE_URL,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    BANK_API_CLIENT_ID: process.env.BANK_API_CLIENT_ID,
    BANK_API_CLIENT_SECRET: process.env.BANK_API_CLIENT_SECRET,
    BANK_API_BASE_URL: process.env.BANK_API_BASE_URL,
  };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.APP_DATABASE_URL;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.BANK_API_CLIENT_ID;
    delete process.env.BANK_API_CLIENT_SECRET;
    delete process.env.BANK_API_BASE_URL;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  it.each([
    ["ANTHROPIC_API_KEY", getAnthropicApiKey],
    ["DATABASE_URL", getDatabaseUrl],
    ["APP_DATABASE_URL", getAppDatabaseUrl],
    ["ENCRYPTION_KEY", getEncryptionKey],
  ] as const)("throws when %s is unset", (name, getter) => {
    expect(() => getter()).toThrow(new RegExp(name));
  });

  it("returns the value once set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-value";
    expect(getAnthropicApiKey()).toBe("sk-test-value");
  });

  it("keeps the admin and app database URLs distinct", () => {
    process.env.DATABASE_URL = "postgresql://pfw_app:x@localhost:5433/pfw_local";
    process.env.APP_DATABASE_URL = "postgresql://pfw_runtime:y@localhost:5433/pfw_local";
    expect(getDatabaseUrl()).not.toBe(getAppDatabaseUrl());
  });

  it("getEmbeddingSidecarUrl defaults to localhost:8001 when unset (not a secret, no throw)", () => {
    delete process.env.EMBEDDING_SIDECAR_URL;
    expect(getEmbeddingSidecarUrl()).toBe("http://localhost:8001");
  });

  it("getEmbeddingSidecarUrl respects an override", () => {
    process.env.EMBEDDING_SIDECAR_URL = "http://sidecar.internal:9000";
    expect(getEmbeddingSidecarUrl()).toBe("http://sidecar.internal:9000");
    delete process.env.EMBEDDING_SIDECAR_URL;
  });

  describe("Zod format validation (not just presence)", () => {
    it.each([
      ["not-a-url", "no scheme at all"],
      ["http://localhost:5433/pfw_local", "wrong scheme (http, not postgres)"],
      ["mysql://user:pass@localhost:3306/db", "wrong scheme (mysql, not postgres)"],
    ])("rejects DATABASE_URL=%s (%s)", (badValue) => {
      process.env.DATABASE_URL = badValue;
      expect(() => getDatabaseUrl()).toThrow(/DATABASE_URL/);
    });

    it("accepts a well-formed postgresql:// URL", () => {
      process.env.DATABASE_URL = "postgresql://pfw_app:x@localhost:5433/pfw_local?schema=public";
      expect(getDatabaseUrl()).toBe("postgresql://pfw_app:x@localhost:5433/pfw_local?schema=public");
    });

    it("accepts the shorter postgres:// scheme too", () => {
      process.env.DATABASE_URL = "postgres://pfw_app:x@localhost:5433/pfw_local";
      expect(getDatabaseUrl()).toBe("postgres://pfw_app:x@localhost:5433/pfw_local");
    });

    it("rejects an ENCRYPTION_KEY that doesn't decode to 32 bytes", () => {
      process.env.ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64"); // 16 bytes, not 32
      expect(() => getEncryptionKey()).toThrow(/ENCRYPTION_KEY/);
    });

    it("accepts a genuinely 32-byte base64-encoded ENCRYPTION_KEY", () => {
      process.env.ENCRYPTION_KEY = VALID_ENCRYPTION_KEY;
      expect(getEncryptionKey()).toBe(VALID_ENCRYPTION_KEY);
    });

    it("rejects a whitespace-only value the same as unset", () => {
      process.env.ANTHROPIC_API_KEY = "   ";
      expect(() => getAnthropicApiKey()).toThrow(/ANTHROPIC_API_KEY/);
    });
  });

  describe("SECRET_ENV_VAR_NAMES (single source of truth for the no-public-secrets guard)", () => {
    it("includes every always-required secret", () => {
      expect(SECRET_ENV_VAR_NAMES).toEqual(
        expect.arrayContaining(["ANTHROPIC_API_KEY", "DATABASE_URL", "APP_DATABASE_URL", "ENCRYPTION_KEY"]),
      );
    });

    it("includes the optional future bank API credentials, even though nothing reads them yet", () => {
      expect(SECRET_ENV_VAR_NAMES).toEqual(
        expect.arrayContaining(["BANK_API_CLIENT_ID", "BANK_API_CLIENT_SECRET"]),
      );
    });

    it("does not include the non-secret bank API base URL", () => {
      expect(SECRET_ENV_VAR_NAMES).not.toContain("BANK_API_BASE_URL");
    });
  });

  describe("getBankApiCredentials() — Tier 3 scaffolding, unused today", () => {
    it("returns null when nothing is configured (the expected Tier 2 state)", () => {
      expect(getBankApiCredentials()).toBeNull();
    });

    it.each([
      ["BANK_API_CLIENT_ID"],
      ["BANK_API_CLIENT_SECRET"],
      ["BANK_API_BASE_URL"],
    ] as const)("throws when only %s is set (a partial credential, not 'unconfigured')", (onlySet) => {
      process.env[onlySet] = "partial-value";
      expect(() => getBankApiCredentials()).toThrow(/must all be set together/);
    });

    it("returns the parsed credentials when all three are set validly", () => {
      process.env.BANK_API_CLIENT_ID = "client-123";
      process.env.BANK_API_CLIENT_SECRET = "shh-its-a-secret";
      process.env.BANK_API_BASE_URL = "https://api.example-bank.co.il";
      expect(getBankApiCredentials()).toEqual({
        clientId: "client-123",
        clientSecret: "shh-its-a-secret",
        baseUrl: "https://api.example-bank.co.il",
      });
    });

    it("throws when BANK_API_BASE_URL is set but not a well-formed URL", () => {
      process.env.BANK_API_CLIENT_ID = "client-123";
      process.env.BANK_API_CLIENT_SECRET = "shh-its-a-secret";
      process.env.BANK_API_BASE_URL = "not-a-url";
      expect(() => getBankApiCredentials()).toThrow(/BANK_API_BASE_URL/);
    });
  });
});
