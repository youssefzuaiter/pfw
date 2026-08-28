import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  ".stryker-tmp",
  "reports",
  "public",
  // Prisma-generated client code — vendor output, not hand-authored source.
  "generated",
]);

/** Recursively lists files under `root` whose name ends with one of `extensions`. */
export function walkSourceFiles(root: string, extensions: string[]): string[] {
  const results: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    for (const entry of readdirSync(dir)) {
      if (IGNORED_DIRS.has(entry)) continue;
      const fullPath = path.join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        stack.push(fullPath);
      } else if (extensions.some((ext) => entry.endsWith(ext))) {
        results.push(fullPath);
      }
    }
  }

  return results;
}
