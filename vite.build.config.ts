import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { CORE_ALIASES } from "./core-aliases.mjs";

// One self-contained file: the vendored ArcSync core modules, the MCP SDK and
// zod are all inlined, so `npx` installs nothing beyond this package.
export default defineConfig({
  resolve: { alias: CORE_ALIASES },
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: {
        inlineDynamicImports: true,
        banner:
          '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
      },
    },
    target: "node22",
    outDir: "dist",
    sourcemap: false,
    minify: false,
    emptyOutDir: true,
  },
});
