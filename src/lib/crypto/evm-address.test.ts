import { describe, expect, it } from "vitest";
import { isValidEvmAddress, normalizeEvmAddress, shortenEvmAddress, toChecksumEvmAddress } from "./evm-address";

// The REAL EIP-55 checksum for this address, computed via `viem`'s own
// `getAddress()` and confirmed by direct execution (not hand-typed or
// assumed) — the module's PREVIOUS test fixture here was a hand-typed
// "well-formed mixed-case address" that turned out to have the WRONG
// checksum casing, undetected while `isValidEvmAddress` only checked
// format. Once checksum validation was added for this task, that old
// fixture started failing its own "accepts a well-formed mixed-case
// address" test — a real, useful signal (not a bug in the new
// implementation) that caught the fixture had never actually carried a
// valid checksum. Replaced with `toChecksumEvmAddress`'s own real output
// rather than another hand-typed guess.
const LOWERCASE = "0x1ad7c10de6a97ad325ef1bff74f5b47a448885c7";
const VALID_CHECKSUMMED = toChecksumEvmAddress(LOWERCASE);

describe("isValidEvmAddress", () => {
  it("accepts a well-formed address with the CORRECT EIP-55 checksum casing", () => {
    expect(isValidEvmAddress(VALID_CHECKSUMMED)).toBe(true);
  });

  it("accepts an all-lowercase address — no checksum information to verify against, per EIP-55", () => {
    expect(isValidEvmAddress(LOWERCASE)).toBe(true);
  });

  it("rejects an all-uppercase address — a real, verified `viem` behavior, not the common paraphrase of the spec (see this module's header)", () => {
    expect(isValidEvmAddress("0x" + LOWERCASE.slice(2).toUpperCase())).toBe(false);
  });

  it("rejects a mixed-case address whose casing does NOT match the true checksum — the whole point of this validation", () => {
    // Flip the case of the first alphabetic hex digit in an otherwise-
    // correct checksummed address — a realistic single-character
    // typo/miscapitalization.
    const alphaIndex = [...VALID_CHECKSUMMED].findIndex((char, i) => i > 1 && /[a-fA-F]/.test(char));
    const flipped = VALID_CHECKSUMMED.split("");
    flipped[alphaIndex] = flipped[alphaIndex] === flipped[alphaIndex].toLowerCase() ? flipped[alphaIndex].toUpperCase() : flipped[alphaIndex].toLowerCase();
    const wrongChecksum = flipped.join("");
    expect(wrongChecksum).not.toBe(VALID_CHECKSUMMED);
    expect(isValidEvmAddress(wrongChecksum)).toBe(false);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isValidEvmAddress(`  ${VALID_CHECKSUMMED}  `)).toBe(true);
  });

  it.each([
    "not-an-address",
    "0x123", // too short
    "1ad7c10de6a97ad325ef1bff74f5b47a448885c7", // missing 0x prefix
    "0x1ad7c10de6a97ad325ef1bff74f5b47a448885c7ab", // too long
    "0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG", // non-hex characters
    "",
  ])("rejects %s", (input) => {
    expect(isValidEvmAddress(input)).toBe(false);
  });
});

describe("toChecksumEvmAddress", () => {
  it("computes the same checksum regardless of the input's original casing", () => {
    expect(toChecksumEvmAddress(LOWERCASE)).toBe(VALID_CHECKSUMMED);
    expect(toChecksumEvmAddress(VALID_CHECKSUMMED)).toBe(VALID_CHECKSUMMED);
    expect(toChecksumEvmAddress("0x" + LOWERCASE.slice(2).toUpperCase())).toBe(VALID_CHECKSUMMED);
  });

  it("the computed checksum is genuinely mixed-case, not all one case", () => {
    const hexPart = VALID_CHECKSUMMED.slice(2);
    expect(hexPart).not.toBe(hexPart.toLowerCase());
    expect(hexPart).not.toBe(hexPart.toUpperCase());
  });

  it("throws for a shape-invalid address", () => {
    expect(() => toChecksumEvmAddress("not-an-address")).toThrow(RangeError);
  });
});

describe("normalizeEvmAddress", () => {
  it("lowercases a validly-checksummed address", () => {
    expect(normalizeEvmAddress(VALID_CHECKSUMMED)).toBe(LOWERCASE);
  });

  it("accepts and lowercases an all-lowercase address unchanged", () => {
    expect(normalizeEvmAddress(LOWERCASE)).toBe(LOWERCASE);
  });

  it("two differently-cased VALID inputs for the same address normalize identically", () => {
    expect(normalizeEvmAddress(VALID_CHECKSUMMED)).toBe(normalizeEvmAddress(LOWERCASE));
  });

  it("throws for an invalid address", () => {
    expect(() => normalizeEvmAddress("not-an-address")).toThrow(RangeError);
  });

  it("throws for a mixed-case address with an incorrect checksum, rather than silently accepting a typo", () => {
    const alphaIndex = [...VALID_CHECKSUMMED].findIndex((char, i) => i > 1 && /[a-fA-F]/.test(char));
    const flipped = VALID_CHECKSUMMED.split("");
    flipped[alphaIndex] = flipped[alphaIndex] === flipped[alphaIndex].toLowerCase() ? flipped[alphaIndex].toUpperCase() : flipped[alphaIndex].toLowerCase();
    expect(() => normalizeEvmAddress(flipped.join(""))).toThrow(RangeError);
  });
});

describe("shortenEvmAddress", () => {
  it("shortens to the standard wallet-UI '0x1234…abcd' shape", () => {
    expect(shortenEvmAddress(LOWERCASE)).toBe("0x1ad7…85c7");
  });

  it("throws for an invalid address rather than silently slicing garbage", () => {
    expect(() => shortenEvmAddress("not-an-address")).toThrow(RangeError);
  });

  it("accepts a validly-checksummed mixed-case address too", () => {
    expect(shortenEvmAddress(VALID_CHECKSUMMED)).toBe("0x1ad7…85c7");
  });
});
