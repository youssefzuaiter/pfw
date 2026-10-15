/**
 * Split transactions (AGENTS.md §3xxx): pure rules for dividing one
 * transaction's amount across categories, with no database access.
 *
 * The transaction keeps the money. A split only says how it divides, in two
 * units that must each add up exactly: the transaction's own currency (what
 * the user typed) and ILS agorot (what every aggregate sums). For a shekel
 * row the two are the same number. For a foreign row the agorot are the
 * transaction's stored agorot divided in proportion to the typed amounts,
 * largest remainder first, so they add up to the stored figure to the
 * agorah instead of drifting by a rounding step per part.
 */

/** More parts than this is not a receipt, it's a data-entry mistake. */
export const MAX_SPLITS = 20;

/** One category's share, as stored. Signed like the transaction. */
export type SplitPart = {
  categoryId: string;
  /** ILS agorot. */
  amount: bigint;
  /** Minor units of the transaction's own currency. */
  nativeAmount: bigint;
};

/** What the user asks for: a category and an UNSIGNED amount in the transaction's currency. */
export type SplitRequest = { categoryId: string; nativeAmount: bigint };

export type SplitPlanError =
  | { error: "too_few_parts" }
  | { error: "too_many_parts" }
  | { error: "duplicate_category"; categoryId: string }
  | { error: "non_positive_part"; categoryId: string }
  | { error: "sum_mismatch"; expected: bigint; actual: bigint }
  | { error: "part_too_small"; categoryId: string };

export type SplitPlan = { ok: true; parts: SplitPart[] } | ({ ok: false } & SplitPlanError);

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Divides `total` in proportion to `weights` so the parts add up to `total`
 * exactly. Each part gets the floor of its exact share; the agorot left over
 * go one each to the parts with the largest remainders, earlier parts first
 * on a tie, so the result depends only on the inputs. Weights are
 * magnitudes; every part carries `total`'s sign.
 */
export function allocateProportionally(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new RangeError("Nothing to allocate across");
  if (weights.some((weight) => weight <= 0n)) throw new RangeError("Weights must be positive");
  const magnitude = abs(total);
  const sign = total < 0n ? -1n : 1n;
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0n);

  const shares = weights.map((weight, index) => ({
    index,
    base: (magnitude * weight) / weightSum,
    remainder: (magnitude * weight) % weightSum,
  }));
  let leftover = magnitude - shares.reduce((sum, share) => sum + share.base, 0n);
  const byRemainder = [...shares].sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const share of byRemainder) {
    if (leftover === 0n) break;
    share.base += 1n;
    leftover -= 1n;
  }
  return shares.map((share) => share.base * sign);
}

/**
 * Turns a request into stored parts for a transaction, or says why it can't.
 *
 * The amounts typed must add up to the transaction's amount in its own
 * currency EXACTLY: one agorah (or kuruş, or cent) off is refused, never
 * absorbed into a part, because a silent correction is a number the user
 * didn't enter.
 */
export function planSplits(
  transaction: { amount: bigint; nativeAmount: bigint; currency: string },
  requests: readonly SplitRequest[],
): SplitPlan {
  if (requests.length < 2) return { ok: false, error: "too_few_parts" };
  if (requests.length > MAX_SPLITS) return { ok: false, error: "too_many_parts" };

  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.categoryId)) return { ok: false, error: "duplicate_category", categoryId: request.categoryId };
    seen.add(request.categoryId);
    if (request.nativeAmount <= 0n) return { ok: false, error: "non_positive_part", categoryId: request.categoryId };
  }

  const expected = abs(transaction.nativeAmount);
  const actual = requests.reduce((sum, request) => sum + request.nativeAmount, 0n);
  if (actual !== expected) return { ok: false, error: "sum_mismatch", expected, actual };

  const nativeSign = transaction.nativeAmount < 0n ? -1n : 1n;
  const agorot =
    transaction.currency === "ILS"
      ? requests.map((request) => request.nativeAmount * nativeSign)
      : allocateProportionally(transaction.amount, requests.map((request) => request.nativeAmount));

  const parts: SplitPart[] = requests.map((request, index) => ({
    categoryId: request.categoryId,
    amount: agorot[index],
    nativeAmount: request.nativeAmount * nativeSign,
  }));
  const tooSmall = parts.find((part) => part.amount === 0n);
  if (tooSmall) return { ok: false, error: "part_too_small", categoryId: tooSmall.categoryId };
  return { ok: true, parts };
}

/**
 * The one way to read a transaction as category amounts: its splits when it
 * has them, otherwise the whole amount in its own category. Every total by
 * category goes through this, so a split row is counted once, by its parts.
 */
export function categoryParts(row: {
  categoryId: string;
  amount: bigint;
  nativeAmount: bigint;
  splits?: readonly SplitPart[] | null;
}): SplitPart[] {
  if (row.splits && row.splits.length > 0) {
    return row.splits.map((split) => ({ categoryId: split.categoryId, amount: split.amount, nativeAmount: split.nativeAmount }));
  }
  return [{ categoryId: row.categoryId, amount: row.amount, nativeAmount: row.nativeAmount }];
}

/** The part with the largest magnitude (the first on a tie): the category a split row is filed under. */
export function primaryPart(parts: readonly SplitPart[]): SplitPart {
  if (parts.length === 0) throw new RangeError("No parts");
  return parts.reduce((best, part) => (abs(part.amount) > abs(best.amount) ? part : best));
}

/**
 * How a row's category reads in a list: its own category, or for a split
 * row "Split: Groceries, Household", largest part first.
 */
export function categoryLabel(row: {
  category: { name: string };
  splits?: readonly { amount: bigint; category: { name: string } }[] | null;
}): string {
  if (!row.splits || row.splits.length === 0) return row.category.name;
  const names = [...row.splits].sort((a, b) => (abs(b.amount) > abs(a.amount) ? 1 : abs(b.amount) < abs(a.amount) ? -1 : 0)).map((split) => split.category.name);
  return `Split: ${names.join(", ")}`;
}

/** A user-facing sentence for a plan error, amounts in the transaction's currency via `format`. */
export function describeSplitError(error: SplitPlanError, format: (minorUnits: bigint) => string): string {
  switch (error.error) {
    case "too_few_parts":
      return "A split needs at least two categories.";
    case "too_many_parts":
      return `A split can have at most ${MAX_SPLITS} categories.`;
    case "duplicate_category":
      return "Each category can appear only once in a split.";
    case "non_positive_part":
      return "Every part needs an amount above zero.";
    case "sum_mismatch": {
      const difference = error.expected - error.actual;
      const direction = difference > 0n ? "short of" : "more than";
      return `The parts add up to ${format(error.actual)}, ${format(abs(difference))} ${direction} the transaction's ${format(error.expected)}.`;
    }
    case "part_too_small":
      return "One part is too small to be worth a whole agorah.";
  }
}
