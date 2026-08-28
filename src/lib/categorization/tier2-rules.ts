import { findFirstWholeWordMatch } from "../text-matching";
import type { CategoryRule } from "./types";

/**
 * Tier 2 — deterministic keyword rules, app-level defaults (not
 * per-user data). Rules resolve to a permanent category *slug*, not a
 * database ID — the cascade orchestrator resolves the slug to this
 * user's actual category row, matching the "permanent slugs" law
 * (renaming a category never breaks a rule keyed on its slug).
 *
 * Keyword matching goes through text-matching.ts's Unicode-aware whole-
 * word matcher, not a plain `\b` regex — see that module for why `\b`
 * silently fails on Hebrew merchant names.
 */
export const DEFAULT_CATEGORY_RULES: readonly CategoryRule[] = [
  {
    categorySlug: "groceries",
    keywords: ["רמי לוי", "שופרסל", "ויקטורי", "מגה בעיר", "מגה", "יינות ביתן"],
  },
  {
    categorySlug: "transport",
    keywords: ["פז", "דלק מוטורס", "דלק", "רב-קו", "רב קו", "גט", "gett", "uber", "אגד"],
  },
  {
    categorySlug: "dining",
    keywords: ["קפה קפה", "ארומה", "מקדונלד'ס", "מקדונלדס", "וולט", "wolt", "קפה"],
  },
  {
    categorySlug: "entertainment",
    keywords: ["סינמה סיטי", "נטפליקס", "netflix", "ספוטיפיי", "spotify", "יס", "hot"],
  },
  {
    categorySlug: "utilities",
    keywords: ["חברת החשמל", "בזק", "bezeq", "פרטנר", "partner", "סלקום", "cellcom", "הוט"],
  },
  {
    categorySlug: "health",
    keywords: ["כללית", "סופר-פארם", "סופר פארם", "מכבי", "clalit", "מאוחדת", "לאומית"],
  },
  {
    categorySlug: "shopping",
    keywords: ["זארה", "zara", "איקאה", "ikea", "עלי אקספרס", "aliexpress", "amazon", "אמזון"],
  },
  {
    categorySlug: "salary",
    keywords: ["משכורת", "salary", "payroll"],
  },
  {
    categorySlug: "rent",
    keywords: ["שכירות", "rent"],
  },
] as const;

/**
 * Returns the first rule whose keyword appears (whole word, Unicode-aware)
 * in `merchantText`, or `null`. Rule order is priority order — the first
 * matching rule wins.
 */
export function matchCategoryRule(
  merchantText: string,
  rules: readonly CategoryRule[] = DEFAULT_CATEGORY_RULES,
): { categorySlug: string; keyword: string } | null {
  for (const rule of rules) {
    const keyword = findFirstWholeWordMatch(merchantText, rule.keywords);
    if (keyword) {
      return { categorySlug: rule.categorySlug, keyword };
    }
  }
  return null;
}
