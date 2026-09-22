import { NextResponse, type NextRequest } from "next/server";
import { formatNativeAmount, type CurrencyCode } from "../../../../lib/currency";
import { DEFAULT_CSV_LIMITS } from "../../../../lib/csv-import/csv-parse";
import { isClientFileError, parseStatementCsv } from "../../../../lib/csv-import/pipeline";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { getBankAccountById } from "../../../../server/dal/bank-accounts";
import {
  BankAccountNotFoundError,
  ImportCurrencyMismatchError,
  importTransactions,
  NoExchangeRateError,
} from "../../../../server/dal/transaction-import";

/**
 * Statement CSV import. Unlike every other mutating route in this app,
 * the body is `multipart/form-data`, not JSON — so the Zod-validated-body
 * step is replaced by the parser pipeline's own layered validation
 * (byte ceiling → row/field ceilings → adapter detection → per-row
 * checks), which is the actual trust boundary here.
 *
 * A tighter rate limit than the default mutation guard: one request can
 * write thousands of rows, so the ceiling is per-hour rather than the
 * usual 30-per-minute.
 *
 * `dryRun=1` runs the whole pipeline and returns a preview of what WOULD
 * be written, without writing — the sign-convention/number-format check
 * a user needs before committing a statement in a layout this app has
 * never seen a real sample of (the Turkish adapters, AGENTS.md §3bbb).
 * Still goes through `guardMutation` (it's the same POST, same Origin
 * check, same rate-limit bucket) so a preview can't be used to probe
 * the parser more cheaply than an import.
 */
const IMPORT_RATE_LIMIT = { windowMs: 60 * 60_000, maxRequests: 20 };

/** How many parsed rows a dry-run preview echoes back — enough to eyeball signs and dates, not the whole file. */
const PREVIEW_ROW_LIMIT = 20;

/** Browsers send `text/csv`, but also `application/vnd.ms-excel` and, on some platforms, an empty type for a .csv file. Extension is the more reliable signal, so both are accepted rather than requiring a specific MIME. */
const ACCEPTED_MIME_TYPES = new Set([
  "text/csv",
  "text/plain",
  "application/csv",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "",
]);

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "transactions:import", IMPORT_RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonBadRequest("Request body must be multipart/form-data");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonBadRequest("Expected a 'file' field containing the statement CSV");
  }

  const bankAccountId = form.get("bankAccountId");
  if (typeof bankAccountId !== "string" || bankAccountId.trim() === "") {
    return jsonBadRequest("Expected a 'bankAccountId' field");
  }

  const adapterIdField = form.get("adapterId");
  const adapterId = typeof adapterIdField === "string" && adapterIdField !== "" ? adapterIdField : undefined;

  const dryRun = form.get("dryRun") === "1";

  if (!file.name.toLowerCase().endsWith(".csv")) {
    return jsonBadRequest("Only .csv files are supported");
  }
  if (!ACCEPTED_MIME_TYPES.has(file.type)) {
    return jsonBadRequest(`Unsupported file type: ${file.type}`);
  }
  // Checked before reading the body into memory, so an oversized upload
  // is rejected without being buffered first.
  if (file.size > DEFAULT_CSV_LIMITS.maxBytes) {
    return jsonBadRequest(
      `File is too large (${file.size} bytes); the limit is ${DEFAULT_CSV_LIMITS.maxBytes} bytes`,
    );
  }

  // The account is resolved BEFORE the file is parsed: its currency is
  // what the parser needs (amounts, encoding fallback, which adapters
  // are even eligible), and an account that isn't this user's must be a
  // 404 regardless of what the file contains — never a parse error that
  // leaks how far the request got.
  const account = await getBankAccountById(user.id, bankAccountId);
  if (!account) return jsonNotFound();
  const expectedCurrency = account.currency as CurrencyCode;

  let parsed: ReturnType<typeof parseStatementCsv>;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    parsed = parseStatementCsv(bytes, { adapterId, expectedCurrency });
  } catch (error) {
    if (isClientFileError(error)) {
      // Every client-file error carries a stable `code` (`unrecognized_format`,
      // `currency_mismatch`, the tokenizer's own codes) so the UI can react
      // to the kind of failure, not just show the message.
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    console.error("POST /api/transactions/import failed to parse", error);
    return jsonServerError();
  }

  if (parsed.rows.length === 0) {
    return jsonBadRequest(
      parsed.errors.length > 0
        ? `No importable rows: every row failed validation (first error, line ${parsed.errors[0].lineNumber}: ${parsed.errors[0].message})`
        : "No importable rows found in this file",
    );
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      adapterId: parsed.adapterId,
      adapterLabel: parsed.adapterLabel,
      currency: parsed.currency,
      totals: { count: parsed.rows.length, rejected: parsed.errors.length },
      rows: parsed.rows.slice(0, PREVIEW_ROW_LIMIT).map((row) => ({
        lineNumber: row.lineNumber,
        date: row.occurredAt.toISOString().slice(0, 10),
        description: row.description,
        merchantName: row.merchantName,
        // Pre-formatted with its own currency symbol — the preview's
        // whole job is showing "-₺1,234.56", never a bare number that
        // could be read as shekels.
        amount: formatNativeAmount(row.nativeAmount, row.currency, { showPositiveSign: true }),
        isExpense: row.nativeAmount < 0,
      })),
      rejectedRows: parsed.errors.slice(0, 10),
    });
  }

  try {
    const summary = await importTransactions(user.id, {
      bankAccountId,
      adapterId: parsed.adapterId,
      rows: parsed.rows,
    });

    if (summary.importedCount > 0) {
      await recordAuditLog(user.id, {
        entityType: "NotableTransaction",
        // No single entity id — this one audit row covers the batch.
        entityId: `import:${parsed.adapterId}:${Date.now()}`,
        action: "CREATE",
        afterData: {
          source: "csv_import",
          adapterId: parsed.adapterId,
          fileName: file.name,
          bankAccountId,
          importedCount: summary.importedCount,
          duplicateCount: summary.duplicateCount,
          rejectedCount: parsed.errors.length,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      adapterId: parsed.adapterId,
      adapterLabel: parsed.adapterLabel,
      currency: parsed.currency,
      importedCount: summary.importedCount,
      duplicateCount: summary.duplicateCount,
      // Capped: a pathological file could produce thousands of row
      // errors, and neither the response nor the UI needs all of them.
      rejectedCount: parsed.errors.length,
      rejectedRows: parsed.errors.slice(0, 10),
    });
  } catch (error) {
    if (error instanceof BankAccountNotFoundError) {
      // 404, never 403 — an account belonging to another user must be
      // indistinguishable from one that doesn't exist (Section 2.2).
      return jsonNotFound();
    }
    if (error instanceof NoExchangeRateError || error instanceof ImportCurrencyMismatchError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    console.error("POST /api/transactions/import failed", error);
    return jsonServerError();
  }
}
