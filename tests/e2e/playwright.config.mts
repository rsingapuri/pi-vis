import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));

const optInIgnores = [
  ...(process.env["REAL_PI_VERIFY"] === "1" ? [] : ["real-pi-verify.spec.mts"]),
  ...(process.env["PI_E2E"] === "1" ? [] : ["panels-real.spec.mts"]),
];
const workers = Number.parseInt(process.env["PIVIS_E2E_WORKERS"] ?? "1", 10);

export default defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.mts",
  testIgnore: optInIgnores,
  globalTeardown: join(__dirname, "global-teardown.mts"),
  timeout: 30_000,
  workers: Number.isFinite(workers) && workers > 0 ? workers : 1,
  use: {
    trace: "on-first-retry",
  },
});
