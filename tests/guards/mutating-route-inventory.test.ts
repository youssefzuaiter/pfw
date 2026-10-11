import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { EXCLUDED_ROUTES, ORIGIN_CHECK_EXEMPT, SWEPT_ROUTES } from "../routes/mutating-route-registry";

/**
 * A new mutating route (POST, PUT, PATCH, DELETE) must be given a decision:
 * swept by the route test, or excluded with a reason. This guard reads every
 * route file, so a route cannot ship silently untested.
 */
const APP_DIR = join(process.cwd(), "src/app");
const HANDLER = /export async function (POST|PUT|PATCH|DELETE)\b/g;

function discoverMutatingRoutes(): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        visit(full);
        continue;
      }
      if (entry !== "route.ts") continue;
      const routePath = "/" + relative(APP_DIR, dirname(full)).split(sep).join("/");
      for (const match of readFileSync(full, "utf8").matchAll(HANDLER)) {
        found.push(`${match[1]} ${routePath}`);
      }
    }
  };
  visit(join(APP_DIR, "api"));
  return found.sort();
}

describe("mutating route inventory", () => {
  const discovered = discoverMutatingRoutes();

  it("finds the mutating routes it is meant to find", () => {
    expect(discovered.length).toBeGreaterThan(70);
  });

  it("gives every mutating route exactly one decision: swept, or excluded with a reason", () => {
    const decided = [...SWEPT_ROUTES, ...Object.keys(EXCLUDED_ROUTES)].sort();
    expect(decided).toEqual(discovered);
  });

  it("never lists a route both as swept and as excluded", () => {
    const overlap = (SWEPT_ROUTES as readonly string[]).filter((route) => route in EXCLUDED_ROUTES);
    expect(overlap).toEqual([]);
  });

  it("gives every exclusion a non-empty reason", () => {
    const blank = Object.entries(EXCLUDED_ROUTES)
      .filter(([, reason]) => reason.trim() === "")
      .map(([route]) => route);
    expect(blank).toEqual([]);
  });

  it("only exempts swept routes from the origin check, and says why", () => {
    const notSwept = Object.keys(ORIGIN_CHECK_EXEMPT).filter((route) => !(SWEPT_ROUTES as readonly string[]).includes(route));
    expect(notSwept).toEqual([]);
    const blank = Object.values(ORIGIN_CHECK_EXEMPT).filter((reason) => reason.trim() === "");
    expect(blank).toEqual([]);
  });
});
