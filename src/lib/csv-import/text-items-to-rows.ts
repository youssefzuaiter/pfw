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

/** One positioned run of text, the shape pdf.js's `getTextContent()` yields per item. */
export type PositionedTextItem = {
  str: string;
  /** Left edge, in PDF user-space units (1/72 inch). */
  x: number;
  /** Baseline. Larger is HIGHER on the page — PDF's y axis points up. */
  y: number;
  /** Advance width of this run, so `x + width` is its right edge. */
  width: number;
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

  const byReadingOrder = [...withText].sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: PositionedTextItem[][] = [];
  let current: PositionedTextItem[] = [byReadingOrder[0]];
  let currentY = byReadingOrder[0].y;

  for (const item of byReadingOrder.slice(1)) {
    if (Math.abs(item.y - currentY) <= toleranceY) {
      current.push(item);
      continue;
    }
    lines.push(current);
    current = [item];
    currentY = item.y;
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

/**
 * One cell, still carrying where it sits horizontally.
 *
 * The x range is what a column is actually made of — see
 * `detectColumnBands`.
 */
type PositionedCell = { text: string; left: number; right: number };

/**
 * Finds the page's columns as the horizontal bands its text actually
 * occupies, by merging every cell's [left, right] range across every
 * line and treating each surviving gap as a gutter.
 *
 * This is what makes a row with MISSING leading cells line up instead of
 * shifting left. A statement's opening-balance line ("DEVREDEN BAKİYE …
 * 352.66") has no date and no amount, so by index its two cells land in
 * the date and description columns — a dateless row carrying a number,
 * which `applyAdapter` rightly refuses rather than silently dropping.
 * Verified live against a real PDF before this existed: that line came
 * back as a rejected row.
 *
 * Bands rather than each column's left edge, because an amount column is
 * right-aligned: `-94.25` and `1,230.96` start at different x but share
 * one band, so clustering on left edges alone would split one column in
 * two.
 */
function detectColumnBands(lines: readonly PositionedCell[][]): Array<{ left: number; right: number }> {
  const ranges = lines.flat().map(({ left, right }) => ({ left, right }));
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.left - b.left);
  const bands: Array<{ left: number; right: number }> = [{ ...sorted[0] }];

  for (const range of sorted.slice(1)) {
    const current = bands[bands.length - 1];
    if (range.left <= current.right) {
      // Overlaps the band being built, so it is the same column.
      current.right = Math.max(current.right, range.right);
      continue;
    }
    bands.push({ ...range });
  }

  return bands;
}

/** The band a cell belongs to: the one containing its midpoint, else the nearest. */
function bandIndexFor(cell: PositionedCell, bands: ReadonlyArray<{ left: number; right: number }>): number {
  const midpoint = (cell.left + cell.right) / 2;
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

/**
 * The reconstructed table: one array per visual line, in reading order,
 * every row the same width, each cell in its real column.
 */
export function textItemsToRows(
  items: readonly PositionedTextItem[],
  options: TextItemsToRowsOptions = {},
): string[][] {
  const toleranceY = options.lineToleranceY ?? DEFAULT_LINE_TOLERANCE_Y;
  const columnGapX = options.columnGapX ?? DEFAULT_COLUMN_GAP_X;

  const lines = groupIntoLines(items, toleranceY).map((line) => lineToCells(line, columnGapX));
  const bands = detectColumnBands(lines);
  if (bands.length === 0) return [];

  return lines
    .map((line) => {
      const row = new Array<string>(bands.length).fill("");
      for (const cell of line) {
        const index = bandIndexFor(cell, bands);
        // Two cells in one band is unusual (a column whose text ran
        // together); keep both rather than dropping one silently.
        row[index] = row[index] === "" ? cell.text : `${row[index]} ${cell.text}`;
      }
      return row;
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
export function textItemsToTsv(items: readonly PositionedTextItem[], options: TextItemsToRowsOptions = {}): string {
  return textItemsToRows(items, options)
    .map((row) => row.map((cell) => cell.replace(/\t/g, " ")).join("\t"))
    .join("\n");
}
