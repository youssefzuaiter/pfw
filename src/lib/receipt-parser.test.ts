import { describe, expect, it } from "vitest";
import { extractDate, extractMerchantName, parseReceiptText } from "./receipt-parser";

describe("extractMerchantName", () => {
  it("picks the first line that looks like a business name", () => {
    expect(extractMerchantName(["Cafe Aroma", "123 Main St", "05/03/2026"])).toBe("Cafe Aroma");
  });

  it("skips a leading date-looking line", () => {
    expect(extractMerchantName(["05/03/2026", "Cafe Aroma", "Receipt #4821"])).toBe("Cafe Aroma");
  });

  it("skips a leading phone-number-looking line", () => {
    expect(extractMerchantName(["+972 3 123 4567", "Cafe Aroma"])).toBe("Cafe Aroma");
  });

  it("skips a leading pure-numeric line", () => {
    expect(extractMerchantName(["8829104721", "Cafe Aroma"])).toBe("Cafe Aroma");
  });

  it("returns null when nothing in the first 5 lines looks like a name", () => {
    expect(extractMerchantName(["05/03/2026", "123456", "+972-3-1234567", "99.90", "1"])).toBeNull();
  });

  it("returns null for an empty line list", () => {
    expect(extractMerchantName([])).toBeNull();
  });

  it("recognizes a Hebrew-bracketed merchant name", () => {
    expect(extractMerchantName(['קפה ארומה [Cafe Aroma]', "05/03/2026"])).toBe("קפה ארומה [Cafe Aroma]");
  });
});

describe("extractDate", () => {
  it("parses an ISO date", () => {
    const date = extractDate("Receipt date: 2026-03-05\nTotal: 45.90");
    expect(date?.toISOString().slice(0, 10)).toBe("2026-03-05");
  });

  it("parses a day-first numeric date by default (DD/MM/YYYY)", () => {
    const date = extractDate("05/03/2026");
    expect(date?.getUTCMonth()).toBe(2); // March
    expect(date?.getUTCDate()).toBe(5);
  });

  it("flips to month-first when the second number can't be a month (>12)", () => {
    const date = extractDate("03/25/2026"); // unambiguous US-style MM/DD
    expect(date?.getUTCMonth()).toBe(2); // March
    expect(date?.getUTCDate()).toBe(25);
  });

  it("resolves an unambiguous day-first date even when the first number is >12", () => {
    const date = extractDate("25/03/2026");
    expect(date?.getUTCMonth()).toBe(2);
    expect(date?.getUTCDate()).toBe(25);
  });

  it("parses a 2-digit year as 20xx", () => {
    const date = extractDate("05/03/26");
    expect(date?.getUTCFullYear()).toBe(2026);
  });

  it("parses a month-name date (Mon D, YYYY)", () => {
    const date = extractDate("Mar 5, 2026");
    expect(date?.getUTCFullYear()).toBe(2026);
    expect(date?.getUTCMonth()).toBe(2);
    expect(date?.getUTCDate()).toBe(5);
  });

  it("parses a month-name date (D Month YYYY)", () => {
    const date = extractDate("5 March 2026");
    expect(date?.getUTCMonth()).toBe(2);
    expect(date?.getUTCDate()).toBe(5);
  });

  it("rejects an impossible calendar date rather than silently rolling over", () => {
    // Day 32 is invalid in any interpretation.
    expect(extractDate("32/13/2026")).toBeNull();
  });

  it("returns null when no date-shaped text is present", () => {
    expect(extractDate("Thank you for shopping with us")).toBeNull();
  });
});

describe("parseReceiptText", () => {
  it("extracts merchant, date, and total from a realistic simple receipt", () => {
    const raw = `Cafe Aroma
    123 Main St, Tel Aviv
    05/03/2026

    Cappuccino          14.90
    Croissant           12.00

    Subtotal            26.90
    Total               26.90
    `;
    const result = parseReceiptText(raw);
    expect(result.merchantName).toBe("Cafe Aroma");
    expect(result.occurredAt?.toISOString().slice(0, 10)).toBe("2026-03-05");
    expect(result.totalAgorot).toBe(2690);
  });

  it("prefers the 'total' line over 'subtotal' even when subtotal appears first", () => {
    const raw = `Grocery Store
    Subtotal   100.00
    Total      108.00
    `;
    expect(parseReceiptText(raw).totalAgorot).toBe(10_800);
  });

  it("does not mistake 'Taxi' for a tax line (whole-word matching, not substring)", () => {
    const raw = `Airport Taxi Co
    Fare   45.00
    Total  45.00
    `;
    expect(parseReceiptText(raw).taxAgorot).toBeNull();
  });

  it("extracts a labeled tax amount", () => {
    const raw = `Electronics Store
    Item          199.00
    Tax           33.83
    Total         232.83
    `;
    const result = parseReceiptText(raw);
    expect(result.taxAgorot).toBe(3383);
    expect(result.totalAgorot).toBe(23_283);
  });

  it("recognizes a Hebrew VAT label", () => {
    const raw = `Store\nItem 100.00\nמע"מ 17.00\nTotal 117.00`;
    expect(parseReceiptText(raw).taxAgorot).toBe(1700);
  });

  it("falls back to the largest amount when no 'total' keyword line exists", () => {
    const raw = `Farmers Market
    Apples    12.50
    Bread     18.00
    `;
    expect(parseReceiptText(raw).totalAgorot).toBe(1800);
  });

  it("returns null totalAgorot when there is no parseable amount anywhere", () => {
    const raw = `Handwritten Note\nThanks for coming by`;
    expect(parseReceiptText(raw).totalAgorot).toBeNull();
  });

  it("extracts plausible line items, excluding the total/subtotal/tax lines", () => {
    const raw = `Cafe Aroma
    Cappuccino    14.90
    Croissant     12.00
    Subtotal      26.90
    Tax            4.57
    Total         31.47
    `;
    const items = parseReceiptText(raw).lineItems;
    const descriptions = items.map((i) => i.description);
    expect(descriptions).toContain("Cappuccino");
    expect(descriptions).toContain("Croissant");
    expect(descriptions).not.toContain(expect.stringContaining("Total"));
    expect(items.find((i) => i.description === "Cappuccino")?.amountAgorot).toBe(1490);
  });

  it("handles noisy OCR output with irregular whitespace and stray characters", () => {
    const raw = `  Cafe   Aroma  \n\n\n   05 / 03 / 2026   \n  Total :   26.90  \n\n`;
    const result = parseReceiptText(raw);
    expect(result.merchantName).toBe("Cafe   Aroma");
    expect(result.totalAgorot).toBe(2690);
  });

  it("handles a receipt with no discernible date gracefully", () => {
    const raw = `Corner Store\nGum   5.00\nTotal 5.00`;
    const result = parseReceiptText(raw);
    expect(result.occurredAt).toBeNull();
    expect(result.totalAgorot).toBe(500);
  });

  it("handles completely empty input without throwing", () => {
    const result = parseReceiptText("");
    expect(result).toEqual({
      merchantName: null,
      occurredAt: null,
      totalAgorot: null,
      taxAgorot: null,
      lineItems: [],
    });
  });

  it("ignores a malformed number the currency regex over-matched by skipping it, not throwing", () => {
    // A pathological line that shouldn't crash the parser even if it produces
    // an edge-case regex match.
    const raw = `Store\n999999999999999999999999.00 Total\nTotal 10.00`;
    expect(() => parseReceiptText(raw)).not.toThrow();
  });
});
