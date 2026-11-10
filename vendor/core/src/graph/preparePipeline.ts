import { analyzeAccessPatterns } from "./analyzeAccessPatterns.js";
import { collapseIntegrations } from "./collapseIntegrations.js";
import { dropSupersededReferences } from "./dropSupersededReferences.js";
import { extractEventFlows } from "./eventFlows.js";
import { foldEventLeftovers } from "./foldEventLeftovers.js";
import { foldInvokeConfigs } from "./foldInvokeConfigs.js";
import { groupByEngine } from "./groupByEngine.js";
import { groupByStack } from "./groupByStack.js";
import type { ArchGraph } from "./types.js";

export interface PrepareOptions {
  eventFlows?: boolean;
}

/**
 * The pre-pipeline every renderer runs before layout: the canvas, the thumbnail
 * and renderMermaid all call this. Hand Mermaid the RAW graph, never this
 * function's output — renderMermaid applies it itself, and groupByStack and
 * extractEventFlows are both non-idempotent.
 */
export function prepare(graph: ArchGraph, options?: PrepareOptions): ArchGraph {
  const base = foldInvokeConfigs(
    foldEventLeftovers(options?.eventFlows === false ? graph : extractEventFlows(graph)),
  );
  return groupByEngine(
    groupByStack(collapseIntegrations(analyzeAccessPatterns(dropSupersededReferences(base)))),
  );
}
