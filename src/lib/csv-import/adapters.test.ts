import { describe, expect, it } from "vitest";
import { applyAdapter, detectAdapter, getAdapterById, normalizeAmountText, normalizeHeader, parseStatementDate } from "./adapters";

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
    expect(rows[0].nativeAmount).toBe(-25000);
    expect(rows[1].nativeAmount).toBe(1800000);
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
    expect(rows[0].nativeAmount).toBe(-25000);
    expect(rows[1].nativeAmount).toBe(1800000);
  });

  it("does not double-negate a bank that already writes debits as negative", () => {
    const { rows } = applyAdapter(adapter, LEUMI_HEADERS, [["05/01/2026", "X", "-250.00", ""]]);
    expect(rows[0].nativeAmount).toBe(-25000);
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
    expect(rows[0].nativeAmount).toBe(-8990);
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
    expect(rows[0].nativeAmount).toBe(-25000);
  });

  it("still imports a negative amount cleanly (the guard never reaches numeric cells)", () => {
    const { rows } = applyAdapter(adapter, GENERIC_HEADERS, [["2026-01-05", "Normal merchant", "-250.00"]]);
    expect(rows[0].nativeAmount).toBe(-25000);
    expect(rows[0].description).toBe("Normal merchant");
  });
});

// ---------------------------------------------------------------------------
// Turkish statements & multi-currency (AGENTS.md §3bbb)
// ---------------------------------------------------------------------------

const TURKISH_DC_HEADERS = ["Tarih", "Açıklama", "Borç", "Alacak"];
const TURKISH_SIGNED_HEADERS = ["İşlem Tarihi", "İşlem Açıklaması", "Tutar"];

describe("normalizeHeader — Turkish folding", () => {
  it("folds dotted İ and dotless ı so any casing of a Turkish header matches its alias", () => {
    // "İ".toLowerCase() is "i̇" (i + U+0307), which never equals an ASCII
    // "i" — without folding, an upper-cased export would never match.
    expect(normalizeHeader("İŞLEM TARİHİ")).toBe(normalizeHeader("işlem tarihi"));
    expect(normalizeHeader("AÇIKLAMA")).toBe(normalizeHeader("açıklama"));
    expect(normalizeHeader("Açıklama")).toBe("aciklama");
    expect(normalizeHeader("Borç")).toBe("borc");
  });

  it("leaves Hebrew headers untouched (no combining marks to strip), so existing adapters still match", () => {
    expect(normalizeHeader("תאריך עסקה")).toBe("תאריך עסקה");
    expect(normalizeHeader("  שם בית העסק ")).toBe("שם בית העסק");
  });
});

describe("detectAdapter — currency awareness", () => {
  it("detects the Turkish debit/credit layout for a TRY account", () => {
    expect(detectAdapter(TURKISH_DC_HEADERS, "TRY")?.id).toBe("turkish-debit-credit");
  });

  it("detects the Turkish signed-amount layout, including upper-cased headers", () => {
    expect(detectAdapter(TURKISH_SIGNED_HEADERS, "TRY")?.id).toBe("turkish-signed-amount");
    expect(detectAdapter(["İŞLEM TARİHİ", "AÇIKLAMA", "TUTAR"], "TRY")?.id).toBe("turkish-signed-amount");
  });

  it("skips an ILS adapter for a TRY account even when its English aliases would match — an English-header Turkish export must not be parsed dot-decimal", () => {
    // leumi has English aliases (date/description/debit/credit) that an
    // English-language Turkish bank export would satisfy; parsing that
    // file dot-decimal would read 1.234,56 as garbage. The Turkish
    // adapter with the same English aliases must win instead.
    expect(detectAdapter(["Date", "Description", "Debit", "Credit"], "ILS")?.id).toBe("leumi");
    expect(detectAdapter(["Date", "Description", "Debit", "Credit"], "TRY")?.id).toBe("turkish-debit-credit");
  });

  it("never offers a Turkish adapter to an ILS account", () => {
    expect(detectAdapter(TURKISH_DC_HEADERS, "ILS")).toBeNull();
  });

  it("still uses the currency-agnostic generic adapter for any account", () => {
    expect(detectAdapter(GENERIC_HEADERS, "TRY")?.id).toBe("generic");
    expect(detectAdapter(GENERIC_HEADERS, "USD")?.id).toBe("generic");
  });

  it("defaults to ILS when no currency is given (every pre-multi-currency caller)", () => {
    expect(detectAdapter(LEUMI_HEADERS)?.id).toBe("leumi");
  });
});

describe("parseStatementDate — trailing time of day", () => {
  it("ignores a trailing HH:MM or HH:MM:SS (Turkish exports carry the transaction time)", () => {
    expect(parseStatementDate("01.03.2026 14:23", "DD/MM/YYYY").toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(parseStatementDate("01/03/2026 14:23:07", "DD/MM/YYYY").toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("normalizeAmountText — comma-decimal grammar", () => {
  it("rewrites a Turkish-style 1.234,56 into dot-decimal", () => {
    expect(normalizeAmountText("1.234,56", "TRY", "comma-decimal")).toBe("1234.56");
    expect(normalizeAmountText("1.234.567,8", "TRY", "comma-decimal")).toBe("1234567.8");
    expect(normalizeAmountText("-1.234,56", "TRY", "comma-decimal")).toBe("-1234.56");
  });

  it("accepts a plain integer or a number with no thousands separator", () => {
    expect(normalizeAmountText("1234,56", "TRY", "comma-decimal")).toBe("1234.56");
    expect(normalizeAmountText("1234", "TRY", "comma-decimal")).toBe("1234");
    expect(normalizeAmountText("1.234", "TRY", "comma-decimal")).toBe("1234");
  });

  it("strips lira tokens and handles the trailing-minus and parenthesis conventions", () => {
    expect(normalizeAmountText("₺ 1.234,56", "TRY", "comma-decimal")).toBe("1234.56");
    expect(normalizeAmountText("1.234,56 TL", "TRY", "comma-decimal")).toBe("1234.56");
    expect(normalizeAmountText("1.234,56-", "TRY", "comma-decimal")).toBe("-1234.56");
    expect(normalizeAmountText("(1.234,56)", "TRY", "comma-decimal")).toBe("-1234.56");
  });

  it("REJECTS a dot-decimal number in a comma-decimal layout rather than swapping separators", () => {
    // A separator swap would turn 1234.56 into 123456 — a silent 100×
    // error. Strict grammar: this is a row error, never a guess.
    expect(() => normalizeAmountText("1234.56", "TRY", "comma-decimal")).toThrow(/not a valid comma-decimal/);
    expect(() => normalizeAmountText("1,234.56", "TRY", "comma-decimal")).toThrow(/not a valid comma-decimal/);
    expect(() => normalizeAmountText("12,345", "TRY", "comma-decimal")).toThrow(/not a valid comma-decimal/);
  });

  it("does not strip another currency's tokens (a ₪ in a TRY file is left for the row to fail on)", () => {
    expect(() => normalizeAmountText("₪ 12,50", "TRY", "comma-decimal")).toThrow(/not a valid comma-decimal/);
  });
});

describe("applyAdapter — turkish-debit-credit", () => {
  const adapter = getAdapterById("turkish-debit-credit")!;

  it("parses Borç as money out and Alacak as money in, in kuruş", () => {
    const { rows, errors } = applyAdapter(
      adapter,
      TURKISH_DC_HEADERS,
      [
        ["01.03.2026", "MİGROS", "1,234.56", ""],
        ["02.03.2026", "MAAŞ", "", "45,000.00"],
      ],
      "TRY",
    );
    expect(errors).toEqual([]);
    expect(rows.map((row) => row.nativeAmount)).toEqual([-123456, 4500000]);
    expect(rows[0].currency).toBe("TRY");
    expect(rows[0].occurredAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(rows[0].providerReference).toBeNull();
  });

  it("accepts a Para Birimi column stating TRY/TL and refuses one stating another currency", () => {
    const headers = [...TURKISH_DC_HEADERS, "Para Birimi"];
    const { rows, errors } = applyAdapter(
      adapter,
      headers,
      [
        ["01.03.2026", "A", "10.00", "", "TL"],
        ["01.03.2026", "B", "10.00", "", "TRY"],
        ["01.03.2026", "C", "10.00", "", "USD"],
      ],
      "TRY",
    );
    expect(rows).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/USD.*not supported/);
  });

  it("reports a comma-decimal amount as a row error instead of a wrong number", () => {
    // These adapters declare dot-decimal (QNB's real format, §3bbb), so
    // a European-style `1.234,56` is refused rather than silently
    // separator-swapped. The direction of this check flipped when a real
    // statement proved the original comma-decimal assumption wrong; the
    // property under test did not — whichever convention is declared,
    // the other one must fail loudly rather than parse to a wrong
    // magnitude.
    const { rows, errors } = applyAdapter(adapter, TURKISH_DC_HEADERS, [["01.03.2026", "X", "1.234,56", ""]], "TRY");
    expect(rows).toHaveLength(0);
    expect(errors[0].message).toMatch(/not a valid decimal amount/i);
  });
});

describe("applyAdapter — turkish-signed-amount", () => {
  const adapter = getAdapterById("turkish-signed-amount")!;

  it("keeps the bank's sign and ignores a trailing time on the date", () => {
    const { rows, errors } = applyAdapter(
      adapter,
      TURKISH_SIGNED_HEADERS,
      [
        ["01.03.2026 14:23", "KAHVE", "-45.50"],
        ["05.03.2026 09:00", "İADE", "45.50"],
      ],
      "TRY",
    );
    expect(errors).toEqual([]);
    expect(rows.map((row) => row.nativeAmount)).toEqual([-4550, 4550]);
  });
});
