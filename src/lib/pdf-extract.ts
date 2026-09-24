/**
 * Reads a PDF's text layer in the BROWSER and hands back the positioned
 * fragments `text-items-to-rows.ts` reconstructs a table from
 * (AGENTS.md §3bbb).
 *
 * Client-only, and the PDF never leaves the device — same posture as the
 * receipt OCR (§3q), the local embedder (§3u) and the cash-flow
 * forecaster (§3dd). What eventually reaches the server is the extracted
 * table, which is the same data a CSV upload would carry; the file
 * itself, with whatever else it contains (letterhead, account numbers,
 * addresses), stays local.
 *
 * Enforced client-only by `tests/guards/pdf-extract-client-only.test.ts`,
 * the same import-graph guard every other browser-only module here has,
 * rather than a `typeof window` branch — what matters is which files may
 * import it, not which runtime it happens to execute in.
 *
 * pdf.js itself is loaded with a dynamic `import()` so its ~500KB never
 * reaches anyone who doesn't open a PDF, and the worker is served from
 * this app's own origin so `script-src`/`worker-src` stay `'self'`.
 */

import type { PositionedTextItem } from "./csv-import/text-items-to-rows";

/**
 * The `legacy` build, not the default one. The default build calls
 * `hashOriginal.toHex()`, which is not available in every environment
 * this app is tested in — verified by it throwing outright on Node 24
 * during development. `legacy` targets a wider baseline and behaves
 * identically for text extraction.
 */
const PDFJS_MODULE = "pdfjs-dist/legacy/build/pdf.mjs";

/** Self-hosted: see the CSP note above. Must match what `public/pdfjs/` actually contains. */
const WORKER_SRC = "/pdfjs/pdf.worker.min.mjs";

/** A pdf.js text item, narrowed to what this module needs. `TextMarkedContent` entries carry no `transform` and are skipped. */
type RawTextItem = { str?: unknown; width?: unknown; transform?: unknown };

function toPositionedItem(raw: RawTextItem): PositionedTextItem | null {
  const transform = raw.transform;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  if (typeof raw.str !== "string") return null;

  // pdf.js gives a full 2D transform matrix [a, b, c, d, e, f]; e and f
  // are the translation, i.e. this run's origin on the page.
  const x = transform[4];
  const y = transform[5];
  if (typeof x !== "number" || typeof y !== "number") return null;

  return { str: raw.str, x, y, width: typeof raw.width === "number" ? raw.width : 0 };
}

export class PdfExtractionError extends Error {
  readonly code = "pdf_extraction_failed";
  constructor(message: string) {
    super(message);
    this.name = "PdfExtractionError";
  }
}

/**
 * Every page's text fragments, concatenated in page order.
 *
 * Pages are deliberately NOT separated by a marker: each page of a
 * statement repeats the same column layout, and the row reconstruction
 * groups by y WITHIN a page's items before the next page's are appended,
 * so page 2's rows follow page 1's in reading order. A repeated per-page
 * header simply becomes another row, which the adapter's own header
 * matching and the "no date and no amount" rule already handle.
 */
export async function extractPdfTextItems(file: File): Promise<PositionedTextItem[]> {
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    pdfjs = (await import(/* webpackIgnore: false */ PDFJS_MODULE)) as typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (error) {
    throw new PdfExtractionError(`Could not load the PDF reader: ${error instanceof Error ? error.message : String(error)}`);
  }

  pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;

  const data = new Uint8Array(await file.arrayBuffer());

  // The loading TASK is what owns the worker and must be destroyed —
  // the document proxy has no destroy() of its own.
  const task = pdfjs.getDocument({ data, useSystemFonts: false });

  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy();
    throw new PdfExtractionError(
      `This file could not be read as a PDF: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const items: PositionedTextItem[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const raw of content.items as RawTextItem[]) {
        const positioned = toPositionedItem(raw);
        if (positioned) items.push(positioned);
      }
      // Frees the page's own resources as we go; a year-long statement
      // is many pages and there is no reason to hold them all.
      page.cleanup();
    }

    if (items.length === 0) {
      throw new PdfExtractionError(
        "This PDF has no selectable text — it looks like a scan. Export the statement again as text, or use the CSV option.",
      );
    }

    return items;
  } finally {
    await task.destroy();
  }
}
