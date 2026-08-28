import { describe, expect, it } from "vitest";
import { applyAdapter, detectAdapter, getAdapterById, normalizeAmountText, parseStatementDate } from "./adapters";

const GENERIC_HEADERS = ["Date", "Description", "Amount"];
const LEUMI_HEADERS = ["תאריך", "תיאור", "חובה", "זכות"];
const ISRACARD_HEADERS = ["תאריך עסקה", "שם בית העסק", "סכום חיוב"];

describe("detectAdapter", () => {
  it("detects the generic Date/Description/Amount layout", () => {
    expect(detectAdapter(GENERIC_HEADERS)?.id).toBe("generic");
  });

  it("detects an Israeli bank debit/credit layout with Hebrew headers", () => {
    expect(detectAdapter(LEUMI_HEADERS)?.id).toBe("leumi");
  });

  it("detects a credit-card layout", () => {
    expect(detectAdapter(ISRACARD_HEADERS)?.id).toBe("isracard");
  });

  it("is case- and whitespace-insensitive about header names", () => {
    expect(detectAdapter(["  DATE ", "DESCRIPTION", "amount"])?.id).toBe("generic");
  });

  it("returns null rather than guessing when nothing matches", () => {
    // Guessing would silently mis-sign or mis-date every row — refusing
    // the file is the safe failure.
    expect(detectAdapter(["foo", "bar"])).toBeNull();
  });

  it("does not match a debit/credit adapter that is missing its credit column", () => {
    expect(detectAdapter(["תאריך", "תיאור", "חובה"])?.id).not.toBe("leumi");
  });
});

describe("parseStatementDate", () => {
  it("parses ISO YYYY-MM-DD", () => {
    expect(parseStatementDate("2026-03-04", "YYYY-MM-DD").toISOString()).toBe("2026-03-04T00:00:00.000Z");
  });

  it("parses DD/MM/YYYY as day-first, not month-first", () => {
    // 03/04 is the 3rd of April under this format, not the 4th of March.
    // Auto-detecting the format instead of declaring it per adapter would
    // make this ambiguous for every day-of-month <= 12.
    expect(parseStatementDate("03/04/2026", "DD/MM/YYYY").toISOString()).toBe("2026-04-03T00:00:00.000Z");
  });

  it("accepts . and - separators in a DD/MM/YYYY column", () => {
    expect(parseStatementDate("03.04.2026", "DD/MM/YYYY").toISOString()).toBe("2026-04-03T00:00:00.000Z");
    expect(parseStatementDate("03-04-2026", "DD/MM/YYYY").toISOString()).toBe("2026-04-03T00:00:00.000Z");
  });

  it("anchors a 2-digit year to this century", () => {
    expect(parseStatementDate("03/04/26", "DD/MM/YYYY").getUTCFullYear()).toBe(2026);
  });

  it("rejects a date that does not exist on the calendar", () => {
    // Date.UTC would silently roll this forward to March 3rd.
    expect(() => parseStatementDate("31/02/2026", "DD/MM/YYYY")).toThrow(/not a real calendar date/);
  });

  it("rejects a value in the wrong format for the column", () => {
    expect(() => parseStatementDate("2026-03-04", "DD/MM/YYYY")).toThrow(/DD\/MM\/YYYY/);
    expect(() => parseStatementDate("04/03/2026", "YYYY-MM-DD")).toThrow(/YYYY-MM-DD/);
  });

  it("rejects an empty date", () => {
    expect(() => parseStatementDate("   ", "YYYY-MM-DD")).toThrow(/empty/);
  });
});

describe("normalizeAmountText", () => {
  it("passes through a plain signed decimal", () => {
    expect(normalizeAmountText("-125.50")).toBe("-125.50");
    expect(normalizeAmountText("125.50")).toBe("125.50");
  });

  it("converts accounting parentheses to a leading minus", () => {
    // Merely stripping the punctuation would read this as +125.50 —
    // an inverted amount, which is a silent money-correctness bug.
    expect(normalizeAmountText("(125.50)")).toBe("-125.50");
  });

  it("converts a trailing minus to a leading minus", () => {
    expect(normalizeAmountText("125.50-")).toBe("-125.50");
  });

  it("strips inline currency tokens and whitespace", () => {
    expect(normalizeAmountText(" ₪ 1,250.00 ")).toBe("1,250.00");
    expect(normalizeAmountText("1250.00 ILS")).toBe("1250.00");
  });

  it("drops a redundant leading plus", () => {
    expect(normalizeAmountText("+80.00")).toBe("80.00");
  });

  it("returns an empty string for an empty cell", () => {
    expect(normalizeAmountText("   ")).toBe("");
  });
});

describe("applyAdapter — generic (single signed amount column)", () => {
  const adapter = getAdapterById("generic")!;

  it("maps rows and preserves the sign convention", () => {
    const { rows, errors } = applyAdapter(adapter, GENERIC_HEADERS, [
      ["2026-01-05", "Shufersal", "-250.00"],
      ["2026-01-06", "Salary", "18000.00"],
    ]);

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0].amountAgorot).toBe(-25000);
    expect(rows[1].amountAgorot).toBe(1800000);
    expect(rows[0].occurredAt.toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  it("numbers lines from 2, accounting for the header row", () => {
    const { rows } = applyAdapter(adapter, GENERIC_HEADERS, [["2026-01-05", "A", "-1.00"]]);
    expect(rows[0].lineNumber).toBe(2);
  });

  it("collects a bad row as an error and keeps the good ones", () => {
    const { rows, errors } = applyAdapter(adapter, GENERIC_HEADERS, [
      ["2026-01-05", "Good", "-250.00"],
      ["not-a-date", "Bad", "-250.00"],
      ["2026-01-07", "Also good", "-10.00"],
    ]);

    expect(rows).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0].lineNumber).toBe(3);
  });

  it("rejects a row with no description and no merchant", () => {
    const { errors } = applyAdapter(adapter, GENERIC_HEADERS, [["2026-01-05", "  ", "-250.00"]]);
    expect(errors[0].message).toMatch(/neither a description nor a merchant/);
  });
});

describe("applyAdapter — currency handling (single-currency law)", () => {
  const adapter = getAdapterById("generic")!;
  const headers = ["Date", "Description", "Amount", "Currency"];

  it("accepts shekel rows, however the currency is spelled", () => {
    const { rows, errors } = applyAdapter(adapter, headers, [
      ["2026-01-05", "A", "-10.00", "ILS"],
      ["2026-01-05", "B", "-10.00", "NIS"],
      ["2026-01-05", "C", "-10.00", "₪"],
      ["2026-01-05", "D", "-10.00", ""],
    ]);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(4);
  });

  it("refuses a foreign-currency row instead of importing it as shekels", () => {
    // Importing a USD amount as though it were shekels would corrupt the
    // ledger by roughly 3.7x, and this app has no multi-currency model to
    // convert into.
    const { rows, errors } = applyAdapter(adapter, headers, [["2026-01-05", "Amazon", "-99.00", "USD"]]);
    expect(rows).toHaveLength(0);
    expect(errors[0].message).toMatch(/USD.*not supported|shekel-only/);
  });
});

describe("applyAdapter — leumi (debit & credit columns)", () => {
  const adapter = getAdapterById("leumi")!;

  it("treats a debit as money out and a credit as money in", () => {
    const { rows, errors } = applyAdapter(adapter, LEUMI_HEADERS, [
      ["05/01/2026", "כרטיס אשראי", "250.00", ""],
      ["06/01/2026", "משכורת", "", "18000.00"],
    ]);

    expect(errors).toEqual([]);
    expect(rows[0].amountAgorot).toBe(-25000);
    expect(rows[1].amountAgorot).toBe(1800000);
  });

  it("does not double-negate a bank that already writes debits as negative", () => {
    const { rows } = applyAdapter(adapter, LEUMI_HEADERS, [["05/01/2026", "X", "-250.00", ""]]);
    expect(rows[0].amountAgorot).toBe(-25000);
  });

  it("rejects a row where both debit and credit are populated", () => {
    const { errors } = applyAdapter(adapter, LEUMI_HEADERS, [["05/01/2026", "X", "250.00", "100.00"]]);
    expect(errors[0].message).toMatch(/ambiguous/);
  });

  it("rejects a row where neither debit nor credit has a value", () => {
    const { errors } = applyAdapter(adapter, LEUMI_HEADERS, [["05/01/2026", "X", "", ""]]);
    expect(errors[0].message).toMatch(/neither debit nor credit/);
  });
});

describe("applyAdapter — isracard (charges written as positive)", () => {
  const adapter = getAdapterById("isracard")!;

  it("inverts a positive charge into a negative ledger amount", () => {
    const { rows } = applyAdapter(adapter, ISRACARD_HEADERS, [["05/01/2026", "Wolt [וולט]", "89.90"]]);
    expect(rows[0].amountAgorot).toBe(-8990);
  });

  it("uses the merchant column for both description and merchant name", () => {
    const { rows } = applyAdapter(adapter, ISRACARD_HEADERS, [["05/01/2026", "Wolt [וולט]", "89.90"]]);
    expect(rows[0].description).toBe("Wolt [וולט]");
    expect(rows[0].merchantName).toBe("Wolt [וולט]");
  });
});

describe("applyAdapter — formula-injection neutralization scope", () => {
  const adapter = getAdapterById("generic")!;

  it("neutralizes a formula in the description, without touching the amount", () => {
    const { rows, errors } = applyAdapter(adapter, GENERIC_HEADERS, [
      ["2026-01-05", '=HYPERLINK("http://evil.example","x")', "-250.00"],
    ]);

    expect(errors).toEqual([]);
    expect(rows[0].description).toBe(`'=HYPERLINK("http://evil.example","x")`);
    // The critical half: the negative amount still parsed correctly and
    // was NOT neutralized into an unparseable "'-250.00".
    expect(rows[0].amountAgorot).toBe(-25000);
  });

  it("still imports a negative amount cleanly (the guard never reaches numeric cells)", () => {
    const { rows } = applyAdapter(adapter, GENERIC_HEADERS, [["2026-01-05", "Normal merchant", "-250.00"]]);
    expect(rows[0].amountAgorot).toBe(-25000);
    expect(rows[0].description).toBe("Normal merchant");
  });
});
