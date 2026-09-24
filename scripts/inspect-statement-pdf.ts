/**
 * Prints where a statement PDF's text actually sits, so a layout that
 * will not import can be diagnosed from real coordinates instead of
 * guesses.
 *
 * Exists because the reconstruction in `src/lib/csv-import/text-items-to-rows.ts`
 * is pure geometry, and its failures (a column boundary in the wrong
 * place, a heading printed away from its column's content) are invisible
 * in the rendered output — several rounds of fixes were aimed at the
 * wrong cause before this existed.
 *
 * Values are MASKED: column headings print in full because they are the
 * thing being matched, but every data fragment keeps only its first few
 * characters, with letters and digits replaced after that. The geometry
 * is what diagnoses a layout, never the contents, so this can be shared
 * without sharing a statement.
 *
 *   npx tsx --conditions=react-server scripts/inspect-statement-pdf.ts <file.pdf>
 */
import { readFileSync } from "node:fs";
import { knownHeaderLabels } from "../src/lib/csv-import/adapters";
import { textItemsToRows, type PositionedTextItem } from "../src/lib/csv-import/text-items-to-rows";

const KEEP_CHARS = 4;
const DATA_LINES_TO_SHOW = 6;

function mask(text: string): string {
  const head = text.slice(0, KEEP_CHARS);
  const rest = text
    .slice(KEEP_CHARS)
    .replace(/\p{N}/gu, "#")
    .replace(/\p{L}/gu, "·");
  return head + rest;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: inspect-statement-pdf.ts <file.pdf>");

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: false });
  const doc = await task.promise;

  const items: PositionedTextItem[] = [];
  for (let page = 1; page <= doc.numPages; page += 1) {
    const content = await (await doc.getPage(page)).getTextContent();
    for (const raw of content.items as Array<{ str?: unknown; width?: unknown; transform?: unknown }>) {
      if (typeof raw.str !== "string" || !Array.isArray(raw.transform)) continue;
      if (raw.str.trim() === "") continue;
      items.push({
        str: raw.str,
        x: raw.transform[4] as number,
        y: raw.transform[5] as number,
        width: typeof raw.width === "number" ? raw.width : 0,
        page,
      });
    }
  }
  await task.destroy();

  const currency = (process.argv[3] ?? "TRY") as Parameters<typeof knownHeaderLabels>[0];
  const labels = knownHeaderLabels(currency);
  console.log(`pages=${doc.numPages} fragments=${items.length} currency=${currency}`);
  console.log(`known headings: ${labels.join(", ")}\n`);

  // Regroup exactly as the reconstruction does, so what prints is what it sees.
  const byLine = new Map<string, PositionedTextItem[]>();
  for (const item of items) {
    const key = `${item.page}:${Math.round(item.y / 4)}`;
    byLine.set(key, [...(byLine.get(key) ?? []), item]);
  }
  const lines = [...byLine.values()]
    .map((line) => [...line].sort((a, b) => a.x - b.x))
    .sort((a, b) => (a[0].page ?? 1) - (b[0].page ?? 1) || b[0].y - a[0].y);

  const normalized = new Set(labels.map((l) => l.toLowerCase()));
  const headerIndex = lines.findIndex(
    (line) => line.filter((i) => normalized.has(i.str.trim().toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").trim())).length >= 2,
  );

  if (headerIndex === -1) {
    console.log("No heading row found. First 8 lines, masked:");
    for (const line of lines.slice(0, 8)) {
      console.log("  " + line.map((i) => `[x=${i.x.toFixed(0)} w=${i.width.toFixed(0)}] ${mask(i.str)}`).join("  "));
    }
  } else {
    console.log(`HEADING ROW (line ${headerIndex + 1}) — printed in full, these are column names:`);
    for (const i of lines[headerIndex]) {
      console.log(`  x=${i.x.toFixed(1).padStart(7)} w=${i.width.toFixed(1).padStart(6)}  ${JSON.stringify(i.str)}`);
    }
    console.log(`\nNEXT ${DATA_LINES_TO_SHOW} LINES — values masked, positions exact:`);
    let previousY: number | null = null;
    for (const line of lines.slice(headerIndex + 1, headerIndex + 1 + DATA_LINES_TO_SHOW)) {
      const y = line[0].y;
      // The vertical gap matters: a description that wraps puts its
      // second line a fraction of a row below, while a new transaction
      // is a full row down. Telling those apart needs the numbers.
      const gap = previousY === null ? "" : `  (${(previousY - y).toFixed(1)} below previous)`;
      previousY = y;
      console.log(`  --- y=${y.toFixed(1)}${gap}`);
      for (const i of line) {
        console.log(`  x=${i.x.toFixed(1).padStart(7)} w=${i.width.toFixed(1).padStart(6)}  ${mask(i.str)}`);
      }
    }
  }

  console.log(`\nWhat the importer currently builds (first 4 rows, masked):`);
  for (const row of textItemsToRows(items, { headerLabels: labels }).slice(0, 4)) {
    console.log("  " + row.map((c) => (c === "" ? "∅" : mask(c))).join("  |  "));
  }
}

void main();
