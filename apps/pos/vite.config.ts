import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";
import path from "node:path";

// VS Code's integrated terminal exports ELECTRON_RUN_AS_NODE=1 for child node
// processes. vite-plugin-electron spawns electron inheriting this env, which
// makes electron run as plain Node — require("electron") then returns the binary
// path string, so `app` is undefined and app.whenReady() throws on launch.
// Clearing it here (before the plugin spawns electron) lets `npm run dev` open
// the real GUI from any terminal. No-op where the var isn't set.
delete process.env.ELECTRON_RUN_AS_NODE;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: "electron/main.ts",
        // Native/optional modules stay external — require()'d from node_modules
        // at runtime rather than bundled by Rollup. bufferutil and
        // utf-8-validate are ws's OPTIONAL native accelerators: bundling them
        // crashes the main process at load on machines where they aren't built,
        // while externalising them lets ws fall back to its JS path (#163 QA).
        vite: { build: { rollupOptions: { external: ["better-sqlite3", "bufferutil", "utf-8-validate"] } } },
      },
      preload: { input: "electron/preload.ts" },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "../../src/lib"),
    },
  },
});
