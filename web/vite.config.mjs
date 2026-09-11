import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/auth": "http://127.0.0.1:3100",
      "/feed.rss": "http://127.0.0.1:3100",
      "/feed.atom": "http://127.0.0.1:3100",
    },
  },
  test: { environment: "jsdom", include: ["src/**/*.test.jsx"], maxWorkers: 1 },
});
