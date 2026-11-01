import { defineConfig } from "vitest/config";
import { CORE_ALIASES } from "./core-aliases.mjs";

export default defineConfig({
  resolve: { alias: CORE_ALIASES },
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
