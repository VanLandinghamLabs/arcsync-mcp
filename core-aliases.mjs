import { fileURLToPath } from "node:url";

const core = (path) => fileURLToPath(new URL(`./vendor/core/src/${path}`, import.meta.url));

export const CORE_ALIASES = {
  "@auto-arch-diagram/core/apiContract": core("apiContract.ts"),
  "@auto-arch-diagram/core/authoring": core("authoring/index.ts"),
  "@auto-arch-diagram/core/graphDelta": core("graph/graphDelta.ts"),
  "@auto-arch-diagram/core/graphRead": core("graphRead.ts"),
  "@auto-arch-diagram/core/mermaid": core("renderers/mermaid/mermaidRenderer.ts"),
  "@auto-arch-diagram/core/quotaErrorCodes": core("quotaErrorCodes.ts"),
  "@auto-arch-diagram/core/types": core("graph/types.ts"),
};
