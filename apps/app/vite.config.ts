import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // "@" resolves into the biti submodule (component-internal imports use it);
  // "~" is this app's own src, per the bygga convention.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../biti/src", import.meta.url)),
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
    // In the browser the API is same-origin; the dev server forwards it to the BFF.
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
  build: { sourcemap: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
