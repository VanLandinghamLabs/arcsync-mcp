import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { CORE_ALIASES } from "./core-aliases.mjs";

// dist/diagramScore.js, for skills/arcsync-diagrams/evals/run.mjs. Runs after the
// server build, so it must not empty dist.
export default defineConfig({
  resolve: { alias: CORE_ALIASES },
  build: {
    lib: {
      entry: "src/diagramScore.ts",
      formats: ["es"],
      fileName: () => "diagramScore.js",
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    },
    target: "node22",
    outDir: "dist",
    sourcemap: false,
    minify: false,
    emptyOutDir: false,
  },
});
