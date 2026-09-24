/**
 * Rebuilds a table from the positioned text fragments a PDF's text layer
 * is actually made of (AGENTS.md §3bbb).
 *
 * A PDF has no rows, no columns and no tabs — only runs of glyphs, each
 * placed at an (x, y). What looks like a table is a visual coincidence of
 * alignment. Reconstructing it means two decisions, both made here:
 *
 *  1. **Which fragments are on the same line** — grouped by `y`, with a
 *     tolerance, because a line's fragments are rarely at a pixel
 *     -identical baseline.
 *  2. **Where the column breaks are** — inferred from horizontal gaps: a
 *     wide gap between the end of one fragment and the start of the next
 *     is a column boundary; a narrow one is just a space inside a cell.
 *
 * Deliberately pure, over a plain `{ str, x, y, width }` shape rather
 * than pdf.js's own types: pdf.js is browser-only IO, and keeping the
 * judgement calls in a function that takes plain objects is what makes
 * every rule below testable with no PDF, no worker and no binary fixture
 * — the same engine/IO split every `src/lib/` module follows (§3b), and
 * the thing that was missing when this was first attempted.
 */

import { normalizeHeader } from "./adapters";

/** One positioned run of text, the shape pdf.js's `getTextContent()` yields per item. */
export type PositionedTextItem = {
  str: string;
  /** Left edge, in PDF user-space units (1/72 inch). */
  x: number;
  /** Baseline. Larger is HIGHER on the page — PDF's y axis points up. */
  y: number;
  /** Advance width of this run, so `x + width` is its right edge. */
  width: number;
  /**
   * 1-based page this run came from; defaults to page 1.
   *
   * Load-bearing, not bookkeeping: y restarts at the top of every page,
   * so a row on page 1 and a row on page 5 share a baseline. Grouping by
   * y alone merges them into one line — found against a real 5-page QNB
   * statement, which came back with five dates, five channels and five
   * amounts crammed into a single row.
   */
  page?: number;
};

export type TextItemsToRowsOptions = {
  /**
   * Fragments whose baselines differ by less than this are the same
   * line. Roughly half a line of 10pt text: large enough to absorb the
   * sub-point baseline jitter within one rendered line, small enough not
   * to merge two adjacent lines of a dense statement.
   */
  lineToleranceY?: number;
  /**
   * A horizontal gap at least this wide is a column break rather than a
   * space. About four spaces at 10pt. Inter-word gaps in justified text
   * stay well under it; the whitespace padding a statement uses between
   * columns is far wider.
   */
  columnGapX?: number;
  /**
   * Every column heading the target layouts could use, normalized
   * (`knownHeaderLabels` in `adapters.ts`).
   *
   * When supplied and matched, the HEADER defines the columns — which is
   * the only thing that can, for a real statement. Found against a real
   * QNB export: its description column holds three fixed sub-fields
   * (merchant reference, merchant name, city) that never overlap between
   * rows, so page-wide geometry reads them as three columns; meanwhile
   * its right-aligned `Tutar` and `Bakiye` values DO overlap each
   * other's extent and read as one. One needs more splitting and the
   * other less, which no single whole-page rule can deliver. The header
   * says plainly that `İşlem Açıklaması` is one column and `Tutar` and
   * `Bakiye` are two.
   *
   * Matched against the RAW fragments rather than gap-merged cells,
   * because merging is what fuses `Tutar` and `Bakiye` in the first
   * place — recognizing the header from the merged form is circular and
   * simply never fires.
   */
  headerLabels?: readonly string[];
};

const DEFAULT_LINE_TOLERANCE_Y = 4;
const DEFAULT_COLUMN_GAP_X = 8;

/**
 * Groups fragments into visual lines, top of page first.
 *
 * Sorting by `-y` rather than `y` because PDF's origin is the BOTTOM-left
 * corner: a larger y is further UP the page, so reading order is
 * descending y. Getting this backwards yields a statement in perfect
 * reverse order — which still parses, still imports, and is silently
 * wrong, so it is worth being explicit about.
 */
function groupIntoLines(items: readonly PositionedTextItem[], toleranceY: number): PositionedTextItem[][] {
  const withText = items.filter((item) => item.str.trim() !== "");
  if (withText.length === 0) return [];

  // Page first, then DOWN the page, then left to right.
  const byReadingOrder = [...withText].sort(
    (a, b) => (a.page ?? 1) - (b.page ?? 1) || b.y - a.y || a.x - b.x,
  );

  const lines: PositionedTextItem[][] = [];
  let current: PositionedTextItem[] = [byReadingOrder[0]];
  let currentY = byReadingOrder[0].y;
  let currentPage = byReadingOrder[0].page ?? 1;

  for (const item of byReadingOrder.slice(1)) {
    const page = item.page ?? 1;
    // A page break always starts a new line, however close the baselines
    // are — page 5's first row sits at the same y as page 1's.
    if (page === currentPage && Math.abs(item.y - currentY) <= toleranceY) {
      current.push(item);
      continue;
    }
    lines.push(current);
    current = [item];
    currentY = item.y;
    currentPage = page;
  }
  lines.push(current);

  // Within a line, left to right.
  return lines.map((line) => [...line].sort((a, b) => a.x - b.x));
}

/**
 * Merges a line's fragments into cells, splitting wherever the gap to the
 * next fragment is wide enough to be a column break.
 *
 * Fragments joined across a narrow gap get a single space between them
 * rather than being concatenated, because pdf.js routinely splits a
 * single visual word run at font or kerning changes; concatenating would
 * fuse `Pos` and `satış` into `Possatış`.
 */
function lineToCells(line: readonly PositionedTextItem[], columnGapX: number): PositionedCell[] {
  const cells: PositionedCell[] = [];
  let buffer = line[0].str;
  let left = line[0].x;
  let rightEdge = line[0].x + line[0].width;

  for (const item of line.slice(1)) {
    const gap = item.x - rightEdge;
    if (gap >= columnGapX) {
      cells.push({ text: buffer, left, right: rightEdge });
      buffer = item.str;
      left = item.x;
    } else {
      buffer = `${buffer} ${item.str}`;
    }
    rightEdge = item.x + item.width;
  }
  cells.push({ text: buffer, left, right: rightEdge });

  // Collapse the runs of whitespace a PDF's own intra-cell padding leaves
  // behind, so a description is one clean string rather than a ragged one.
  return cells
    .map((cell) => ({ ...cell, text: cell.text.replace(/\s+/g, " ").trim() }))
    .filter((cell) => cell.text !== "");
}

/** A cell, still carrying where it sits horizontally. */
type PositionedCell = { text: string; left: number; right: number };

/** A line needs at least this many cells before it can be evidence of where the columns are. */
const MIN_CELLS_FOR_BAND_EVIDENCE = 3;

/**
 * Picks the lines that are actually table rows, so the page's prose
 * cannot define its columns.
 *
 * A real statement opens with full-width preamble — `Iban : TR44 0011
 * 1000 … Ad Soyad : …` — whose text spans every column at once. Letting
 * it into the band merge fuses all the columns into one, and then every
 * row of the file comes back as a single cell, so no adapter can ever
 * match the header. A real QNB statement did exactly that.
 *
 * Chosen by the MODE of the cell count, not the maximum: a statement has
 * far more transaction rows than anything else, while the maximum could
 * be some unusually-split preamble line and would then be the only
 * "evidence" there is.
 */
function selectTabularLines<T extends { length: number }>(lines: readonly T[]): readonly T[] {
  const candidates = lines.filter((line) => line.length >= MIN_CELLS_FOR_BAND_EVIDENCE);
  if (candidates.length === 0) return lines;

  const frequency = new Map<number, number>();
  for (const line of candidates) {
    frequency.set(line.length, (frequency.get(line.length) ?? 0) + 1);
  }

  let modeCount = 0;
  let modeFrequency = 0;
  for (const [count, seen] of frequency) {
    // Ties go to the wider shape — a row with more columns resolved is
    // the better description of the table.
    if (seen > modeFrequency || (seen === modeFrequency && count > modeCount)) {
      modeCount = count;
      modeFrequency = seen;
    }
  }

  return candidates.filter((line) => line.length === modeCount);
}

/**
 * Finds the page's columns as the horizontal bands its text occupies.
 *
 * Reads the RAW fragments, never the gap-merged cells, and that
 * distinction is the whole point. In a real QNB statement the gap
 * between `İşlem Tarihi` and `Kanal*` — two genuinely different columns
 * — is NARROWER than the padding inside a single description cell, so no
 * one gap threshold can split the columns without also shredding the
 * descriptions. Merging cells first and deriving bands from the result
 * produced exactly that: `İşlem Tarihi Kanal*` and `Tutar Bakiye` fused
 * into single columns while the description broke into three.
 *
 * The raw fragments still carry the real boundary, because a column's
 * identity comes from its horizontal extent across MANY rows rather than
 * from any one row's spacing: descriptions of differing lengths overlap
 * each other into one continuous band, while the date column's fragments
 * never reach the channel column's.
 *
 * Bands rather than each column's left edge, because an amount column is
 * right-aligned: `-94.25` and `1,230.96` start at different x but share
 * one band, so clustering on left edges alone would split one column in
 * two.
 */
/**
 * A horizontal position counts as part of a column only if at least this
 * share of lines has text there.
 *
 * Simply merging every line's ranges does not work on a real statement:
 * a 6-page QNB export repeats a full-width preamble on every page, and
 * one such line spans all five columns and fuses them into one. Those
 * lines are a minority (about 36 of 218), so requiring a quarter of
 * lines to agree drops them while keeping every genuine column — the
 * date appears on roughly half the lines, the description on nearly all.
 *
 * Deliberately a share rather than a fixed count, so that a two-line
 * fixture behaves exactly as a plain merge would (the threshold floors
 * at one) while a real multi-page statement gets the filtering.
 */
const MIN_LINE_SHARE_FOR_COLUMN = 0.25;

/**
 * The bands of x that enough lines agree are occupied.
 *
 * Counts LINES, not fragments, so one line with many fragments in a
 * region cannot vote for it repeatedly.
 */
function occupiedBands(
  lines: readonly (readonly PositionedTextItem[])[],
): Array<{ left: number; right: number }> {
  if (lines.length === 0) return [];

  const coverage = new Map<number, number>();
  for (const line of lines) {
    const covered = new Set<number>();
    for (const item of line) {
      for (let x = Math.floor(item.x); x <= Math.ceil(item.x + item.width); x += 1) covered.add(x);
    }
    for (const x of covered) coverage.set(x, (coverage.get(x) ?? 0) + 1);
  }

  const threshold = Math.max(1, Math.ceil(lines.length * MIN_LINE_SHARE_FOR_COLUMN));
  const occupied = [...coverage.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([x]) => x)
    .sort((a, b) => a - b);
  if (occupied.length === 0) return [];

  const bands: Array<{ left: number; right: number }> = [{ left: occupied[0], right: occupied[0] }];
  for (const x of occupied.slice(1)) {
    const current = bands[bands.length - 1];
    if (x <= current.right + 1) {
      current.right = x;
      continue;
    }
    bands.push({ left: x, right: x });
  }

  return bands;
}

/** Merges overlapping horizontal ranges into the bands of text they form. */
function mergeRanges(
  ranges: ReadonlyArray<{ left: number; right: number }>,
): Array<{ left: number; right: number }> {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.left - b.left);
  const merged: Array<{ left: number; right: number }> = [{ ...sorted[0] }];

  for (const range of sorted.slice(1)) {
    const current = merged[merged.length - 1];
    if (range.left <= current.right) {
      current.right = Math.max(current.right, range.right);
      continue;
    }
    merged.push({ ...range });
  }

  return merged;
}

function detectColumnBands(
  itemLines: readonly (readonly PositionedTextItem[])[],
  cellLines: readonly PositionedCell[][],
): Array<{ left: number; right: number }> {
  // Prose is excluded by looking at the MERGED cells (that is what makes
  // a line look tabular or not), but the bands themselves come from the
  // raw fragments of those same lines.
  const tabular = new Set(selectTabularLines(cellLines).map((line) => cellLines.indexOf(line)));
  const evidence = itemLines.filter((_, index) => tabular.has(index));
  const source = evidence.length > 0 ? evidence : itemLines;

  return mergeRanges(source.flat().map((item) => ({ left: item.x, right: item.x + item.width })));
}

/** The band an item belongs to: the one containing its midpoint, else the nearest. */
function bandIndexFor(
  item: PositionedTextItem,
  bands: ReadonlyArray<{ left: number; right: number }>,
): number {
  const midpoint = item.x + item.width / 2;
  const containing = bands.findIndex((band) => midpoint >= band.left && midpoint <= band.right);
  if (containing !== -1) return containing;

  let nearest = 0;
  let bestDistance = Infinity;
  bands.forEach((band, index) => {
    const distance = midpoint < band.left ? band.left - midpoint : midpoint - band.right;
    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = index;
    }
  });
  return nearest;
}

/** How many consecutive fragments may be joined while looking for one heading. */
const MAX_FRAGMENTS_PER_LABEL = 3;

/** Trailing footnote marks and punctuation are not part of a heading — a real statement writes `Kanal*`. */
function normalizeLabel(text: string): string {
  return normalizeHeader(text)
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Segments one line's fragments into the headings it contains, and
 * returns where each heading starts.
 *
 * A PDF's fragments do not correspond to cells, so a heading can arrive
 * as one fragment or several ("İşlem" + "Tarihi"); consecutive
 * fragments are therefore joined up to `MAX_FRAGMENTS_PER_LABEL` while
 * looking for a match.
 */
function findHeadingStarts(
  line: readonly PositionedTextItem[],
  labels: ReadonlySet<string>,
): number[] {
  const starts: number[] = [];

  for (let index = 0; index < line.length; ) {
    let matchedSpan = 0;

    for (let span = 1; span <= MAX_FRAGMENTS_PER_LABEL && index + span <= line.length; span += 1) {
      const text = normalizeLabel(
        line
          .slice(index, index + span)
          .map((item) => item.str)
          .join(" "),
      );
      if (text !== "" && labels.has(text)) matchedSpan = span;
    }

    if (matchedSpan > 0) {
      starts.push(line[index].x);
      index += matchedSpan;
      continue;
    }
    index += 1;
  }

  return starts;
}

/** A line needs this many recognized headings before it is treated as the table's header. */
const MIN_HEADINGS_FOR_HEADER = 3;

/**
 * Column boundaries: the headings say how MANY columns there are and
 * roughly where, the data says where each one actually begins and ends.
 *
 * Both halves are necessary, and each alone is wrong. Measured on a real
 * QNB statement: its headings sit at x = 16.8, 65.7, 232.3, 458.2 and
 * 530.5, while the matching content sits at 17.5, 69.1, **96.0**, 476.9
 * and 554.5. Four of the five headings are left-aligned over their
 * column, but `İşlem Açıklaması` is CENTRED over a column spanning
 * 96–411 — so taking the label's own left edge as the column start
 * discards everything from 96 to 232, which is the transaction type and
 * the merchant. That is what left 186 of 218 rows with no description at
 * all and truncated the rest to their tail.
 *
 * Geometry alone is no better: page-wide bands cannot tell whether the
 * description's several sub-fields are one column or four, and the
 * heading is the only thing that answers that.
 *
 * So each heading is matched to the band of data beneath it, and the
 * boundary is put in the gutter between one column's content and the
 * next's.
 */
function bandsFromHeadings(
  headingStarts: readonly number[],
  dataBands: ReadonlyArray<{ left: number; right: number }>,
): Array<{ left: number; right: number }> {
  const sorted = [...headingStarts].sort((a, b) => a - b);

  /** Column starts taken from the labels alone — correct only for a left-aligned heading, but never collapsed. */
  const fromLabels = () =>
    sorted.map((start, index) => ({
      left: index === 0 ? Number.NEGATIVE_INFINITY : start,
      right: sorted[index + 1] ?? Number.POSITIVE_INFINITY,
    }));

  if (dataBands.length < sorted.length) return fromLabels();

  // The band each heading sits over — containing it, else the nearest.
  const owned = sorted.map((start) => {
    const containing = dataBands.findIndex((band) => start >= band.left && start <= band.right);
    if (containing !== -1) return dataBands[containing];

    let nearest = dataBands[0];
    let best = Infinity;
    for (const band of dataBands) {
      const distance = start < band.left ? band.left - start : start - band.right;
      if (distance < best) {
        best = distance;
        nearest = band;
      }
    }
    return nearest;
  });

  // Two headings landing on one band means the bands do not describe
  // this table — most often because a full-width line was counted as
  // data and fused everything. Falling back keeps the columns the
  // labels give rather than collapsing the table into one.
  const distinct = new Set(owned.map((band) => `${band.left}:${band.right}`));
  if (distinct.size < sorted.length) return fromLabels();

  return owned.map((band, index) => {
    const next = owned[index + 1];
    return {
      left: index === 0 ? Number.NEGATIVE_INFINITY : (owned[index - 1].right + band.left) / 2,
      right: next ? (band.right + next.left) / 2 : Number.POSITIVE_INFINITY,
    };
  });
}

/** A line occupying fewer than this many columns may be a fragment of the row it sits beside. */
const MIN_COLUMNS_FOR_OWN_ROW = 2;
/** How far a wrapped cell may spill past its column and still count as belonging to it. */
const FRAGMENT_FIT_TOLERANCE = 4;

/**
 * Folds a wrapped cell's overflow lines back into the row they belong
 * to.
 *
 * A long description does not fit one line, and a real QNB statement
 * renders the overflow as its OWN line while centring the date and
 * amount between them — so one transaction occupies three lines: the
 * first half of its description, then the date/channel/amount/balance,
 * then the rest of the description. Left alone, the two description
 * lines are rows with no date (rejected) and the middle line is a row
 * with no description (also rejected). That was 104 of 218 rows.
 *
 * A fragment is recognized structurally, by occupying a single column
 * while a real row spans several — no knowledge of which column holds
 * the date is needed, so this stays true for any layout. Each fragment
 * joins the VERTICALLY NEAREST real row on its own page, which is what
 * makes the sandwich work: a description's second line is nearer the row
 * it belongs to than to the next transaction, in both directions.
 */
function foldFragmentsIntoRows(
  itemLines: readonly (readonly PositionedTextItem[])[],
  bands: ReadonlyArray<{ left: number; right: number }>,
): PositionedTextItem[][] {
  // The page's real horizontal extent, used to close the outer bands,
  // which are open-ended so that content outside the headings still
  // lands somewhere.
  const allItems = itemLines.flat();
  const contentLeft = Math.min(...allItems.map((item) => item.x));
  const contentRight = Math.max(...allItems.map((item) => item.x + item.width));

  const isRow = itemLines.map((line) => {
    if (line.length === 0) return false;

    const used = new Set(line.map((item) => bandIndexFor(item, bands)));
    if (used.size >= MIN_COLUMNS_FOR_OWN_ROW) return true;

    // One column is not enough on its own: a full-width preamble line
    // ("Iban : TR44 … Ad Soyad : …") is a single fragment whose midpoint
    // falls in one band, and folding THAT into a transaction would
    // corrupt it. A genuine wrapped cell also FITS inside its column.
    const band = bands[[...used][0]];
    const left = Math.max(band.left, contentLeft);
    const right = Math.min(band.right, contentRight);
    const lineLeft = Math.min(...line.map((item) => item.x));
    const lineRight = Math.max(...line.map((item) => item.x + item.width));

    return lineLeft < left - FRAGMENT_FIT_TOLERANCE || lineRight > right + FRAGMENT_FIT_TOLERANCE;
  });
  if (!isRow.some(Boolean)) return itemLines.map((line) => [...line]);

  const rows = itemLines.map((line) => [...line]);

  itemLines.forEach((line, index) => {
    if (isRow[index] || line.length === 0) return;

    let nearest = -1;
    let bestDistance = Infinity;
    itemLines.forEach((candidate, candidateIndex) => {
      if (!isRow[candidateIndex] || candidate.length === 0) return;
      if ((candidate[0].page ?? 1) !== (line[0].page ?? 1)) return;
      const distance = Math.abs(candidate[0].y - line[0].y);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = candidateIndex;
      }
    });

    if (nearest !== -1) rows[nearest].push(...line);
  });

  // Reading order within the merged row: down the page, then across, so
  // a description's first line precedes its second.
  return rows
    .filter((_, index) => isRow[index])
    .map((line) => [...line].sort((a, b) => b.y - a.y || a.x - b.x));
}

/**
 * The reconstructed table: one array per visual line, in reading order,
 * every row the same width, each fragment in its real column.
 */
export function textItemsToRows(
  items: readonly PositionedTextItem[],
  options: TextItemsToRowsOptions = {},
): string[][] {
  const toleranceY = options.lineToleranceY ?? DEFAULT_LINE_TOLERANCE_Y;
  const columnGapX = options.columnGapX ?? DEFAULT_COLUMN_GAP_X;

  const itemLines = groupIntoLines(items, toleranceY);
  const cellLines = itemLines.map((line) => lineToCells(line, columnGapX));

  // The header defines the columns when it can be recognized; page-wide
  // geometry is the fallback for a file with no recognizable header.
  let headerBands: Array<{ left: number; right: number }> | null = null;
  if (options.headerLabels && options.headerLabels.length > 0) {
    const labels = new Set(options.headerLabels.map(normalizeLabel));
    for (const [index, line] of itemLines.entries()) {
      const starts = findHeadingStarts(line, labels);
      if (starts.length >= MIN_HEADINGS_FOR_HEADER) {
        // Only the TABULAR lines below the header describe the columns.
        // "Below the header" alone is not enough: a 6-page statement
        // repeats its full-width preamble on every page, and one such
        // line fuses every column into one — which collapsed the whole
        // table and put this back to not recognizing the header at all.
        headerBands = bandsFromHeadings(starts, occupiedBands(itemLines.slice(index + 1)));
        break;
      }
    }
  }

  const bands = headerBands ?? detectColumnBands(itemLines, cellLines);
  if (bands.length === 0) return [];

  return foldFragmentsIntoRows(itemLines, bands)
    .map((line) => {
      const row = new Array<string>(bands.length).fill("");
      let previousBand = -1;
      let previousRight = 0;
      let previousY = Number.NaN;

      for (const item of line) {
        const index = bandIndexFor(item, bands);
        if (row[index] === "") {
          row[index] = item.str;
        } else {
          // Within one column, a fragment that resumes right where the
          // last one ended is the same word split at a font or kerning
          // change ("İşlem" + "leri"); anything further along had a real
          // space between them. Must be the same LINE too — a folded-in
          // continuation is a different line and always needs the space.
          const touching = index === previousBand && item.y === previousY && item.x - previousRight < 1;
          row[index] = touching ? `${row[index]}${item.str}` : `${row[index]} ${item.str}`;
        }
        previousBand = index;
        previousRight = item.x + item.width;
        previousY = item.y;
      }

      return row.map((cell) => cell.replace(/\s+/g, " ").trim());
    })
    .filter((row) => row.some((cell) => cell !== ""));
}

/**
 * The same table as TSV, which is what the import pipeline consumes.
 *
 * Tabs rather than commas because a bank statement is full of commas that
 * are not delimiters — `1,230.96` in an amount column, `5,00 USD alış,
 * işlem kuru` inside a description — so TSV round-trips with no quoting
 * at all and `sniffDelimiter` detects it from the first line. Any tab a
 * cell somehow contains is replaced with a space first, so a stray one
 * can never invent a column that wasn't there.
 */
export function textItemsToTsv(
  items: readonly PositionedTextItem[],
  options: TextItemsToRowsOptions = {},
): string {
  return textItemsToRows(items, options)
    .map((row) => row.map((cell) => cell.replace(/\t/g, " ")).join("\t"))
    .join("\n");
}
