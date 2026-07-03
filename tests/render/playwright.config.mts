import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { scopedPort } from "../isolation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const renderPort = scopedPort({
  envName: "PIVIS_RENDER_PORT",
  scopeName: "render",
  base: 27_000,
  range: 10_000,
});

/**
 * Renderer render tests — headless chromium against the Vite dev server
 * (`npm run dev:renderer`), which serves the real React app with a stubbed
 * `window.pivis` (src/renderer/src/preview-stub.ts). No Electron, no real pi:
 * the stub drives deterministic panel/event flows so the REAL renderer
 * (UnifiedTuiHost → xterm.js, store reducer, App slot logic) is exercised.
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.mts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${renderPort}/`,
    headless: true,
    trace: "on-first-retry",
  },
  webServer: {
    command: `npm run dev:renderer -- --host 127.0.0.1 --port ${renderPort} --strictPort`,
    url: `http://127.0.0.1:${renderPort}/`,
    cwd: root,
    reuseExistingServer: process.env["PIVIS_RENDER_REUSE_EXISTING"] === "1",
    timeout: 60_000,
  },
});
