import { appendFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

appendFileSync(new URL("./config-loaded.log", import.meta.url), "loaded\n");

export default defineConfig({
  test: {
    include: ["spec/**/*.case.js"],
    exclude: ["spec/excluded/**"],
    globalSetup: "./global-setup.js",
    setupFiles: ["./setup.js"],
  },
});
