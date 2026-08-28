/** Reference data for the deterministic mock-data generator. Hebrew names throughout — this is mock Israeli banking data, not a translated demo. */

export const SEED_USER = {
  email: "demo@pfw.local",
  displayName: "דמו PFW",
};

export const BANKS = {
  hapoalim: "בנק הפועלים",
  leumi: "בנק לאומי",
  discount: "בנק דיסקונט",
  isracard: "ישראכרט",
} as const;

export type CategoryDef = {
  slug: string;
  name: string;
  isIncome: boolean;
};

export const CATEGORIES: CategoryDef[] = [
  { slug: "uncategorized", name: "ללא קטגוריה", isIncome: false },
  { slug: "salary", name: "משכורת", isIncome: true },
  { slug: "groceries", name: "מכולת", isIncome: false },
  { slug: "transport", name: "תחבורה", isIncome: false },
  { slug: "rent", name: "שכירות", isIncome: false },
  { slug: "dining", name: "מסעדות", isIncome: false },
  { slug: "entertainment", name: "בילויים", isIncome: false },
  { slug: "utilities", name: "חשבונות", isIncome: false },
  { slug: "health", name: "בריאות", isIncome: false },
  { slug: "shopping", name: "קניות", isIncome: false },
];

/** Merchant names by (non-income, non-uncategorized) category slug. */
export const MERCHANTS_BY_CATEGORY: Record<string, string[]> = {
  groceries: ["רמי לוי", "שופרסל", "ויקטורי", "מגה בעיר"],
  transport: ["פז", "דלק מוטורס", "רב-קו", "גט טכנולוגיות"],
  dining: ["קפה קפה", "ארומה אספרסו בר", "מקדונלד'ס", "וולט"],
  entertainment: ["סינמה סיטי", "נטפליקס", "ספוטיפיי"],
  utilities: ["חברת החשמל", "בזק", "פרטנר תקשורת"],
  health: ["כללית שירותי בריאות", "סופר-פארם"],
  shopping: ["זארה", "איקאה", "עלי אקספרס"],
};

export const EMPLOYER_NAME = "טכנולוגיות עתיד בע\"מ";

export const US_EQUITY_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA"] as const;

/** Mocked USD -> ILS rate for the trading desk, in basis points terms is overkill for an FX rate — this is a plain decimal used only to seed a shekel price for a US-priced mock quote. */
export const MOCK_USD_TO_ILS_RATE = 3.7;
