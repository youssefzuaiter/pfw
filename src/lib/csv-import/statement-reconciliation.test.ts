import { describe, expect, it } from "vitest";
import { knownHeaderLabels } from "./adapters";
import { parseStatementCsv, StatementReconciliationError } from "./pipeline";
import { textItemsToTsv, type PositionedTextItem } from "./text-items-to-rows";

/**
 * A QNB "Hesap Hareketleri" PDF, end to end: text fragments as pdf.js hands
 * them over -> the geometry reconstruction -> the parser -> the balance
 * check. Every coordinate is one measured on a real statement (the masked
 * layout dump, `scripts/inspect-statement-pdf.ts`); every name and figure is
 * made up (no amount, balance, name or reference from a real statement). The
 * real statement this layout comes from reconciled on every row.
 *
 * The traps it reproduces, each of which broke a real import once (§3bbb):
 *   - a preamble (title, account lines) above the table, whose prose spans columns;
 *   - an opening-balance line with a balance but no date and no amount;
 *   - a description that wraps to two lines with the date line BETWEEN them;
 *   - right-aligned Amount and Balance columns side by side, and a heading
 *     centred over the description column rather than left-aligned;
 *   - the table continuing on a second page with no header, y restarting;
 *   - a page footer, including one drawn in a font whose glyphs come out Greek.
 */

const HEADINGS: readonly [string, number, number][] = [
  ["İşlem Tarihi", 16.8, 41.3],
  ["Kanal*", 65.7, 23.6],
  ["İşlem Açıklaması", 232.3, 60.4],
  ["Tutar", 458.2, 18.7],
  ["Bakiye", 530.5, 24.0],
];
const DATE_X = 17.5;
const DESCRIPTION_X = 96;
const AMOUNT_RIGHT = 504;
const BALANCE_RIGHT = 579;

type Movement = { date: string; channel: string; lines: string[]; amount: string; balance: string };

function text(str: string, x: number, y: number, page: number, width = str.length * 4.4): PositionedTextItem {
  return { str, x, y, width, page };
}

function rightAligned(str: string, right: number, y: number, page: number): PositionedTextItem {
  const width = str.length * 5;
  return text(str, right - width, y, page, width);
}

function movementItems(movement: Movement, y: number, page: number): PositionedTextItem[] {
  const out = [
    text(movement.date, DATE_X, y, page, 40),
    text(movement.channel, 69, y, page, movement.channel.length * 5),
    rightAligned(movement.amount, AMOUNT_RIGHT, y, page),
    rightAligned(movement.balance, BALANCE_RIGHT, y, page),
  ];
  if (movement.lines.length === 1) {
    out.push(text(movement.lines[0], DESCRIPTION_X, y, page));
  } else {
    // A wrapped description: first half 4.6 above the date line, second 4.6 below.
    out.push(text(movement.lines[0], DESCRIPTION_X, y + 4.6, page), text(movement.lines[1], DESCRIPTION_X, y - 4.6, page));
  }
  return out;
}

function pageItems(page: number, movements: readonly Movement[], options: { preamble: boolean; openingBalance?: string; lastPage: boolean }) {
  const items: PositionedTextItem[] = [];
  let y = 760;
  if (options.preamble) {
    items.push(text("Hesap Hareketleri", 20, 770, page), text("16/10/2026", 556, 770, page, 40));
    items.push(text("Iban", 20, 752, page), text(":", 125, 752, page, 3), text("TR00 0000 0000 0000 0000 0000 00", 135, 752, page));
    items.push(text("Ad Soyad", 418, 752, page), text(":", 512, 752, page, 3), text("TEST USER", 528, 752, page));
    items.push(text("Hesap Adı", 20, 738, page), text(":", 125, 738, page, 3), text("TL Vadesiz Hesap", 135, 738, page));
    items.push(text("Tarih Aralığı", 20, 712, page), text(":", 125, 712, page, 3), text("16/07/2026 - 16/10/2026", 135, 712, page));
    for (const [heading, x, width] of HEADINGS) items.push(text(heading, x, 684, page, width));
    y = 672;
    if (options.openingBalance) {
      items.push(text("DEVREDEN BAKİYE", 353.5, y, page, 75.5), rightAligned(options.openingBalance, BALANCE_RIGHT, y, page));
      y -= 11.4;
    }
  }
  for (const movement of movements) {
    if (movement.lines.length === 2) y -= 4.6;
    items.push(...movementItems(movement, y, page));
    y -= movement.lines.length === 2 ? 15.5 : 11;
  }
  items.push(text(`Sayfa: ${page}/2`, 560, 90, page, 45));
  if (options.lastPage) items.push(text("Bu doküman bilgi amaçlı hazırlanmıştır.", 20, 130, page, 380), text("Θ", 8, 70, page, 6));
  return items;
}

const PAGE_ONE: Movement[] = [
  { date: "16/07/2026", channel: "FEFT", lines: ["Transfer İşlemleri - Gönderen: AAA BBB CCC DDD", "EEE FFF Sorgu No: 1111111 - Trans"], amount: "12,000.00", balance: "12,250.00" },
  { date: "16/07/2026", channel: "POS", lines: ["Kart İşlemleri - 1111111 -SHOP ONE ISTANBUL TR Pos satış."], amount: "-640.00", balance: "11,610.00" },
  { date: "16/07/2026", channel: "MB", lines: ["Yatırım İşlemleri - Mobil Bankacılık 200,00 USD alış, işlem kuru 24,000000 TL"], amount: "4,800.00", balance: "16,410.00" },
  { date: "16/07/2026", channel: "MB", lines: ["Transfer İşlemleri - Alıcı : GGG HHH Example Bank A.Ş. Sorgu No:", "2222222 MOBIL"], amount: "-16,500.00", balance: "-90.00" },
  { date: "16/07/2026", channel: "MB", lines: ["Transfer İşlemleri - EFT Ücreti"], amount: "-12.50", balance: "-102.50" },
  { date: "17/07/2026", channel: "POS", lines: ["Kart İşlemleri - WEBPOS SATIŞ 3333-FOOD ISTANBULAVR", "TR."], amount: "-30.00", balance: "-132.50" },
  { date: "17/07/2026", channel: "POS", lines: ["Kart İşlemleri - WEBPOS SATIŞ 3333-FOOD ISTANBULAVR", "TR."], amount: "-30.00", balance: "-162.50" },
];
const PAGE_TWO: Movement[] = [
  { date: "18/07/2026", channel: "POS", lines: ["Kart İşlemleri - WEBPOS SATIŞ 4444-RIDE ISTANBUL", "TR."], amount: "-1.00", balance: "-163.50" },
  { date: "18/07/2026", channel: "POS", lines: ["Kart İşlemleri - WEBPOS SATIŞ 4444-RIDE ISTANBUL", "TR. İptali"], amount: "1.00", balance: "-162.50" },
  { date: "19/07/2026", channel: "ATM", lines: ["Mevduat İşlemleri - ATM'den para çekme"], amount: "-400.00", balance: "-562.50" },
  { date: "20/07/2026", channel: "MB", lines: ["Yatırım İşlemleri - Mobil Bankacılık 100,00 USD alış, işlem kuru 24,000000 TL"], amount: "2,400.00", balance: "1,837.50" },
];
const OPENING = "250.00";
const ALL = [...PAGE_ONE, ...PAGE_TWO];

function statementItems(pageOne = PAGE_ONE, pageTwo = PAGE_TWO): PositionedTextItem[] {
  return [
    ...pageItems(1, pageOne, { preamble: true, openingBalance: OPENING, lastPage: false }),
    ...pageItems(2, pageTwo, { preamble: false, lastPage: true }),
  ];
}

function parseItems(items: PositionedTextItem[]) {
  const tsv = textItemsToTsv(items, { headerLabels: knownHeaderLabels("TRY") });
  return parseStatementCsv(new TextEncoder().encode(tsv), { expectedCurrency: "TRY" });
}

function minorUnits(amount: string): number {
  return Math.round(Number(amount.replace(/,/g, "")) * 100);
}

describe("a QNB PDF statement, end to end with the balance check", () => {
  it("does not fold a page footer into the last row of the page", () => {
    const tsv = textItemsToTsv(statementItems(), { headerLabels: knownHeaderLabels("TRY") });
    expect(tsv).not.toMatch(/-162\.50\s+Sayfa/);
  });
  it("extracts every row, exactly, in order, and reconciles to the bank's balance", () => {
    const result = parseItems(statementItems());

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(ALL.length);
    expect(result.rows.map((row) => row.nativeAmount)).toEqual(ALL.map((m) => minorUnits(m.amount)));
    expect(result.rows.map((row) => row.printedBalance)).toEqual(ALL.map((m) => minorUnits(m.balance)));
    expect(result.rows.map((row) => row.occurredAt.toISOString().slice(0, 10))).toEqual(
      ALL.map((m) => m.date.split("/").reverse().join("-")),
    );
    expect(result.reconciliation).toMatchObject({
      status: "reconciled",
      order: "oldest-first",
      checkedRows: ALL.length,
      openingBalance: minorUnits(OPENING),
      closingBalance: minorUnits(ALL[ALL.length - 1].balance),
      totalMatches: true,
    });
  });

  it("keeps a wrapped description whole, in reading order, in one row", () => {
    const [transfer] = parseItems(statementItems()).rows;
    expect(transfer.description).toBe("Transfer İşlemleri - Gönderen: AAA BBB CCC DDD EEE FFF Sorgu No: 1111111 - Trans");
  });

  it("does not import the preamble, the opening line, the footers or the page number as rows", () => {
    const descriptions = parseItems(statementItems()).rows.map((row) => row.description).join(" ");
    for (const furniture of ["Hesap Hareketleri", "Iban", "DEVREDEN", "Sayfa", "bilgi amaçlı", "Θ"]) {
      expect(descriptions).not.toContain(furniture);
    }
  });

  it("refuses the statement, naming the line, when a row is lost", () => {
    // The 6th movement's whole text is gone, as when a row falls out of the reconstruction.
    const lost = PAGE_ONE.filter((_, index) => index !== 5);
    let caught: unknown;
    try {
      parseItems(statementItems(lost));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StatementReconciliationError);
    const report = (caught as StatementReconciliationError).report;
    expect(report.mismatches).toHaveLength(1);
    // The row after the gap is off by exactly the missing amount.
    expect(report.mismatches[0].difference).toBe(minorUnits(PAGE_ONE[5].amount));
    expect((caught as Error).message).toMatch(/line \d+: previous balance -10250 \+ amount -3000 = -13250, but the statement prints -16250 \(off by -3000\)/);
  });

  it("refuses a misread amount", () => {
    const misread = PAGE_ONE.map((m, index) => (index === 1 ? { ...m, amount: "-6.40" } : m));
    expect(() => parseItems(statementItems(misread))).toThrow(StatementReconciliationError);
  });

  it("refuses a flipped sign and says so", () => {
    const flipped = PAGE_TWO.map((m, index) => (index === 2 ? { ...m, amount: "400.00" } : m));
    try {
      parseItems(statementItems(PAGE_ONE, flipped));
      expect.unreachable();
    } catch (error) {
      expect((error as StatementReconciliationError).report.mismatches[0].hint).toBe("the amount's sign looks inverted");
    }
  });

  it("refuses when the top of the next page is missing", () => {
    const pageTwoWithoutItsFirstThree = PAGE_TWO.slice(3);
    expect(() => parseItems(statementItems(PAGE_ONE, pageTwoWithoutItsFirstThree))).toThrow(StatementReconciliationError);
  });

  /**
   * What a running balance cannot prove, pinned so nobody reads more into the
   * check than it gives: rows whose amounts cancel out leave the chain intact,
   * and so does losing the END of a statement, because a balance only checks
   * the rows after it and nothing comes after the last one. The reader takes
   * every page of the file it is given, so the second needs a truncated file.
   */
  it("cannot see rows that net to zero, or a missing tail (stated limits)", () => {
    const withoutReversalPair = PAGE_TWO.filter((m) => !m.lines.join(" ").includes("4444-RIDE"));
    expect(parseItems(statementItems(PAGE_ONE, withoutReversalPair)).reconciliation.status).toBe("reconciled");
    expect(parseItems(statementItems(PAGE_ONE, PAGE_TWO.slice(0, 2))).reconciliation.status).toBe("reconciled");
  });

  it("refuses a statement whose opening balance does not lead to its first row", () => {
    const items = statementItems().map((i) => (i.str === OPENING ? { ...i, str: "100.00" } : i));
    expect(() => parseItems(items)).toThrow(StatementReconciliationError);
  });
});
