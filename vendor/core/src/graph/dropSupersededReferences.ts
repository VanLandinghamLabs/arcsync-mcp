import { isFallbackProperty } from "./fallbackRail.js";
import type { ArchGraph, ResourceEdge } from "./types.js";
import { EdgeType } from "./types.js";

/** An unlabelled REFERENCE whose `viaProperty`, if any, names no relation of
 * its own. A Pulumi plan tags every edge with its property (#2936), so only a
 * fallback key or a CSP `connect-src` makes a tag meaningful. */
export const isBareReference = (edge: ResourceEdge): boolean =>
  edge.type === EdgeType.REFERENCE &&
  !edge.label &&
  (!edge.viaProperty ||
    (edge.viaProperty !== "connect-src" && !isFallbackProperty(edge.viaProperty)));

/**
 * Drops a bare REFERENCE edge when an IAM access edge runs the same
 * `source -> target` (#2889). The CloudFormation, Serverless and Terraform
 * parsers each mint both for a function that names a store in its environment
 * and also holds a policy on it; the model keeps both facts, the drawing needs
 * one line, and the access edge is the one that says what the link is.
 *
 * Keyed on the ORDERED pair, so a trigger running store -> function survives
 * beside the function's access edge. Labelled, fallback- or `connect-src`-tagged
 * and non-REFERENCE edges are never touched. Surviving edges keep their ids.
 */
export function dropSupersededReferences(graph: ArchGraph): ArchGraph {
  const accessTargets = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.type !== EdgeType.IAM) continue;
    const targets = accessTargets.get(edge.source) ?? new Set<string>();
    targets.add(edge.target);
    accessTargets.set(edge.source, targets);
  }
  if (accessTargets.size === 0) return graph;
  const edges = graph.edges.filter(
    (edge) => !(isBareReference(edge) && accessTargets.get(edge.source)?.has(edge.target)),
  );
  return edges.length === graph.edges.length ? graph : { ...graph, edges };
}
