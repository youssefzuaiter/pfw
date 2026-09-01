import { describe, expect, it } from "vitest";
import { OTP } from "otplib";
import { buildOtpauthUri, generateTotpSecret, verifyTotpCode } from "./totp";

/**
 * Real round-trip tests against the actual installed otplib v13 API
 * (verified directly against its `.d.ts` files before writing this
 * module — see totp.ts's own doc comment) — no mocking, since TOTP
 * generation/verification is pure, deterministic-given-a-clock crypto
 * with no DB or network dependency.
 */
describe("totp", () => {
  it("generates a base32 secret", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(secret.length).toBeGreaterThanOrEqual(16);
  });

  it("builds an otpauth:// URI naming the issuer and secret", () => {
    const uri = buildOtpauthUri("JBSWY3DPEHPK3PXP", "demo@pfw.local");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("PFW");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
  });

  it("verifies a freshly generated code and rejects an obviously wrong one", async () => {
    const secret = generateTotpSecret();
    const otp = new OTP({ strategy: "totp" });
    const code = await otp.generate({ secret });

    const result = await verifyTotpCode(secret, code, null);
    expect(result.valid).toBe(true);

    const wrong = await verifyTotpCode(secret, "000000", null);
    expect(wrong.valid).toBe(false);
  });

  it("rejects a malformed code instead of throwing", async () => {
    const secret = generateTotpSecret();
    const result = await verifyTotpCode(secret, "not-a-code", null);
    expect(result.valid).toBe(false);
  });

  it("rejects a code generated under a DIFFERENT secret", async () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const otp = new OTP({ strategy: "totp" });
    const codeForA = await otp.generate({ secret: secretA });

    const result = await verifyTotpCode(secretB, codeForA, null);
    expect(result.valid).toBe(false);
  });

  it("replay protection: rejects a code already accepted at or before its own time step", async () => {
    const secret = generateTotpSecret();
    const otp = new OTP({ strategy: "totp" });
    const code = await otp.generate({ secret });

    const first = await verifyTotpCode(secret, code, null);
    expect(first.valid).toBe(true);
    if (!first.valid) throw new Error("unreachable — asserted above");

    const replayed = await verifyTotpCode(secret, code, first.timeStep);
    expect(replayed.valid).toBe(false);
  });
});
