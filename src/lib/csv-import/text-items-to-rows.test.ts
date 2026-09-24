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

  it("rejoins fragments of one description, with a space, once the column is known", () => {
    // pdf.js splits a single visual run at font/kerning changes, so a
    // description arrives in pieces. From ONE line a word gap and a
    // column gutter are indistinguishable — no algorithm can tell them
    // apart — so the column has to be learned from the rows around it,
    // which is what a real statement provides.
    const items = [
      item("01/08/2026", COL.date, 700),
      item("Pos", COL.description, 700, 15),
      item("satış.", COL.description + 18, 700, 25),
      item("-94.25", COL.amount, 700),
      ...row(688, "02/08/2026", "MB", "A much longer description here", "-7.97", "285.35"),
      ...row(676, "03/08/2026", "MB", "Another long description line", "921.00", "1,230.96"),
    ];
    const rows = textItemsToRows(items);

    expect(rows[0].filter((cell) => cell !== "")).toEqual(["01/08/2026", "Pos satış.", "-94.25"]);
  });

  it("concatenates a word split mid-run, with no space inserted", () => {
    // A fragment resuming exactly where the last ended is one word the
    // PDF happened to draw in two runs — "İşlem" + "leri", never
    // "İşlem leri".
    const rows = textItemsToRows([
      item("İşlem", COL.description, 700, 25),
      item("leri", COL.description + 25, 700, 20),
    ]);
    expect(rows[0].join("")).toBe("İşlemleri");
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

describe("the header defines the columns", () => {
  /**
   * The real QNB shape, and the one page-wide geometry cannot solve: the
   * description column holds three fixed sub-fields that never overlap
   * between rows (so geometry reads three columns), while the
   * right-aligned Tutar and Bakiye values DO overlap each other's extent
   * (so geometry reads one). One needs more splitting and the other
   * less. The header says which is which.
   */
  const H = { date: 40, channel: 96, desc: 130, ref: 300, city: 420, amount: 470, balance: 520 };

  function headerRow(y: number) {
    return [
      item("İşlem Tarihi", H.date, y, 48),
      item("Kanal*", H.channel, y, 26),
      item("İşlem Açıklaması", H.desc, y, 62),
      item("Tutar", H.amount, y, 22),
      item("Bakiye", H.balance, y, 26),
    ];
  }

  function dataRow(y: number, date: string, channel: string, desc: string, ref: string, city: string, amount: string, balance: string) {
    return [
      item(date, H.date, y, 44),
      item(channel, H.channel, y, 14),
      item(desc, H.desc, y, 110),
      item(ref, H.ref, y, 90),
      item(city, H.city, y, 40),
      // Right-aligned: these two overlap each other's extent across rows,
      // which is what fused them under page-wide geometry.
      item(amount, H.amount + (40 - amount.length * 4), y, amount.length * 4),
      item(balance, H.balance + (40 - balance.length * 4), y, balance.length * 4),
    ];
  }

  /**
   * One row whose description is a single wide fragment, because a real
   * statement has them: it is what bridges the sub-field gaps and proves
   * the description is ONE column rather than three. Measured on a real
   * QNB export — a `Yatırım İşlemleri - …` line 267 units wide spanning
   * the whole description area, alongside rows split into four.
   */
  function wideDescriptionRow(y: number, date: string, amount: string, balance: string) {
    return [
      item(date, H.date, y, 44),
      item("MB", H.channel, y, 14),
      item("Yatırım İşlemleri - Mobil Bankacılık 5,00 USD alış", H.desc, y, 320),
      item(amount, H.amount + (40 - amount.length * 4), y, amount.length * 4),
      item(balance, H.balance + (40 - balance.length * 4), y, balance.length * 4),
    ];
  }

  const items = [
    ...headerRow(700),
    ...dataRow(688, "01/08/2026", "POS", "Kart İşlemleri - 1800085944", "-BIM J069 USTTARABYA", "ISTANBUL", "-94.25", "258.41"),
    ...wideDescriptionRow(676, "02/08/2026", "-1,450.00", "1,230.96"),
  ];

  const LABELS = ["İşlem Tarihi", "Kanal", "İşlem Açıklaması", "Tutar", "Bakiye"];

  it("splits Tutar from Bakiye, which page-wide geometry fuses", () => {
    const rows = textItemsToRows(items, { headerLabels: LABELS });

    expect(rows[0]).toEqual(["İşlem Tarihi", "Kanal*", "İşlem Açıklaması", "Tutar", "Bakiye"]);
    expect(rows[1][3]).toBe("-94.25");
    expect(rows[1][4]).toBe("258.41");
    expect(rows[2][3]).toBe("-1,450.00");
    expect(rows[2][4]).toBe("1,230.96");
  });

  it("joins the description's sub-fields, which page-wide geometry splits", () => {
    const rows = textItemsToRows(items, { headerLabels: LABELS });

    expect(rows[1][2]).toBe("Kart İşlemleri - 1800085944 -BIM J069 USTTARABYA ISTANBUL");
    expect(rows[1]).toHaveLength(5);
  });

  it("takes the column start from the DATA when a heading is centred over its column", () => {
    // Measured on a real QNB statement: four headings are left-aligned
    // over their column, but `İşlem Açıklaması` sits at x=232 over a
    // column whose content starts at x=96. Using the label's own left
    // edge discarded everything from 96 to 232 — the transaction type
    // and the merchant — which left 186 of 218 rows with no description
    // at all and truncated the other 32 to their tail.
    const centred = [
      item("İşlem Tarihi", 16.8, 700, 41.3),
      item("Kanal*", 65.7, 700, 23.6),
      item("İşlem Açıklaması", 232.3, 700, 60.4), // centred, not left-aligned
      item("Tutar", 458.2, 700, 18.7),
      item("Bakiye", 530.5, 700, 24),
      // Content, at the positions the real statement uses.
      item("01/08/2026", 17.5, 688, 40),
      item("POS", 69.1, 688, 16.9),
      item("Kart İşlemleri - 1800085944", 96, 688, 100.4),
      item("-BIM J069 USTTARABYA", 207.5, 688, 91.9),
      item("ISTANBUL", 312.7, 688, 39.1),
      item("TR Pos satış.", 362.9, 688, 48),
      item("-94.25", 481.3, 688, 22.7),
      item("258.41", 554.5, 688, 24.5),
      item("01/08/2026", 17.5, 676, 40),
      item("MB", 71.5, 676, 12),
      item("Yatırım İşlemleri - Mobil Bankacılık", 96, 676, 267),
      item("230.25", 479.5, 676, 24.5),
      item("488.66", 554.5, 676, 24.5),
    ];
    const rows = textItemsToRows(centred, { headerLabels: LABELS });

    expect(rows[1]).toEqual([
      "01/08/2026",
      "POS",
      "Kart İşlemleri - 1800085944 -BIM J069 USTTARABYA ISTANBUL TR Pos satış.",
      "-94.25",
      "258.41",
    ]);
  });

  it("falls back to page-wide geometry when no heading is recognized", () => {
    const rows = textItemsToRows(items, { headerLabels: ["nothing", "matches", "these"] });
    expect(rows[0][0]).toBe("İşlem Tarihi");
  });

  it("recognizes a heading the PDF split across fragments, and a footnote mark", () => {
    // "Kanal*" carries a footnote mark, and a heading can arrive as
    // several fragments rather than one.
    const split = [
      item("İşlem", H.date, 700, 22),
      item("Tarihi", H.date + 24, 700, 24),
      item("Kanal*", H.channel, 700, 26),
      item("İşlem Açıklaması", H.desc, 700, 62),
      item("Tutar", H.amount, 700, 22),
      item("Bakiye", H.balance, 700, 26),
      ...dataRow(688, "01/08/2026", "POS", "Kart İşlemleri - 1800085944", "-BIM J069", "ISTANBUL", "-94.25", "258.41"),
      ...wideDescriptionRow(676, "02/08/2026", "-1,450.00", "1,230.96"),
    ];
    const rows = textItemsToRows(split, { headerLabels: LABELS });

    expect(rows[0]).toEqual(["İşlem Tarihi", "Kanal*", "İşlem Açıklaması", "Tutar", "Bakiye"]);
    expect(rows[1][3]).toBe("-94.25");
    expect(rows[1][4]).toBe("258.41");
  });
});

describe("a column gutter narrower than the padding inside a cell", () => {
  /**
   * The real QNB shape. The gap between `İşlem Tarihi` and `Kanal*` —
   * two genuinely different columns — is 6 units, while the padding
   * INSIDE one description is 14. Any single gap threshold either fuses
   * the two columns or shreds the description; only the columns' extent
   * across many rows separates them.
   */
  const QNB = { date: 40, channel: 96, description: 130, amount: 440, balance: 478 };

  function qnbRow(y: number, date: string, channel: string, parts: string[], amount: string, balance: string) {
    const items = [item(date, QNB.date, y, 50), item(channel, QNB.channel, y, 18)];
    let x = QNB.description;
    for (const part of parts) {
      items.push(item(part, x, y, part.length * 4));
      x += part.length * 4 + 14; // wide intra-description padding
    }
    items.push(item(amount, QNB.amount, y, 32), item(balance, QNB.balance, y, 32));
    return items;
  }

  it("keeps date/channel and amount/balance apart while rejoining a split description", () => {
    const rows = textItemsToRows([
      ...qnbRow(700, "İşlem Tarihi", "Kanal*", ["İşlem Açıklaması"], "Tutar", "Bakiye"),
      ...qnbRow(688, "01/08/2026", "POS", ["Kart İşlemleri - 1800085944", "-BIM J069", "ISTANBUL"], "-94.25", "258.41"),
      ...qnbRow(676, "02/08/2026", "MB", ["Yatırım İşlemleri - Mobil", "5,00 USD alış"], "230.25", "488.66"),
      ...qnbRow(664, "03/08/2026", "MB", ["Transfer İşlemleri - EFT"], "-7.97", "285.35"),
    ]);

    // The header must come back as five separate cells, or no adapter
    // can ever match it — this is what actually failed.
    expect(rows[0]).toEqual(["İşlem Tarihi", "Kanal*", "İşlem Açıklaması", "Tutar", "Bakiye"]);

    const first = rows[1];
    expect(first[0]).toBe("01/08/2026");
    expect(first[1]).toBe("POS");
    expect(first[2]).toBe("Kart İşlemleri - 1800085944 -BIM J069 ISTANBUL");
    expect(first[3]).toBe("-94.25");
    expect(first[4]).toBe("258.41");
  });
});

describe("a description too long for one line", () => {
  /**
   * The real QNB shape: a long description renders as two lines with the
   * date, channel, amount and balance CENTRED between them. One
   * transaction therefore occupies three lines — description first half,
   * then the dated line, then the rest. Untouched, the two description
   * lines are rows with no date and the dated line is a row with no
   * description, so all three are rejected. That was 104 of 218 rows on
   * a real statement.
   */
  const LABELS = ["İşlem Tarihi", "Kanal", "İşlem Açıklaması", "Tutar", "Bakiye"];

  const header = [
    item("İşlem Tarihi", 16.8, 730, 41.3),
    item("Kanal*", 65.7, 730, 23.6),
    item("İşlem Açıklaması", 232.3, 730, 60.4),
    item("Tutar", 458.2, 730, 18.7),
    item("Bakiye", 530.5, 730, 24),
  ];

  /** An ordinary one-line transaction, so the columns are established. */
  function plainRow(y: number, date: string, amount: string) {
    return [
      item(date, 17.5, y, 40),
      item("POS", 69.1, y, 16.9),
      item("Kart İşlemleri - 1800085944", 96, y, 100.4),
      item("ISTANBUL", 312.7, y, 39.1),
      item(amount, 481.3, y, 22.7),
      item("258.41", 554.5, y, 24.5),
    ];
  }

  /** A single wide description, which is what proves the column is one and not three. */
  function wideRow(y: number, date: string, amount: string) {
    return [
      item(date, 17.5, y, 40),
      item("MB", 71.5, y, 12),
      item("Yatırım İşlemleri - Mobil Bankacılık 5,00 USD alış, işlem kuru", 96, y, 303),
      item(amount, 479.5, y, 24.5),
      item("488.66", 554.5, y, 24.5),
    ];
  }

  it("folds both halves of a wrapped description into the dated row between them", () => {
    const items = [
      ...header,
      // One transaction per ~20 units, the wrapped one's own lines ~6
      // apart — the half-row offset a centred date creates.
      ...plainRow(700, "01/08/2026", "-94.25"),
      ...wideRow(680, "01/08/2026", "230.25"),
      ...plainRow(660, "02/08/2026", "-50.00"),
      // The sandwich: description, then the dated line, then the rest.
      item("Kart İşlemleri - WEBPOS 3D SATIŞ 000000002772312-YEMEKPAY", 96, 636, 302.9),
      item("03/08/2026", 17.5, 630, 40),
      item("POS", 69.1, 630, 16.9),
      item("-294.00", 476.9, 630, 27.1),
      item("194.66", 554.5, 630, 24.5),
      item("ISTANBUL", 96, 624, 39.1),
      item("TR.", 146.2, 624, 12.9),
      ...plainRow(600, "04/08/2026", "-10.00"),
    ];
    const rows = textItemsToRows(items, { headerLabels: LABELS });

    const wrapped = rows.find((cells) => cells[0] === "03/08/2026");
    expect(wrapped?.[2]).toBe("Kart İşlemleri - WEBPOS 3D SATIŞ 000000002772312-YEMEKPAY ISTANBUL TR.");
    expect(wrapped?.[3]).toBe("-294.00");

    // The neighbouring transactions must not have absorbed any of it.
    expect(rows.find((cells) => cells[0] === "02/08/2026")?.[2]).toBe("Kart İşlemleri - 1800085944 ISTANBUL");
    expect(rows.find((cells) => cells[0] === "04/08/2026")?.[2]).toBe("Kart İşlemleri - 1800085944 ISTANBUL");
  });
});

describe("a multi-page statement that repeats its preamble", () => {
  /**
   * The shape that caused a regression: taking "every line below the
   * header" as the data describing the columns works on one page and
   * fails on six, because each page repeats a full-width preamble and
   * one such line fuses all five columns into one. The table then
   * collapsed and the header stopped being recognized at all.
   *
   * Coordinates are the ones measured on a real QNB export.
   */
  const LABELS = ["İşlem Tarihi", "Kanal", "İşlem Açıklaması", "Tutar", "Bakiye"];

  function page(pageNumber: number): PositionedTextItem[] {
    const on = (str: string, x: number, y: number, width: number) => ({ str, x, y, width, page: pageNumber });
    return [
      // Full-width preamble, repeated on every page.
      on("Iban : TR44 0011 1000 0000 0131 9725 81 Ad Soyad : YOUSEF", 17, 760, 540),
      on("Tarih Aralığı : 01/08/2026 - 31/08/2026", 17, 748, 480),
      // Header, repeated on every page.
      on("İşlem Tarihi", 16.8, 730, 41.3),
      on("Kanal*", 65.7, 730, 23.6),
      on("İşlem Açıklaması", 232.3, 730, 60.4),
      on("Tutar", 458.2, 730, 18.7),
      on("Bakiye", 530.5, 730, 24),
      // Transactions, at the real content positions.
      ...[0, 1, 2, 3].flatMap((n) => [
        on(`0${n + 1}/08/2026`, 17.5, 700 - n * 12, 40),
        on("POS", 69.1, 700 - n * 12, 16.9),
        on("Kart İşlemleri - 1800085944", 96, 700 - n * 12, 100.4),
        on("-BIM J069 USTTARABYA", 207.5, 700 - n * 12, 91.9),
        on("ISTANBUL", 312.7, 700 - n * 12, 39.1),
        on("-94.25", 481.3, 700 - n * 12, 22.7),
        on("258.41", 554.5, 700 - n * 12, 24.5),
      ]),
      // One wide description, as real statements have.
      on("05/08/2026", 17.5, 648, 40),
      on("MB", 71.5, 648, 12),
      on("Yatırım İşlemleri - Mobil Bankacılık 5,00 USD alış", 96, 648, 267),
      on("230.25", 479.5, 648, 24.5),
      on("488.66", 554.5, 648, 24.5),
    ];
  }

  it("keeps five columns across six pages of repeated preamble", () => {
    const items = [1, 2, 3, 4, 5, 6].flatMap((n) => page(n));
    const rows = textItemsToRows(items, { headerLabels: LABELS });

    const header = rows.find((cells) => cells[0] === "İşlem Tarihi");
    expect(header).toEqual(["İşlem Tarihi", "Kanal*", "İşlem Açıklaması", "Tutar", "Bakiye"]);

    const transaction = rows.find((cells) => cells[0] === "01/08/2026");
    expect(transaction?.[1]).toBe("POS");
    expect(transaction?.[2]).toBe("Kart İşlemleri - 1800085944 -BIM J069 USTTARABYA ISTANBUL");
    expect(transaction?.[3]).toBe("-94.25");
    expect(transaction?.[4]).toBe("258.41");
  });
});

describe("preamble that spans the page", () => {
  it("does not let a full-width prose line collapse the table into one column", () => {
    // The real failure, from a real QNB statement: its header block
    // ("Iban : TR44 … Ad Soyad : …") spans every column at once, so
    // merging ranges across ALL lines fused the columns together and
    // every row came back as a single cell — no adapter could match.
    const items = [
      // One long preamble run covering the whole width of the table.
      item("Iban : TR44 0011 1000 0000 0131 9725 81 Ad Soyad : YOUSEF", COL.date, 740, 520),
      ...row(700, "İşlem Tarihi", "Kanal", "İşlem Açıklaması", "Tutar", "Bakiye"),
      ...row(688, "06/08/2026", "POS", "Kart İşlemleri", "-1,450.00", "222.09"),
      ...row(676, "14/08/2026", "POS", "Kart İşlemleri", "-3,500.00", "611.65"),
    ];
    const rows = textItemsToRows(items);

    const header = rows.find((cells) => cells[0] === "İşlem Tarihi");
    expect(header).toEqual(["İşlem Tarihi", "Kanal", "İşlem Açıklaması", "Tutar", "Bakiye"]);
    expect(rows.find((cells) => cells[0] === "06/08/2026")?.[3]).toBe("-1,450.00");
  });

  it("falls back to every line when nothing looks tabular", () => {
    const rows = textItemsToRows([item("Only prose here", COL.date, 700, 300)]);
    expect(rows).toEqual([["Only prose here"]]);
  });
});

describe("multi-page statements", () => {
  it("never merges rows from different pages that share a baseline", () => {
    // The real bug, from a real 5-page QNB statement: y restarts at the
    // top of every page, so page 1's row and page 5's row sit at the same
    // baseline and grouped into one line — five dates, five channels and
    // five amounts crammed into a single row.
    const items = [
      ...row(700, "06/08/2026", "POS", "First page", "-1,450.00", "222.09").map((i) => ({ ...i, page: 1 })),
      ...row(700, "30/08/2026", "MB", "Fifth page", "-308.99", "121.46").map((i) => ({ ...i, page: 5 })),
    ];
    const rows = textItemsToRows(items);

    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toBe("06/08/2026");
    expect(rows[1][0]).toBe("30/08/2026");
  });

  it("orders pages ahead of position, so page 2 follows all of page 1", () => {
    const items = [
      ...row(200, "02/08/2026", "POS", "Page 1 bottom", "-2.00", "8.00").map((i) => ({ ...i, page: 1 })),
      ...row(700, "03/08/2026", "POS", "Page 2 top", "-3.00", "5.00").map((i) => ({ ...i, page: 2 })),
    ];
    // By y alone, page 2's top (700) would sort above page 1's bottom (200).
    expect(textItemsToRows(items).map((cells) => cells[0])).toEqual(["02/08/2026", "03/08/2026"]);
  });

  it("treats an untagged item as page 1, so single-page callers are unaffected", () => {
    const rows = textItemsToRows(row(700, "01/08/2026", "POS", "No page tag", "-1.00", "9.00"));
    expect(rows[0][0]).toBe("01/08/2026");
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
