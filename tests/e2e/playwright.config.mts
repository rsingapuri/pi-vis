import { defineConfig } from "@playwright/test";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.mts",
  timeout: 30_000,
  use: {
    trace: "on-first-retry",
  },
});
