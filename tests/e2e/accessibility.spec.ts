import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { PRIMARY_NAV_ITEMS } from "../../src/components/nav/nav-items";

type Theme = "light" | "dark";
const THEMES: readonly Theme[] = ["light", "dark"];

// Matches theme-toggle.tsx's STORAGE_KEY/values exactly — setting this
// before navigation is the same mechanism a real user's earlier toggle
// click leaves behind, read by the blocking theme-init-script.tsx before
// first paint (so there's no flash-of-wrong-theme to race against here).
async function setTheme(page: Page, theme: Theme) {
  await page.addInitScript((value) => {
    window.localStorage.setItem("pfw-theme", value);
  }, theme);
}

// Every route the spec calls out ("all 9 routes"), reusing the same list
// the app's own navigation renders from rather than a second hand-typed
// copy that could drift from it.
const ROUTES = PRIMARY_NAV_ITEMS.map((item) => item.href);

for (const theme of THEMES) {
  test.describe(`accessibility — ${theme} theme`, () => {
    for (const route of ROUTES) {
      test(`${route} has no axe violations`, async ({ page }) => {
        await setTheme(page, theme);
        await page.goto(route);
        await page.waitForLoadState("networkidle");

        const results = await new AxeBuilder({ page }).analyze();

        expect(results.violations, formatViolations(results.violations)).toEqual([]);
      });
    }
  });
}

function formatViolations(violations: { id: string; help: string; nodes: { html: string }[] }[]): string {
  if (violations.length === 0) return "";
  return violations
    .map((v) => `${v.id} (${v.help}):\n${v.nodes.map((n) => `  ${n.html}`).join("\n")}`)
    .join("\n\n");
}
