import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { expect, test } from "@playwright/test";
import { E2E_EMAIL } from "./global-setup";

/**
 * Settings → Your data, in a real browser against the production build
 * (AGENTS.md §3uuu): both buttons produce a real download under the
 * server's file name, the JSON parses with the signed-in user's account and
 * decrypted rows, the ZIP opens to its CSVs, and nothing on the page trips
 * the content security policy.
 */
test("downloads the export as JSON and as a ZIP of CSVs", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/i.test(message.text())) violations.push(message.text());
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Download your data" })).toBeVisible();

  const [jsonDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download JSON" }).click()]);
  expect(jsonDownload.suggestedFilename()).toMatch(/^pfw-export-\d{4}-\d{2}-\d{2}\.json$/);
  const document = JSON.parse(readFileSync((await jsonDownload.path())!, "utf8"));
  expect(document.format).toBe("pfw-export");
  expect(document.account.email).toBe(E2E_EMAIL);
  expect(document.account).not.toHaveProperty("passwordHash");
  expect(document.tables.transactions.length).toBeGreaterThan(0);
  for (const row of document.tables.transactions) expect(row.description).not.toMatch(/^v[12]:/);

  const [csvDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV (ZIP)" }).click()]);
  expect(csvDownload.suggestedFilename()).toMatch(/^pfw-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const files = unzipSync(new Uint8Array(readFileSync((await csvDownload.path())!)));
  expect(Object.keys(files)).toEqual(expect.arrayContaining(["README.txt", "account.csv", "transactions.csv"]));
  expect(strFromU8(files["account.csv"])).toContain(E2E_EMAIL);

  expect(violations).toEqual([]);
});
