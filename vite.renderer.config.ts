import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@renderer": resolve(__dirname, "src/renderer/src"),
    },
  },
  plugins: [react()],
  server: {
    port: 5173,
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
