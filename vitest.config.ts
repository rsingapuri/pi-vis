import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: resolve(__dirname, ".cache/vitest"),
  test: {
    environment: "node",
    // src/**/*.test.ts — the main/renderer/shared TypeScript suites.
    // resources/**/*.test.mjs — the SDK-host subprocess (plain ESM, not under
    //   src/, so the old glob silently excluded the entire host: trust resolver,
    //   command bridge, version gate). Only .test.mjs is matched here so it
    //   never collides with the Playwright e2e *.spec.mts under tests/e2e.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "resources/**/*.test.mjs"],
    globals: false,
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
});
