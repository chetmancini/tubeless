import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      importSource: "preact",
      runtime: "automatic",
    },
  },
  test: {
    coverage: {
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-support.ts", "scripts/**"],
      include: ["src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text", "html"],
    },
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
  },
});
