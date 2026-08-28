import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Makes the `server-only` marker package resolve to its no-op branch
// instead of throwing — Next sets this same Node export condition when it
// bundles real Server Component modules; Vitest runs test files through
// Vite's SSR pipeline (Node), which doesn't set it by default. Shared by
// every node-environment project that imports server-only code (unit,
// integration) — never the jsdom "component" project, where real
// client-bundle React resolution matters.
const reactServerConditions = {
  resolve: { conditions: ["react-server"] },
  ssr: { resolve: { conditions: ["react-server"] } },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        ...reactServerConditions,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "tests/guards/**/*.test.ts", "prisma/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "component",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.mts"],
        },
      },
      {
        extends: true,
        ...reactServerConditions,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
