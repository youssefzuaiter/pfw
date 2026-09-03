import { expect, test } from "@playwright/test";
import { PRIMARY_NAV_ITEMS } from "../../src/components/nav/nav-items";

const ROUTES = PRIMARY_NAV_ITEMS.map((item) => item.href);

// A generous safety cap, not a per-page prediction: every real browser
// moves focus to <body>/browser chrome once the tab order is exhausted
// (expected, not a bug), so this loop stops the first time that happens
// rather than trying to precompute how many focusable elements each page
// has. What *would* be a bug is landing on <body> after 0 Tab presses
// (nothing focusable at all) or landing on a non-visible element at any
// point before that.
// High enough for the most data-dense screen: /transactions renders one
// focusable category <select> per ledger row (63 seeded rows) plus its
// filter bar, well past a small fixed cap — this is real content, not a
// bug, so the cap has to accommodate it rather than the test asserting
// an arbitrary small ceiling.
const MAX_TAB_PRESSES = 500;

for (const route of ROUTES) {
  test(`${route}: repeated Tab always lands on a visible element, never gets stuck on <body>`, async ({ page }) => {
    await page.goto(route);
    await page.waitForLoadState("networkidle");

    // A real, reproducible Playwright/Chromium quirk this pass found
    // while diagnosing a wall of "had no focusable elements at all"
    // failures (§3kk) — confirmed independent of this app entirely: the
    // VERY FIRST synthetic `Tab` keypress after a fresh `page.goto()`
    // doesn't move `document.activeElement` at all (still `BODY`), even
    // on the public, auth-free `/login` page with a real, populated form
    // right there; the SECOND press moves it correctly, every time,
    // reproduced directly outside this test file too. One untracked
    // warm-up press absorbs that dropped keystroke before the real,
    // asserted loop begins, so `i === 0` genuinely means "the first
    // COUNTED press landed on body" again, matching this test's own
    // stated intent, rather than being an artifact of automation timing.
    await page.keyboard.press("Tab");

    let reachedEndOfTabOrder = false;

    for (let i = 0; i < MAX_TAB_PRESSES; i += 1) {
      await page.keyboard.press("Tab");
      const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? null);

      if (activeTag === "BODY") {
        expect(i, `${route} had no focusable elements at all`).toBeGreaterThan(0);
        reachedEndOfTabOrder = true;
        break;
      }

      const isVisible = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
      expect(isVisible, `Tab press #${i + 1} on ${route} focused a non-visible element`).toBe(true);
    }

    expect(reachedEndOfTabOrder, `${route}'s tab order didn't end within ${MAX_TAB_PRESSES} presses`).toBe(true);
  });
}

test.describe("MobileNav 'More' drawer — keyboard behavior", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("opens via keyboard, traps Tab inside, closes on Escape, and restores focus to the trigger", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const moreButton = page.getByRole("button", { name: "More" });
    await moreButton.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "More navigation" });
    await expect(dialog).toBeVisible();

    // Focus should move into the dialog when it opens, not stay behind it.
    const focusInsideDialog = await page.evaluate(() => {
      const dialogEl = document.querySelector('[role="dialog"]');
      return !!dialogEl && dialogEl.contains(document.activeElement);
    });
    expect(focusInsideDialog, "focus did not move into the drawer when it opened").toBe(true);

    // Tabbing through every focusable element in the drawer should never
    // land back on something behind it (a real focus trap, not just an
    // overlay that happens to visually cover the page).
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      const stillInsideDialog = await page.evaluate(() => {
        const dialogEl = document.querySelector('[role="dialog"]');
        return !!dialogEl && dialogEl.contains(document.activeElement);
      });
      expect(stillInsideDialog, `Tab press #${i + 1} escaped the open drawer's focus trap`).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    const restoredFocus = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-haspopup") === "dialog",
    );
    expect(restoredFocus, "focus was not restored to the 'More' trigger button after closing").toBe(true);
  });
});
