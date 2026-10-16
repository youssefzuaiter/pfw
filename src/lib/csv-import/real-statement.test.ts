import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { knownHeaderLabels } from "./adapters";
import { parseStatementCsv } from "./pipeline";
import { textItemsToTsv, type PositionedTextItem } from "./text-items-to-rows";
import type { CurrencyCode } from "../currency";

/**
 * A REAL statement, end to end, opt-in. A bank statement is personal data and
 * never belongs in the repo, so this reads one from a path you give it and
 * skips otherwise:
 *
 *   STATEMENT_PDF=~/Downloads/statement.pdf STATEMENT_CURRENCY=TRY \
 *   STATEMENT_EXPECTED_ROWS=<rows you counted> npx vitest run --project unit real-statement
 *
 * Passing proves 100% row extraction for that file: the running balance
 * printed by the bank continues through every parsed row, so no row was
 * dropped, split, duplicated, mis-signed or misread (see reconcile.ts for the
 * two things a running balance cannot see). STATEMENT_EXPECTED_ROWS, when
 * given, also pins the count you read off the statement yourself. Nothing
 * from the file is printed or asserted against a stored value.
 */
const file = process.env.STATEMENT_PDF?.replace(/^~(?=\/)/, process.env.HOME ?? "~");
const currency = (process.env.STATEMENT_CURRENCY ?? "TRY") as CurrencyCode;
const expectedRows = process.env.STATEMENT_EXPECTED_ROWS ? Number(process.env.STATEMENT_EXPECTED_ROWS) : null;

async function extract(path: string): Promise<PositionedTextItem[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: false });
  const doc = await task.promise;
  const items: PositionedTextItem[] = [];
  for (let page = 1; page <= doc.numPages; page += 1) {
    const content = await (await doc.getPage(page)).getTextContent();
    for (const raw of content.items as Array<{ str?: unknown; width?: unknown; transform?: unknown }>) {
      if (typeof raw.str !== "string" || !Array.isArray(raw.transform) || raw.str.trim() === "") continue;
      items.push({ str: raw.str, x: raw.transform[4] as number, y: raw.transform[5] as number, width: typeof raw.width === "number" ? raw.width : 0, page });
    }
  }
  await task.destroy();
  return items;
}

describe.skipIf(!file || !existsSync(file))("a real statement you point the test at", () => {
  it("extracts every row and reconciles to the bank's own running balance", async () => {
    const tsv = textItemsToTsv(await extract(file as string), { headerLabels: knownHeaderLabels(currency) });
    // Throws StatementReconciliationError, naming each bad line, if anything does not add up.
    const result = parseStatementCsv(new TextEncoder().encode(tsv), { expectedCurrency: currency });

    expect(result.errors).toEqual([]);
    expect(result.reconciliation.status).toBe("reconciled");
    if (result.reconciliation.status !== "reconciled") return;
    expect(result.reconciliation.checkedRows).toBe(result.rows.length);
    expect(result.reconciliation.totalMatches).not.toBe(false);
    if (expectedRows !== null) expect(result.rows).toHaveLength(expectedRows);
  });
});
