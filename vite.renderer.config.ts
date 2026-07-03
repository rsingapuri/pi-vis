import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rendererPort = Number.parseInt(process.env["PIVIS_DEV_RENDERER_PORT"] ?? "5173", 10);

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  cacheDir: resolve(__dirname, ".cache/vite-renderer"),
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@renderer": resolve(__dirname, "src/renderer/src"),
    },
  },
  plugins: [react()],
  server: {
    port: rendererPort,
  },
  build: {
    outDir: resolve(__dirname, "out/renderer"),
    emptyOutDir: true,
  },
  define: {
    // Stub window.pivis for browser preview mode
    "window.__pivis_stub": "true",
  },
});
