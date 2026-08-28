import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAnthropicApiKey,
  getAppDatabaseUrl,
  getDatabaseUrl,
  getEmbeddingSidecarUrl,
  getEncryptionKey,
} from "./env";

describe("server env accessors", () => {
  const originalEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    APP_DATABASE_URL: process.env.APP_DATABASE_URL,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.APP_DATABASE_URL;
    delete process.env.ENCRYPTION_KEY;
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
});
