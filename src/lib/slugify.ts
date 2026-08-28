/**
 * Turns a category name into a permanent slug. Uses `\p{L}\p{N}`
 * (Unicode Letter/Number), not an ASCII `[a-z0-9]` class — the same
 * "Hebrew regex boundary safety" reasoning as src/lib/text-matching.ts
 * applies here too: an ASCII-only slugifier would strip a Hebrew name
 * like "מכולת" down to an empty string, since none of its characters are
 * `[a-z0-9]`. Unicode-aware, "מכולת" slugifies to itself; "רמי לוי"
 * becomes "רמי-לוי" — both are perfectly good permanent identifiers even
 * though they're not ASCII.
 */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  return slug || `category-${Date.now()}`;
}
