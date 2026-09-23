import { describe, expect, it } from "vitest";
import { pdfTextToRows, pdfTextToTsv } from "./pasted-table";
import { detectAdapter, applyAdapter } from "./adapters";
import { sniffDelimiter, tokenizeCsv } from "./csv-parse";

/**
 * Fixtures are the real shape of a QNB statement copied out of a PDF
 * viewer (AGENTS.md §3bbb) — tab-separated columns, a spaces-separated
 * gap in the header row, and amounts in comma-thousands/dot-decimal.
 * Every value here is invented; only the structure is real.
 */
const HEADER =
  "İşlem Tarihi\tKanal*\tİşlem Açıklaması                                                        Tutar\t\tBakiye";
const OPENING_BALANCE = "\t\tDEVREDEN BAKİYE\t\t352.66";
const CARD_ROW =
  "01/08/2026\tPOS\tKart İşlemleri -  1800085944     -BIM J069 USTTARABYA      ISTANBUL     TR Pos satış.\t-94.25\t258.41";
const FX_ROW =
  "01/08/2026\tMB\tYatırım İşlemleri - Mobil Bankacılık 5,00 USD alış, işlem kuru 46,050000 TL\t230.25\t488.66";
const FEE_ROW = "02/08/2026\tMB\tTransfer İşlemleri - 3.3.1 EFT Ücreti\t-7.97\t285.35";
const THOUSANDS_ROW =
  "02/08/2026\tMB\tYatırım İşlemleri - Mobil Bankacılık 20,00 USD alış, işlem kuru 46,050000 TL\t921.00\t1,230.96";

describe("pdfTextToRows", () => {
  it("splits the header on spaces OR tabs, but data rows on tabs only", () => {
    // The header's `İşlem Açıklaması`/`Tutar` break is spaces; a data
    // row's description legitimately contains runs of spaces. Applying
    // one rule to both shreds one or merges the other.
    const [header, card] = pdfTextToRows([HEADER, CARD_ROW].join("\n"));

    expect(header).toEqual(["İşlem Tarihi", "Kanal*", "İşlem Açıklaması", "Tutar", "Bakiye"]);
    expect(card).toHaveLength(5);
    expect(card[2]).toContain("BIM J069 USTTARABYA      ISTANBUL");
  });

  it("drops the header repeated at the top of every page", () => {
    // A multi-page export carries it on each page; parsed as data it
    // would become a transaction dated "İşlem Tarihi".
    const rows = pdfTextToRows([HEADER, CARD_ROW, HEADER, FEE_ROW].join("\n"));
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row[0] === "İşlem Tarihi")).toHaveLength(1);
  });

  it("drops page furniture, which never contains a tab", () => {
    const rows = pdfTextToRows([HEADER, CARD_ROW, "Sayfa 1 / 3", "QNB Finansbank A.Ş.", FEE_ROW].join("\n"));
    expect(rows).toHaveLength(3);
  });

  it("KEEPS the opening-balance line — deciding it isn't a transaction belongs to the adapter, not here", () => {
    const rows = pdfTextToRows([HEADER, OPENING_BALANCE, CARD_ROW].join("\n"));
    expect(rows).toHaveLength(3);
    expect(rows[1][2]).toBe("DEVREDEN BAKİYE");
  });

  it("ignores blank lines and normalizes CRLF", () => {
    const rows = pdfTextToRows([HEADER, "", CARD_ROW, "   "].join("\r\n"));
    expect(rows).toHaveLength(2);
  });

  it("returns nothing for empty input rather than throwing", () => {
    expect(pdfTextToRows("")).toEqual([]);
    expect(pdfTextToRows("   \n\n  ")).toEqual([]);
  });
});

describe("pdfTextToTsv", () => {
  it("emits tabs, not commas — the data is full of commas that are not delimiters", () => {
    const tsv = pdfTextToTsv([HEADER, FX_ROW, THOUSANDS_ROW].join("\n"));

    // `1,230.96` and `5,00 USD alış, işlem kuru` would each need quoting
    // in CSV; as TSV they round-trip with no escaping at all.
    expect(tsv).toContain("\t921.00\t1,230.96");
    expect(tsv).toContain("5,00 USD alış, işlem kuru 46,050000 TL\t");
    expect(sniffDelimiter(tsv)).toBe("\t");
  });
});

describe("pasted QNB statement, end to end through the existing pipeline", () => {
  const pasted = [HEADER, OPENING_BALANCE, CARD_ROW, FX_ROW, "Sayfa 1 / 3", HEADER, FEE_ROW, THOUSANDS_ROW].join("\n");

  function parse() {
    const tsv = pdfTextToTsv(pasted);
    const [headers, ...records] = tokenizeCsv(tsv, undefined, sniffDelimiter(tsv));
    const adapter = detectAdapter(headers, "TRY");
    if (!adapter) throw new Error("no adapter matched");
    return { adapter, ...applyAdapter(adapter, headers, records, "TRY") };
  }

  it("picks the Turkish signed-amount adapter from the folded Turkish headers", () => {
    expect(parse().adapter.id).toBe("turkish-signed-amount");
  });

  it("parses every real transaction and rejects nothing", () => {
    const { rows, errors } = parse();

    // Four transactions: the opening balance, the page footer and the
    // repeated header are all dropped for their own separate reasons,
    // and none of them shows up as a rejected row — a clean import must
    // report a clean count or the user stops reading it.
    expect(errors).toEqual([]);
    expect(rows.map((row) => row.nativeAmount)).toEqual([-9425, 23025, -797, 92100]);
  });

  it("reads QNB's comma-thousands/dot-decimal amounts at the right magnitude", () => {
    // The 100x bug this guards: `-94.25` must be 9425 kuruş, never
    // 942500. `921.00` must be 92100, and the four-figure `1,230.96` in
    // the balance column must not leak into the amount.
    const { rows } = parse();
    expect(rows[0].nativeAmount).toBe(-9425);
    expect(rows[3].nativeAmount).toBe(92100);
  });

  it("reads DD/MM/YYYY as day-first — 01/08 is August, not January", () => {
    expect(parse().rows[0].occurredAt.toISOString().slice(0, 10)).toBe("2026-08-01");
  });

  it("keeps the FX-conversion description intact, so a Tier 0 rule can match it later", () => {
    // `Yatırım İşlemleri` is the self-conversion (USD -> TL); the
    // superficially similar `Transfer İşlemleri - Alıcı :` rows are
    // genuine outgoing payments and must NOT be caught by the same rule.
    const { rows } = parse();
    expect(rows[1].description).toContain("Yatırım İşlemleri");
    expect(rows[1].description).toContain("USD alış");
    expect(rows[2].description).toContain("Transfer İşlemleri");
    expect(rows[2].description).not.toContain("Yatırım İşlemleri");
  });
});
