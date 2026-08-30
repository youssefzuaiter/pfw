import { describe, expect, it } from "vitest";
import { isValidEvmAddress, normalizeEvmAddress, shortenEvmAddress } from "./evm-address";

// Generated programmatically and length-verified (0x + exactly 40 hex
// characters) — a hand-typed fixture here previously had a silent
// off-by-one (39 characters, not 40), which made every test using it
// fail against a CORRECT implementation. Caught by the tests
// themselves failing before any implementation change was made — a real
// reminder that a regex-driven validator is only as good as the test
// fixtures exercising it, not evidence of an actual bug in
// `isValidEvmAddress` itself.
const VALID = "0x1aD7C10dE6A97aD325Ef1bFf74F5B47a448885C7";

describe("isValidEvmAddress", () => {
  it("accepts a well-formed mixed-case address", () => {
    expect(isValidEvmAddress(VALID)).toBe(true);
  });

  it("accepts an all-lowercase or all-uppercase address (no checksum verification, see this module's header)", () => {
    expect(isValidEvmAddress(VALID.toLowerCase())).toBe(true);
    expect(isValidEvmAddress("0x" + VALID.slice(2).toUpperCase())).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isValidEvmAddress(`  ${VALID}  `)).toBe(true);
  });

  it.each([
    "not-an-address",
    "0x123", // too short
    "71C7656EC7ab88b098defB751B7401B5f6d8976", // missing 0x prefix
    "0x71C7656EC7ab88b098defB751B7401B5f6d8976AB", // too long
    "0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG", // non-hex characters
    "",
  ])("rejects %s", (input) => {
    expect(isValidEvmAddress(input)).toBe(false);
  });
});

describe("normalizeEvmAddress", () => {
  it("lowercases a valid address", () => {
    expect(normalizeEvmAddress(VALID)).toBe(VALID.toLowerCase());
  });

  it("two differently-cased inputs for the same address normalize identically", () => {
    expect(normalizeEvmAddress(VALID)).toBe(normalizeEvmAddress(VALID.toLowerCase()));
    expect(normalizeEvmAddress(VALID)).toBe(normalizeEvmAddress("0x" + VALID.slice(2).toUpperCase()));
  });

  it("throws for an invalid address", () => {
    expect(() => normalizeEvmAddress("not-an-address")).toThrow(RangeError);
  });
});

describe("shortenEvmAddress", () => {
  it("shortens to the standard wallet-UI '0x1234…abcd' shape", () => {
    expect(shortenEvmAddress(VALID.toLowerCase())).toBe("0x1ad7…85c7");
  });

  it("throws for an invalid address rather than silently slicing garbage", () => {
    expect(() => shortenEvmAddress("not-an-address")).toThrow(RangeError);
  });
});
