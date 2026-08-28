import { describe, expect, it } from "vitest";
import { CsvParseError, UnrecognizedFormatError, isClientFileError, parseStatementCsv } from "./pipeline";

function csv(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const GENERIC = ["Date,Description,Amount", "2026-01-05,Shufersal,-250.00", "2026-01-06,Salary,18000.00"].join(
  "\n",
);

describe("parseStatementCsv", () => {
  it("parses a generic statement end to end", () => {
    const result = parseStatementCsv(csv(GENERIC));

    expect(result.adapterId).toBe("generic");
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].amountAgorot).toBe(-25000);
    expect(result.rows[1].amountAgorot).toBe(1800000);
  });

  it("parses a Hebrew-header debit/credit statement end to end", () => {
    const result = parseStatementCsv(
      csv(["תאריך,תיאור,חובה,זכות", "05/01/2026,סופרמרקט,250.00,", "06/01/2026,משכורת,,18000.00"].join("\n")),
    );

    expect(result.adapterId).toBe("leumi");
    expect(result.rows.map((row) => row.amountAgorot)).toEqual([-25000, 1800000]);
  });

  it("handles a BOM, CRLF endings and quoted commas together", () => {
    const result = parseStatementCsv(csv('﻿Date,Description,Amount\r\n2026-01-05,"Levy, Rami",-250.00\r\n'));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].description).toBe("Levy, Rami");
  });

  it("reports per-row errors without failing the whole file", () => {
    const result = parseStatementCsv(
      csv(["Date,Description,Amount", "2026-01-05,Good,-250.00", "bad-date,Bad,-1.00"].join("\n")),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].lineNumber).toBe(3);
  });

  it("throws UnrecognizedFormatError for headers no adapter matches", () => {
    expect(() => parseStatementCsv(csv("foo,bar\n1,2"))).toThrow(UnrecognizedFormatError);
  });

  it("throws UnrecognizedFormatError for an explicitly requested unknown adapter", () => {
    expect(() => parseStatementCsv(csv(GENERIC), { adapterId: "nope" })).toThrow(UnrecognizedFormatError);
  });

  it("honors an explicitly requested adapter over detection", () => {
    expect(parseStatementCsv(csv(GENERIC), { adapterId: "generic" }).adapterId).toBe("generic");
  });

  it("propagates a tokenizer failure (oversized file) as a CsvParseError", () => {
    expect(() => parseStatementCsv(csv(GENERIC), { limits: { maxBytes: 5, maxRows: 10, maxFieldLength: 10 } })).toThrow(
      CsvParseError,
    );
  });
});

describe("dedupe keys", () => {
  it("gives distinct rows distinct keys", () => {
    const result = parseStatementCsv(csv(GENERIC));
    expect(result.rows[0].dedupeKeySource).not.toBe(result.rows[1].dedupeKeySource);
  });

  it("is stable across re-parses of identical content — this is what makes re-import idempotent", () => {
    const first = parseStatementCsv(csv(GENERIC));
    const second = parseStatementCsv(csv(GENERIC));
    expect(first.rows.map((r) => r.dedupeKeySource)).toEqual(second.rows.map((r) => r.dedupeKeySource));
  });

  it("keeps two genuinely identical same-day transactions distinct via an occurrence ordinal", () => {
    // Two identical coffees on the same day are two real purchases. A
    // pure content hash would collapse them into one and understate
    // spending; the ordinal is what prevents that.
    const result = parseStatementCsv(
      csv(["Date,Description,Amount", "2026-01-05,Cafe Cafe,-12.00", "2026-01-05,Cafe Cafe,-12.00"].join("\n")),
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].dedupeKeySource).not.toBe(result.rows[1].dedupeKeySource);
    expect(result.rows[0].dedupeKeySource).toContain("#0");
    expect(result.rows[1].dedupeKeySource).toContain("#1");
  });

  it("still reproduces those same ordinals on a re-import, so duplicates are caught", () => {
    const content = ["Date,Description,Amount", "2026-01-05,Cafe Cafe,-12.00", "2026-01-05,Cafe Cafe,-12.00"].join(
      "\n",
    );
    const first = parseStatementCsv(csv(content));
    const second = parseStatementCsv(csv(content));
    expect(first.rows.map((r) => r.dedupeKeySource)).toEqual(second.rows.map((r) => r.dedupeKeySource));
  });

  it("distinguishes rows that differ only by amount", () => {
    const result = parseStatementCsv(
      csv(["Date,Description,Amount", "2026-01-05,Cafe,-12.00", "2026-01-05,Cafe,-13.00"].join("\n")),
    );
    expect(result.rows[0].dedupeKeySource).not.toBe(result.rows[1].dedupeKeySource);
  });

  it("carries the bank's own reference through when the export provides one", () => {
    const result = parseStatementCsv(
      csv(["Date,Description,Amount,Reference", "2026-01-05,Shufersal,-250.00,TXN-9931"].join("\n")),
    );
    expect(result.rows[0].providerReference).toBe("TXN-9931");
  });

  it("falls back to null reference when the column is absent", () => {
    expect(parseStatementCsv(csv(GENERIC)).rows[0].providerReference).toBeNull();
  });
});

describe("isClientFileError", () => {
  it("identifies bad-file errors (→ 400) and not unexpected faults (→ 500)", () => {
    expect(isClientFileError(new UnrecognizedFormatError(["a"]))).toBe(true);
    expect(isClientFileError(new CsvParseError("empty_file", "x"))).toBe(true);
    expect(isClientFileError(new Error("database exploded"))).toBe(false);
  });
});
