import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { REDACTED_PERSON, redactOtherPeople, toCsv, toCsvCell, toExportValue } from "./format";

/** The data export's value conversion, CSV writing and redaction (AGENTS.md §3uuu). */
describe("toExportValue", () => {
  it("keeps money exact: BigInt as a decimal string, even past 2^53", () => {
    expect(toExportValue(-12550n)).toBe("-12550");
    expect(toExportValue(123456789012345678901234567890n)).toBe("123456789012345678901234567890");
  });

  it("writes decimals, dates and bytes in exact text forms", () => {
    expect(toExportValue(new Decimal("3.712345"))).toBe("3.712345");
    expect(toExportValue(new Date("2026-10-14T10:00:00Z"))).toBe("2026-10-14T10:00:00.000Z");
    expect(toExportValue(new Date(Number.NaN))).toBeNull();
    expect(toExportValue(new Uint8Array([1, 2, 3]))).toBe("AQID");
  });

  it("converts nested JSON and arrays, and drops undefined and non-finite numbers to null", () => {
    expect(toExportValue({ a: [1n, { b: new Date("2026-01-01T00:00:00Z") }], c: undefined, d: Number.POSITIVE_INFINITY })).toEqual({
      a: ["1", { b: "2026-01-01T00:00:00.000Z" }],
      c: null,
      d: null,
    });
  });
});

describe("redactOtherPeople", () => {
  const self = { id: "self-id", email: "Me@Example.com" };

  it("replaces other people's ids and emails at any depth, but keeps the user's own", () => {
    const value = {
      newOwnerUserId: "other-id",
      invitedEmail: "friend@example.com",
      nested: [{ memberUserId: "other-id", ownerEmail: "me@example.com", note: "other-id stays as plain text" }],
      createdById: "other-id",
    };
    expect(redactOtherPeople(value, self)).toEqual({
      newOwnerUserId: REDACTED_PERSON,
      invitedEmail: REDACTED_PERSON,
      nested: [{ memberUserId: REDACTED_PERSON, ownerEmail: "me@example.com", note: "other-id stays as plain text" }],
      createdById: "other-id",
    });
    expect(redactOtherPeople({ userId: "self-id" }, self)).toEqual({ userId: "self-id" });
  });
});

describe("CSV", () => {
  it("neutralizes text a spreadsheet would run as a formula, but leaves numbers as numbers", () => {
    expect(toCsvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(toCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(toCsvCell("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
    expect(toCsvCell("-12550")).toBe("-12550");
    expect(toCsvCell("3.712345")).toBe("3.712345");
    expect(toCsvCell(-4)).toBe("-4");
  });

  it("quotes commas, quotes and line breaks, and writes JSON for objects", () => {
    expect(toCsvCell('KAHVE, "ÇAY"')).toBe('"KAHVE, ""ÇAY"""');
    expect(toCsvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(toCsvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(toCsvCell(null)).toBe("");
    expect(toCsvCell(true)).toBe("true");
  });

  it("writes a header of every key in first-seen order, and nothing for no rows", () => {
    expect(toCsv([{ a: 1, b: "x" }, { b: "y", c: null }])).toBe("a,b,c\r\n1,x,\r\n,y,\r\n");
    expect(toCsv([])).toBe("");
  });
});
