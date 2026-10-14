import "server-only";
import { strToU8, zipSync } from "fflate";
import { EXCLUDED_FROM_EXPORT, EXPORT_NOTES, EXPORT_TABLES, toCsv } from "../../lib/data-export/format";
import type { UserExport } from "../dal/data-export";

/**
 * Packages a gathered export (AGENTS.md §3uuu), entirely in memory: the
 * plaintext never touches disk on the server. JSON is one document; CSV is a
 * ZIP of one file per non-empty table plus a README with the units, what was
 * left out and every table's row count.
 */

export const EXPORT_FORMAT_VERSION = 1;

export type PackagedExport = { body: Uint8Array; contentType: string; filename: string };

function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function packageJsonExport(data: UserExport, now: Date): PackagedExport {
  const document = {
    format: "pfw-export",
    version: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    notes: EXPORT_NOTES,
    excludedTables: EXCLUDED_FROM_EXPORT,
    account: data.account,
    tables: data.tables,
  };
  return {
    body: strToU8(JSON.stringify(document, null, 2)),
    contentType: "application/json; charset=utf-8",
    filename: `pfw-export-${dayOf(now)}.json`,
  };
}

export function packageCsvExport(data: UserExport, now: Date): PackagedExport {
  const files: Record<string, Uint8Array> = {
    "README.txt": strToU8(readme(data, now)),
    "account.csv": strToU8(toCsv([data.account])),
  };
  for (const name of EXPORT_TABLES) {
    const rows = data.tables[name];
    if (rows.length > 0) files[`${name}.csv`] = strToU8(toCsv(rows));
  }
  return {
    body: zipSync(files, { level: 6, mtime: now }),
    contentType: "application/zip",
    filename: `pfw-export-${dayOf(now)}.zip`,
  };
}

function readme(data: UserExport, now: Date): string {
  const lines = [
    "PFW data export",
    `Exported ${now.toISOString()} (format version ${EXPORT_FORMAT_VERSION}).`,
    "",
    "One CSV per table that has rows; account.csv is your profile. Each file is UTF-8 with a header row.",
    "",
    ...Object.values(EXPORT_NOTES).flatMap((note) => [`- ${note}`]),
    "",
    "Rows per table:",
    ...EXPORT_TABLES.map((name) => `  ${name}: ${data.tables[name].length}`),
    "",
    "Not exported:",
    ...Object.entries(EXCLUDED_FROM_EXPORT).map(([model, reason]) => `  ${model}: ${reason}`),
    "",
  ];
  return lines.join("\r\n");
}
