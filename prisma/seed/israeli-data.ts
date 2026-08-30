/**
 * Reference data for the deterministic mock-data generator. Mock Israeli
 * banking data — English is the primary/first label everywhere (per the
 * single-language English UI), with the original Hebrew term kept in
 * brackets alongside it (e.g. "Bank Leumi [בנק לאומי]") rather than
 * translated away entirely, since this still needs to read as real
 * Israeli banking data, not a fully-anglicized demo. The bracket suffix
 * also keeps the Hebrew-boundary-safety property (`\p{L}`/`\p{N}`
 * lookaround, see `src/lib/text-matching.ts`) exercised end-to-end: `[`
 * and `]` are non-word characters, so a Hebrew keyword inside the
 * brackets still matches as a whole word — verified directly, not just
 * assumed (see the Tier 2 rule keywords in
 * `src/lib/categorization/tier2-rules.ts`, which are left as-is and
 * still match every merchant string below).
 */

export const SEED_USER = {
  email: "demo@pfw.local",
  displayName: "PFW Demo [דמו PFW]",
};

/**
 * Two additional, genuinely distinct `User` rows (AGENTS.md §3s) —
 * real household members with their own accounts/categories/budgets,
 * not aliases of `SEED_USER`. The primary demo user (`SEED_USER`, the
 * one `getCurrentUser()` always resolves to) creates and owns the
 * seeded Household Space; these two are its other members, one with
 * WRITE standing and one READ-only, so the seeded demo shows both
 * permission levels from day one. There is no login flow to actually
 * browse the app *as* either of them — see the DAL/route code for how
 * their data is still real and independently RLS-scoped.
 */
export const HOUSEHOLD_MEMBERS = {
  spouse: { email: "dana@pfw.local", displayName: "Dana Cohen [דנה כהן]" },
  roommate: { email: "avi@pfw.local", displayName: "Avi Mizrahi [אבי מזרחי]" },
} as const;

export const BANKS = {
  hapoalim: "Bank Hapoalim [בנק הפועלים]",
  leumi: "Bank Leumi [בנק לאומי]",
  discount: "Discount Bank [בנק דיסקונט]",
  isracard: "Isracard [ישראכרט]",
} as const;

export type CategoryDef = {
  slug: string;
  name: string;
  isIncome: boolean;
};

export const CATEGORIES: CategoryDef[] = [
  { slug: "uncategorized", name: "Uncategorized [ללא קטגוריה]", isIncome: false },
  { slug: "salary", name: "Salary [משכורת]", isIncome: true },
  { slug: "groceries", name: "Groceries [מכולת]", isIncome: false },
  { slug: "transport", name: "Transport [תחבורה]", isIncome: false },
  { slug: "rent", name: "Rent [שכירות]", isIncome: false },
  { slug: "dining", name: "Dining [מסעדות]", isIncome: false },
  { slug: "entertainment", name: "Entertainment [בילויים]", isIncome: false },
  { slug: "utilities", name: "Utilities [חשבונות]", isIncome: false },
  { slug: "health", name: "Health [בריאות]", isIncome: false },
  { slug: "shopping", name: "Shopping [קניות]", isIncome: false },
];

/** Merchant names by (non-income, non-uncategorized) category slug. */
export const MERCHANTS_BY_CATEGORY: Record<string, string[]> = {
  groceries: ["Rami Levy [רמי לוי]", "Shufersal [שופרסל]", "Victory [ויקטורי]", "Mega Ba'Ir [מגה בעיר]"],
  transport: [
    "Paz [פז]",
    "Delek Motors [דלק מוטורס]",
    "Rav-Kav [רב-קו]",
    "Gett Technologies [גט טכנולוגיות]",
  ],
  dining: [
    "Cafe Cafe [קפה קפה]",
    "Aroma Espresso Bar [ארומה אספרסו בר]",
    "McDonald's [מקדונלד'ס]",
    "Wolt [וולט]",
  ],
  entertainment: ["Cinema City [סינמה סיטי]", "Netflix [נטפליקס]", "Spotify [ספוטיפיי]"],
  utilities: [
    "Israel Electric Corporation [חברת החשמל]",
    "Bezeq [בזק]",
    "Partner Communications [פרטנר תקשורת]",
  ],
  health: ["Clalit Health Services [כללית שירותי בריאות]", "Super-Pharm [סופר-פארם]"],
  shopping: ["Zara [זארה]", "IKEA [איקאה]", "AliExpress [עלי אקספרס]"],
};

export const EMPLOYER_NAME = 'Future Technologies Ltd. [טכנולוגיות עתיד בע"מ]';

export const US_EQUITY_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA"] as const;

/** Mocked USD -> ILS rate for the trading desk, in basis points terms is overkill for an FX rate — this is a plain decimal used only to seed a shekel price for a US-priced mock quote. */
export const MOCK_USD_TO_ILS_RATE = 3.7;
