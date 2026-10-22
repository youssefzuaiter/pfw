import { z } from "zod";
import { parseDecimalToNativeAmount, SUPPORTED_CURRENCIES } from "../../lib/currency";
import type { RecurringBillWrite } from "../dal/recurring-bills";

/** Largest single charge accepted: 100,000,000.00 of any currency. A typo guard, not a limit anyone should meet. */
const MAX_MINOR_UNITS = 10_000_000_000;
const EARLIEST_ANCHOR = "2000-01-01";
const MAX_YEARS_AHEAD = 5;

const BodySchema = z.object({
  name: z.string().trim().min(1, "Give the bill a name").max(80, "The name is too long"),
  // A plain decimal string such as "49.90", never signed: a bill is always a cost.
  amount: z.string().trim().min(1, "Enter an amount"),
  // Derived from the one canonical list so a new currency cannot be accepted here and rejected elsewhere.
  currency: z.enum(SUPPORTED_CURRENCIES),
  cadence: z.enum(["monthly", "quarterly", "annual"]),
  // A date the bill is or was due. Later due dates follow from it and the cadence.
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "anchorDate must be a YYYY-MM-DD date"),
  categoryId: z.string().trim().min(1).max(60).nullable().optional(),
});

export type RecurringBillBodyResult = { ok: true; data: RecurringBillWrite } | { ok: false; message: string; issues?: unknown };

/** Validates a create or edit body into what the data layer takes. Pure apart from reading the clock for the date window. */
export function parseRecurringBillBody(raw: unknown, now: Date = new Date()): RecurringBillBodyResult {
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Invalid request body", issues: parsed.error.issues };

  let amount: number;
  try {
    amount = Number(parseDecimalToNativeAmount(parsed.data.amount));
  } catch {
    return { ok: false, message: "Invalid amount" };
  }
  if (!(amount > 0)) return { ok: false, message: "The amount must be more than zero" };
  if (amount > MAX_MINOR_UNITS) return { ok: false, message: "That amount is too large" };

  const anchorDate = new Date(`${parsed.data.anchorDate}T00:00:00.000Z`);
  if (Number.isNaN(anchorDate.getTime()) || anchorDate.toISOString().slice(0, 10) !== parsed.data.anchorDate) {
    return { ok: false, message: "Invalid date" };
  }
  const latest = new Date(Date.UTC(now.getUTCFullYear() + MAX_YEARS_AHEAD, now.getUTCMonth(), now.getUTCDate()));
  if (anchorDate < new Date(`${EARLIEST_ANCHOR}T00:00:00.000Z`) || anchorDate > latest) {
    return { ok: false, message: `The date must be between ${EARLIEST_ANCHOR} and ${MAX_YEARS_AHEAD} years from now` };
  }

  return {
    ok: true,
    data: {
      name: parsed.data.name,
      nativeAmount: amount,
      currency: parsed.data.currency,
      cadence: parsed.data.cadence,
      anchorDate,
      categoryId: parsed.data.categoryId ?? null,
    },
  };
}
