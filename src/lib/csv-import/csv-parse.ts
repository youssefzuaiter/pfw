/**
 * A small RFC 4180-shaped CSV tokenizer, written by hand rather than
 * pulled in as a dependency: bank statement CSVs are untrusted input
 * (docs/SECURITY.md §3.3), and the parsing surface is small enough that
 * owning it — with explicit, enforced limits on every dimension an
 * attacker controls — is preferable to auditing a third-party parser's
 * behavior on malformed input.
 *
 * Handles: quoted fields, embedded commas/newlines inside quotes, escaped
 * `""` quotes, CRLF and LF line endings, and a leading UTF-8 BOM (which
 * real bank exports very commonly carry — without stripping it, the first
 * header cell silently becomes "﻿Date" and no adapter matches it).
 */

/** Every limit is a hard ceiling on attacker-controlled input — see the DoS notes in docs/SECURITY.md §3.3. */
export type CsvParseLimits = {
  maxBytes: number;
  maxRows: number;
  maxFieldLength: number;
};

export const DEFAULT_CSV_LIMITS: CsvParseLimits = {
  // A year of daily transactions is a few hundred KB at most; 2 MB is
  // generous for any real personal statement while still bounding memory.
  maxBytes: 2 * 1024 * 1024,
  // Also bounds how many rows the import transaction can write in one go.
  maxRows: 5_000,
  // Long enough for a verbose bank memo line, short enough that a single
  // cell can't be used to blow up memory or the encrypted column.
  maxFieldLength: 500,
};

export type CsvParseErrorCode =
  | "file_too_large"
  | "too_many_rows"
  | "field_too_long"
  | "unterminated_quote"
  | "empty_file";

export class CsvParseError extends Error {
  constructor(
    readonly code: CsvParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CsvParseError";
  }
}

const BOM = "﻿";

function stripBom(input: string): string {
  return input.startsWith(BOM) ? input.slice(BOM.length) : input;
}

/**
 * Tokenizes CSV text into rows of raw cell strings. Performs no
 * interpretation of the content whatsoever — no header mapping, no type
 * coercion, no sanitization. Those are separate, individually testable
 * steps (see adapters.ts and formula-injection.ts); keeping them apart is
 * what lets the tokenizer be exhaustively tested against nasty quoting
 * edge cases without any bank-format concerns mixed in.
 *
 * Entirely blank lines are skipped rather than yielded as empty rows —
 * trailing newlines and blank separator lines are ubiquitous in real
 * exports and are not row-level errors.
 */
export function tokenizeCsv(input: string, limits: CsvParseLimits = DEFAULT_CSV_LIMITS): string[][] {
  const text = stripBom(input);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;

  function endField(): void {
    if (field.length > limits.maxFieldLength) {
      throw new CsvParseError(
        "field_too_long",
        `A cell exceeded the ${limits.maxFieldLength}-character limit (row ${rows.length + 1})`,
      );
    }
    row.push(field);
    field = "";
  }

  function endRow(): void {
    endField();
    const isBlankLine = row.length === 1 && row[0].trim() === "";
    if (isBlankLine) {
      row = [];
      return;
    }
    rows.push(row);
    if (rows.length > limits.maxRows) {
      throw new CsvParseError("too_many_rows", `File exceeds the ${limits.maxRows}-row limit`);
    }
    row = [];
  }

  while (index < text.length) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    // A quote only opens a quoted field at the start of a field; a stray
    // mid-field quote is treated as a literal character rather than an
    // error, which is what real-world exports tend to mean by it.
    if (char === '"' && field === "") {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      endField();
      index += 1;
      continue;
    }

    if (char === "\r") {
      if (text[index + 1] === "\n") index += 1;
      endRow();
      index += 1;
      continue;
    }

    if (char === "\n") {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (inQuotes) {
    throw new CsvParseError("unterminated_quote", "File ended inside an unterminated quoted field");
  }

  // Flush a final row that wasn't newline-terminated.
  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  if (rows.length === 0) {
    throw new CsvParseError("empty_file", "File contains no rows");
  }

  return rows;
}

/**
 * Decodes an uploaded file's bytes as UTF-8, enforcing the byte ceiling
 * *before* decoding — checking the decoded string's `.length` instead
 * would be both the wrong unit (UTF-16 code units, not bytes) and too
 * late (the allocation has already happened).
 */
export function decodeCsvBytes(bytes: Uint8Array, limits: CsvParseLimits = DEFAULT_CSV_LIMITS): string {
  if (bytes.byteLength > limits.maxBytes) {
    throw new CsvParseError(
      "file_too_large",
      `File is ${bytes.byteLength} bytes, over the ${limits.maxBytes}-byte limit`,
    );
  }
  return new TextDecoder("utf-8").decode(bytes);
}
