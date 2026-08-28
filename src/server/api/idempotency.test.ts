import { afterEach, describe, expect, it } from "vitest";
import { _resetIdempotencyStoreForTests, getIdempotentResponse, storeIdempotentResponse } from "./idempotency";

describe("idempotency store", () => {
  afterEach(() => {
    _resetIdempotencyStoreForTests();
  });

  it("returns undefined for a key that was never stored", () => {
    expect(getIdempotentResponse("user-a", "key-1")).toBeUndefined();
  });

  it("returns the stored response for a matching (user, key) pair", () => {
    storeIdempotentResponse("user-a", "key-1", 201, { id: "trade-1" });
    expect(getIdempotentResponse("user-a", "key-1")).toMatchObject({ status: 201, body: { id: "trade-1" } });
  });

  it("scopes keys per user — the same key string for a different user is a miss", () => {
    storeIdempotentResponse("user-a", "key-1", 201, { id: "trade-1" });
    expect(getIdempotentResponse("user-b", "key-1")).toBeUndefined();
  });
});
