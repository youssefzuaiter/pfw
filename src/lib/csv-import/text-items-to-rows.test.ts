import { describe, expect, it } from "vitest";
import { textItemsToRows, textItemsToTsv, type PositionedTextItem } from "./text-items-to-rows";

/**
 * Fixtures model the geometry of a QNB statement's text layer (§3bbb):
 * five columns at fixed x positions, one line per transaction, y
 * DEcreasing down the page (PDF's origin is bottom-left).
 */
function item(str: string, x: number, y: number, width = str.length * 5): PositionedTextItem {
  return { str, x, y, width };
}

const COL = { date: 40, channel: 120, description: 175, amount: 470, balance: 530 };

function row(y: number, date: string, channel: string, description: string, amount: string, balance: string) {
  return [
    item(date, COL.date, y),
    item(channel, COL.channel, y),
    item(description, COL.description, y),
    item(amount, COL.amount, y),
    item(balance, COL.balance, y),
  ];
}

describe("textItemsToRows", () => {
  it("rebuilds columns from horizontal gaps", () => {
    const rows = textItemsToRows(row(700, "01/08/2026", "POS", "Kart İşlemleri - BIM", "-94.25", "258.41"));
    expect(rows).toEqual([["01/08/2026", "POS", "Kart İşlemleri - BIM", "-94.25", "258.41"]]);
  });

  it("reads the page top-down — PDF's y axis points UP, so a naive ascending sort reverses the statement", () => {
    // Fed in deliberately shuffled. Getting this backwards still parses
    // and still imports; it is just silently in reverse order.
    const items = [
      ...row(660, "03/08/2026", "MB", "Third", "-3.00", "97.00"),
      ...row(700, "01/08/2026", "POS", "First", "-1.00", "99.00"),
      ...row(680, "02/08/2026", "POS", "Second", "-2.00", "98.00"),
    ];
    expect(textItemsToRows(items).map((cells) => cells[2])).toEqual(["First", "Second", "Third"]);
  });

  it("joins fragments across a NARROW gap with a space, never concatenating them", () => {
    // pdf.js splits a single visual run at font/kerning changes; without
    // the space these fuse into "Possatış".
    const rows = textItemsToRows([
      item("01/08/2026", COL.date, 700),
      item("Pos", COL.description, 700, 15),
      item("satış.", COL.description + 18, 700, 25),
      item("-94.25", COL.amount, 700),
    ]);
    expect(rows[0].filter((cell) => cell !== "")).toEqual(["01/08/2026", "Pos satış.", "-94.25"]);
  });

  it("tolerates baseline jitter within one rendered line", () => {
    const rows = textItemsToRows([
      item("01/08/2026", COL.date, 700),
      item("POS", COL.channel, 701.4),
      item("-94.25", COL.amount, 699.2),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("does not merge two genuinely adjacent lines", () => {
    const rows = textItemsToRows([...row(700, "01/08/2026", "POS", "A", "-1.00", "9.00"), ...row(688, "02/08/2026", "POS", "B", "-2.00", "7.00")]);
    expect(rows).toHaveLength(2);
  });

  it("collapses the whitespace padding a statement uses inside a cell", () => {
    const rows = textItemsToRows([item("Kart   İşlemleri     -   BIM", COL.description, 700)]);
    expect(rows[0].join("")).toBe("Kart İşlemleri - BIM");
  });

  it("ignores whitespace-only fragments and empty lines", () => {
    const rows = textItemsToRows([item("   ", COL.date, 700, 10), ...row(680, "02/08/2026", "POS", "B", "-2.00", "7.00")]);
    expect(rows).toHaveLength(1);
  });

  it("returns nothing for no items rather than throwing", () => {
    expect(textItemsToRows([])).toEqual([]);
  });

  it("puts a row with MISSING leading cells in its real columns, not shifted left", () => {
    // The bug this rule exists for, found live against a real PDF: a
    // statement's opening-balance line has no date and no amount, so by
    // index its two cells land in the DATE and description columns — a
    // dateless row carrying a number, which applyAdapter rightly refuses
    // rather than silently dropping. It came back as a rejected row.
    // Aligned to real columns it is empty date + empty amount, which is
    // exactly the "furniture" shape applyAdapter drops.
    const rows = textItemsToRows([
      ...row(700, "01/08/2026", "POS", "Kart", "-94.25", "258.41"),
      item("DEVREDEN BAKİYE", COL.description, 686),
      item("352.66", COL.balance, 686),
    ]);
    expect(rows[1]).toEqual(["", "", "DEVREDEN BAKİYE", "", "352.66"]);
  });

  it("keeps a right-aligned amount column as ONE column, not two", () => {
    // Amounts are right-aligned on a real statement, so their LEFT edges
    // differ by several characters. Clustering on left edges alone would
    // split one column in two and shift every short amount.
    const rows = textItemsToRows([
      item("01/08/2026", COL.date, 700),
      item("Short", COL.description, 700),
      item("-9.25", COL.amount + 22, 700, 28), // right-aligned: starts later
      item("02/08/2026", COL.date, 686),
      item("Longer one", COL.description, 686),
      item("-1,234.56", COL.amount, 686, 50),
    ]);
    expect(rows[0]).toHaveLength(3);
    expect(rows[0][2]).toBe("-9.25");
    expect(rows[1][2]).toBe("-1,234.56");
  });

  it("pads every row to the same width, so the table is rectangular", () => {
    const rows = textItemsToRows([
      ...row(700, "01/08/2026", "POS", "Kart", "-94.25", "258.41"),
      item("Sayfa 1 / 3", COL.description, 640),
    ]);
    expect(new Set(rows.map((cells) => cells.length)).size).toBe(1);
  });
});

describe("textItemsToTsv", () => {
  it("emits tabs, and neutralizes a tab that somehow appears inside a cell", () => {
    const tsv = textItemsToTsv([
      item("01/08/2026", COL.date, 700),
      item("a\tb", COL.description, 700),
      item("1,230.96", COL.amount, 700),
    ]);
    // Three cells, so exactly two tabs — the one inside the cell became
    // a space rather than inventing a fourth column.
    expect(tsv.split("\t")).toHaveLength(3);
    expect(tsv).toContain("a b");
    expect(tsv).toContain("1,230.96");
  });
});
