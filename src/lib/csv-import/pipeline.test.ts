import { describe, expect, it } from "vitest";
import { CsvParseError, CurrencyMismatchError, UnrecognizedFormatError, isClientFileError, parseStatementCsv } from "./pipeline";

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
    expect(result.rows[0].nativeAmount).toBe(-25000);
    expect(result.rows[1].nativeAmount).toBe(1800000);
  });

  it("parses a Hebrew-header debit/credit statement end to end", () => {
    const result = parseStatementCsv(
      csv(["תאריך,תיאור,חובה,זכות", "05/01/2026,סופרמרקט,250.00,", "06/01/2026,משכורת,,18000.00"].join("\n")),
    );

    expect(result.adapterId).toBe("leumi");
    expect(result.rows.map((row) => row.nativeAmount)).toEqual([-25000, 1800000]);
  });

  it("finds the header below a statement's preamble, not at row 0", () => {
    // A CSV export starts at the header; a PDF statement does not. A real
    // QNB export failed as "could not recognize this file's columns"
    // because row 0 was the bank's own letterhead.
    const result = parseStatementCsv(
      csv(
        [
          "QNB Finansbank A.S.",
          "Hesap Hareketleri",
          "IBAN TR00 0000 0000 0000 0000 0000 00",
          "01/08/2026 - 31/08/2026",
          "",
          "Date,Description,Amount",
          "2026-01-05,Shufersal,-250.00",
        ].join("\n"),
      ),
    );

    expect(result.adapterId).toBe("generic");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].nativeAmount).toBe(-25000);
  });

  it("does not mistake a transaction row for the header", () => {
    // The scan returns the FIRST matching row, so a later row that
    // happens to contain header-ish words can never win.
    const result = parseStatementCsv(
      csv(["Bank statement", "Date,Description,Amount", "2026-01-05,Date Description Amount,-250.00"].join("\n")),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].description).toBe("Date Description Amount");
  });

  it("quotes the file's own first rows back when nothing matches", () => {
    // Without this the message is unactionable — it could equally mean
    // unexpected column names, a header below a letterhead, or a garbled
    // text layer.
    try {
      parseStatementCsv(csv(["QNB Finansbank A.S.", "Hesap Hareketleri", "no,columns,here"].join("\n")));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnrecognizedFormatError);
      expect((error as UnrecognizedFormatError).message).toContain("QNB Finansbank A.S.");
      expect((error as UnrecognizedFormatError).message).toContain("Hesap Hareketleri");
    }
  });

  it("drops the header that a multi-page statement repeats on every page", () => {
    // Left in, each repeat becomes a row whose date cell says "Date" —
    // a RowError, so a 5-page statement would report 4 rejected rows
    // that are not problems with the user's data at all.
    const result = parseStatementCsv(
      csv(
        [
          "Date,Description,Amount",
          "2026-01-05,Shufersal,-250.00",
          "Date,Description,Amount",
          "2026-01-06,Salary,18000.00",
        ].join("\n"),
      ),
    );

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
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
    expect(isClientFileError(new UnrecognizedFormatError([["a"]]))).toBe(true);
    expect(isClientFileError(new CsvParseError("empty_file", "x"))).toBe(true);
    expect(isClientFileError(new CurrencyMismatchError("leumi", "ILS", "TRY"))).toBe(true);
    expect(isClientFileError(new Error("database exploded"))).toBe(false);
  });
});

describe("parseStatementCsv — Turkish statements & currency", () => {
  const TURKISH = [
    "Tarih;Açıklama;Borç;Alacak",
    "01.03.2026;MİGROS;1,234.56;",
    "02.03.2026;MAAŞ;;45,000.00",
    "03.03.2026;\"KAHVE; ÇAY\";45.50;",
  ].join("\r\n");

  it("parses a ;-delimited, dot-decimal, UTF-8 Turkish file for a TRY account end to end", () => {
    const result = parseStatementCsv(csv(TURKISH), { expectedCurrency: "TRY" });

    expect(result.adapterId).toBe("turkish-debit-credit");
    expect(result.currency).toBe("TRY");
    expect(result.errors).toEqual([]);
    expect(result.rows.map((row) => row.nativeAmount)).toEqual([-123456, 4500000, -4550]);
    expect(result.rows[2].description).toBe("KAHVE; ÇAY");
    expect(result.rows.every((row) => row.currency === "TRY")).toBe(true);
  });

  it("parses the same file exported as windows-1254 bytes", () => {
    // Hand-built: every non-ASCII letter as its single cp1254 byte.
    const cp1254 = (text: string) =>
      Uint8Array.from(text, (ch) => {
        const map: Record<string, number> = { ç: 0xe7, ı: 0xfd, İ: 0xdd, ş: 0xfe, Ş: 0xde, ğ: 0xf0, Ç: 0xc7 };
        const byte = map[ch] ?? ch.charCodeAt(0);
        if (byte > 0xff) throw new Error(`fixture: cannot encode ${ch}`);
        return byte;
      });
    const result = parseStatementCsv(cp1254("Tarih;Açıklama;Tutar\n01.03.2026;MİGROS;-1,234.56\n"), {
      expectedCurrency: "TRY",
    });
    expect(result.adapterId).toBe("turkish-signed-amount");
    expect(result.rows[0].description).toBe("MİGROS");
    expect(result.rows[0].nativeAmount).toBe(-123456);
  });

  it("refuses a Turkish file for an ILS account as unrecognized rather than mis-parsing it", () => {
    expect(() => parseStatementCsv(csv(TURKISH))).toThrow(UnrecognizedFormatError);
  });

  it("throws CurrencyMismatchError when a forced adapter's currency is not the account's", () => {
    expect(() => parseStatementCsv(csv(TURKISH), { adapterId: "turkish-debit-credit", expectedCurrency: "ILS" })).toThrow(
      CurrencyMismatchError,
    );
    expect(() => parseStatementCsv(csv(GENERIC), { adapterId: "leumi", expectedCurrency: "TRY" })).toThrow(
      CurrencyMismatchError,
    );
  });

  it("lets the currency-agnostic generic adapter serve a TRY account (dot-decimal, as declared)", () => {
    const result = parseStatementCsv(csv(GENERIC), { expectedCurrency: "TRY" });
    expect(result.adapterId).toBe("generic");
    expect(result.currency).toBe("TRY");
    expect(result.rows[0].nativeAmount).toBe(-25000);
  });

  it("gives an ILS file the identical rows and dedupe keys it always had (default currency is ILS)", () => {
    const implicit = parseStatementCsv(csv(GENERIC));
    const explicit = parseStatementCsv(csv(GENERIC), { expectedCurrency: "ILS" });
    expect(implicit.currency).toBe("ILS");
    expect(explicit.rows).toEqual(implicit.rows);
  });
});

/**
 * A QNB "Hesap Hareketleri" (account movements) statement, as the PDF
 * reader hands it to the pipeline: one tab-separated row per movement,
 * columns Date / Channel / Description / Amount / Balance. Every name,
 * merchant and figure below is made up; what is real is the SHAPE, taken
 * from a real statement that parsed with no rejected row and reconciled
 * to the bank's own closing balance: dates as DD/MM/YYYY,
 * thousands commas with a dot decimal, a signed amount, commas and a
 * "10,00 USD alış, işlem kuru 48,0 TL" inside descriptions, an opening-
 * balance line with no date, a charge reversed by an equal credit the same
 * day, and several identical charges on one day.
 */
describe("parseStatementCsv — a QNB account-movements statement", () => {
  const row = (...cells: string[]) => cells.join("\t");
  const STATEMENT = [
    row("İşlem Tarihi", "Kanal*", "İşlem Açıklaması", "Tutar", "Bakiye"),
    row("", "", "DEVREDEN BAKİYE", "", "100.00"),
    row("16/07/2026", "FEFT", "Transfer İşlemleri - Gönderen: AAA BBB - Trans", "1,500.00", "1,600.00"),
    row("16/07/2026", "POS", "Kart İşlemleri - 1234567 -SHOP A ISTANBUL TR Pos satış.", "-640.00", "960.00"),
    row("17/07/2026", "MB", "Yatırım İşlemleri - Mobil Bankacılık 10,00 USD alış, işlem kuru 48,000000 TL", "480.00", "1,440.00"),
    row("17/07/2026", "POS", "Kart İşlemleri - WEBPOS SATIŞ 100-FOOD ISTANBULAVR TR.", "-30.00", "1,410.00"),
    row("17/07/2026", "POS", "Kart İşlemleri - WEBPOS SATIŞ 100-FOOD ISTANBULAVR TR.", "-30.00", "1,380.00"),
    row("20/07/2026", "POS", "Kart İşlemleri - WEBPOS SATIŞ 200-RIDE ISTANBUL TR.", "-1.00", "1,379.00"),
    row("20/07/2026", "POS", "Kart İşlemleri - WEBPOS SATIŞ 200-RIDE ISTANBUL TR. İptali", "1.00", "1,380.00"),
    row("21/07/2026", "MB", "Ödeme İşlemleri - 11111111 - SU İDARESİ tahsilatı. Mobil Bankacılık.", "-1,512.40", "-132.40"),
  ].join("\n");
  const parse = (text = STATEMENT) => parseStatementCsv(csv(text), { expectedCurrency: "TRY" });

  it("recognises the layout for a lira account and rejects nothing", () => {
    const result = parse();
    expect(result.adapterId).toBe("turkish-signed-amount");
    expect(result.currency).toBe("TRY");
    expect(result.errors).toEqual([]);
    // The opening-balance line has no date and no amount: it is furniture, not a transaction.
    expect(result.rows).toHaveLength(8);
    expect(result.rows.some((r) => r.description.includes("DEVREDEN"))).toBe(false);
  });

  it("reads DD/MM/YYYY as day-first, not month-first", () => {
    const dates = parse().rows.map((r) => r.occurredAt.toISOString().slice(0, 10));
    expect(dates).toEqual([
      "2026-07-16", "2026-07-16", "2026-07-17", "2026-07-17", "2026-07-17", "2026-07-20", "2026-07-20", "2026-07-21",
    ]);
  });

  it("keeps money in as positive and money out as negative, in kuruş, through thousands commas", () => {
    expect(parse().rows.map((r) => r.nativeAmount)).toEqual([150000, -64000, 48000, -3000, -3000, -100, 100, -151240]);
  });

  it("nets a charge and its same-day reversal to zero", () => {
    const [charge, reversal] = parse().rows.filter((r) => r.description.includes("200-RIDE"));
    expect(charge.nativeAmount + reversal.nativeAmount).toBe(0);
  });

  it("keeps commas inside a description intact, and never splits a row on them", () => {
    const usd = parse().rows.find((r) => r.description.includes("USD alış"));
    expect(usd?.description).toContain("10,00 USD alış, işlem kuru 48,000000 TL");
    expect(usd?.nativeAmount).toBe(48000);
  });

  it("reconciles to the statement's own running balance", () => {
    // Opening 100.00 plus every imported amount must equal the last printed balance, -132.40.
    const total = parse().rows.reduce((sum, r) => sum + Number(r.nativeAmount), 0);
    expect(10000 + total).toBe(-13240);
  });

  it("gives every row its own duplicate key, even identical charges on the same day", () => {
    const keys = parse().rows.map((r) => r.dedupeKeySource);
    expect(new Set(keys).size).toBe(keys.length);
    const foods = parse().rows.filter((r) => r.description.includes("100-FOOD"));
    expect(foods).toHaveLength(2);
    expect(foods[0].dedupeKeySource).not.toBe(foods[1].dedupeKeySource);
  });

  it("re-importing the same statement yields identical keys, so nothing is added twice", () => {
    const first = parse().rows.map((r) => r.dedupeKeySource);
    const second = parse().rows.map((r) => r.dedupeKeySource);
    expect(second).toEqual(first);
  });

  it("keeps the earlier rows' keys when a later statement overlaps and adds new rows", () => {
    const extended = `${STATEMENT}\n${row("22/07/2026", "POS", "Kart İşlemleri - 7654321 -SHOP B ISTANBUL TR Pos satış.", "-50.00", "-182.40")}`;
    const original = parse().rows.map((r) => r.dedupeKeySource);
    const longer = parse(extended).rows.map((r) => r.dedupeKeySource);
    expect(longer.slice(0, original.length)).toEqual(original);
    expect(longer).toHaveLength(original.length + 1);
  });

  it("refuses the layout for a shekel account rather than mis-reading it", () => {
    expect(() => parseStatementCsv(csv(STATEMENT))).toThrow(UnrecognizedFormatError);
  });
});
