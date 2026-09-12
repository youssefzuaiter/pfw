import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { PRIMARY_NAV_ITEMS } from "../../src/components/nav/nav-items";

// Every route the spec calls out ("all 9 routes" — now more, since
// Analytics/Vault were promoted to primary nav), reusing the same list
// the app's own navigation renders from rather than a second hand-typed
// copy that could drift from it.
//
// Previously ran this suite once per theme (light/dark) — the
// System/Light/Dark toggle was removed entirely (ad hoc, at explicit
// user request; see globals.css's own doc comment), so there is only
// ever one theme to check now.
const ROUTES = PRIMARY_NAV_ITEMS.map((item) => item.href);

test.describe("accessibility", () => {
  for (const route of ROUTES) {
    test(`${route} has no axe violations`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState("networkidle");

      const results = await new AxeBuilder({ page }).analyze();

      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });
  }
});

function formatViolations(violations: { id: string; help: string; nodes: { html: string }[] }[]): string {
  if (violations.length === 0) return "";
  return violations
    .map((v) => `${v.id} (${v.help}):\n${v.nodes.map((n) => `  ${n.html}`).join("\n")}`)
    .join("\n\n");
}
