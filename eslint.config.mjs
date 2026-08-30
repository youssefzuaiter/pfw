import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma-generated client code — vendor output, not hand-authored.
    "src/generated/**",
    // Stryker leaves its last mutation-testing sandbox on disk for
    // debugging — it's a full copy of the repo (including this config),
    // so ESLint must not descend into it.
    ".stryker-tmp/**",
    "reports/**",
    // The Python sidecar has its own tooling (see sidecar/README.md);
    // its .venv especially must never be linted as JS/TS.
    "sidecar/**",
    // Vendored, pre-minified Tesseract.js worker/WASM-glue assets
    // (AGENTS.md §3q) — self-hosted static files, not hand-authored code.
    "public/tesseract/**",
    // Vendored onnxruntime-web WASM-glue asset (AGENTS.md §3u), same
    // "self-hosted static file, not hand-authored code" treatment.
    "public/onnx-runtime/**",
  ]),
]);

export default eslintConfig;
