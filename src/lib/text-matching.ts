/**
 * Unicode-aware word-boundary matching — the fix for the "Hebrew regex
 * boundary safety" law: JavaScript's `\b` is defined in terms of the
 * ASCII-only `\w` class (`[A-Za-z0-9_]`). Hebrew letters are not `\w`, so
 * `\b` never fires at the edge of a Hebrew word: `/\bקפה\b/` cannot match
 * "קפה" *anywhere*, even as a whole word surrounded by spaces, because
 * neither the space-to-letter nor letter-to-space transition counts as a
 * boundary when both "letter" classifications come back false. This
 * silently breaks every keyword-matching rule that touches Hebrew
 * merchant names.
 *
 * The fix: use lookaround assertions built on `\p{L}`/`\p{N}` (Unicode
 * "Letter"/"Number" categories, which DO include Hebrew) instead of `\b`.
 */

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NOT_PRECEDED_BY_WORD_CHAR = "(?<![\\p{L}\\p{N}])";
const NOT_FOLLOWED_BY_WORD_CHAR = "(?![\\p{L}\\p{N}])";

/**
 * Builds a regex matching `term` as a whole word, Unicode-aware. `flags`
 * defaults to case-insensitive; the `u` flag is always added (required
 * for `\p{...}` escapes) even if the caller forgets it.
 */
export function buildWholeWordRegex(term: string, flags = "i"): RegExp {
  const withUnicodeFlag = flags.includes("u") ? flags : `${flags}u`;
  const escaped = escapeRegExp(term);
  return new RegExp(`${NOT_PRECEDED_BY_WORD_CHAR}${escaped}${NOT_FOLLOWED_BY_WORD_CHAR}`, withUnicodeFlag);
}

/** Whether `term` appears in `haystack` as a whole word (Unicode-aware). */
export function containsWholeWord(haystack: string, term: string): boolean {
  return buildWholeWordRegex(term).test(haystack);
}

/**
 * Returns the first `term` from `terms` that appears as a whole word in
 * `haystack`, or `undefined`. Used by the Tier 2 rule matcher to find
 * which keyword rule fires for a merchant string.
 */
export function findFirstWholeWordMatch(haystack: string, terms: readonly string[]): string | undefined {
  return terms.find((term) => containsWholeWord(haystack, term));
}

/**
 * Normalizes a merchant/description string into a stable lookup key:
 * trims, collapses internal whitespace, and lowercases (case folding is a
 * no-op for Hebrew but matters for Latin-script merchant names like
 * "IKEA" vs "ikea").
 */
export function normalizeMerchantKey(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}
