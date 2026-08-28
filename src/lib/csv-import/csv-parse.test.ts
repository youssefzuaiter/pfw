import { describe, expect, it } from "vitest";
import { CsvParseError, DEFAULT_CSV_LIMITS, decodeCsvBytes, tokenizeCsv } from "./csv-parse";

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("tokenizeCsv", () => {
  it("parses a simple header + rows", () => {
    expect(tokenizeCsv("a,b\n1,2\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(tokenizeCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("preserves commas inside quoted fields", () => {
    expect(tokenizeCsv('a,b\n"Levy, Rami",2')).toEqual([
      ["a", "b"],
      ["Levy, Rami", "2"],
    ]);
  });

  it("preserves newlines inside quoted fields", () => {
    expect(tokenizeCsv('a,b\n"line one\nline two",2')).toEqual([
      ["a", "b"],
      ["line one\nline two", "2"],
    ]);
  });

  it('unescapes doubled "" quotes inside a quoted field', () => {
    expect(tokenizeCsv('a\n"He said ""hi"""')).toEqual([["a"], ['He said "hi"']]);
  });

  it("strips a leading UTF-8 BOM so the first header still matches", () => {
    // Without BOM stripping the first cell is "﻿Date", which silently
    // matches no adapter column alias — a real and very common bank-export
    // failure mode.
    const [headers] = tokenizeCsv("﻿Date,Amount\n2026-01-01,5");
    expect(headers[0]).toBe("Date");
  });

  it("skips blank lines rather than yielding empty rows", () => {
    expect(tokenizeCsv("a,b\n\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty trailing cells", () => {
    expect(tokenizeCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("flushes a final row with no trailing newline", () => {
    expect(tokenizeCsv("a\n1")).toEqual([["a"], ["1"]]);
  });

  it("throws on an unterminated quoted field", () => {
    expect(() => tokenizeCsv('a\n"never closed')).toThrow(CsvParseError);
  });

  it("throws on an empty file", () => {
    expect(() => tokenizeCsv("")).toThrow(/no rows/);
  });

  it("enforces the row ceiling", () => {
    const many = ["h", ...Array.from({ length: 12 }, (_, i) => String(i))].join("\n");
    expect(() => tokenizeCsv(many, { ...DEFAULT_CSV_LIMITS, maxRows: 10 })).toThrow(/10-row limit/);
  });

  it("enforces the per-field length ceiling", () => {
    const long = "h\n" + "x".repeat(50);
    expect(() => tokenizeCsv(long, { ...DEFAULT_CSV_LIMITS, maxFieldLength: 20 })).toThrow(/20-character/);
  });
});

describe("decodeCsvBytes", () => {
  it("decodes UTF-8, including Hebrew", () => {
    expect(decodeCsvBytes(encode("תיאור,סכום"))).toBe("תיאור,סכום");
  });

  it("rejects a file over the byte ceiling before decoding it", () => {
    const bytes = encode("x".repeat(100));
    expect(() => decodeCsvBytes(bytes, { ...DEFAULT_CSV_LIMITS, maxBytes: 50 })).toThrow(/too large|limit/i);
  });

  it("measures the limit in bytes, not characters", () => {
    // 10 Hebrew characters are 20 UTF-8 bytes — a character-based check
    // would wrongly let this through a 15-byte ceiling.
    const bytes = encode("א".repeat(10));
    expect(bytes.byteLength).toBe(20);
    expect(() => decodeCsvBytes(bytes, { ...DEFAULT_CSV_LIMITS, maxBytes: 15 })).toThrow();
  });
});
