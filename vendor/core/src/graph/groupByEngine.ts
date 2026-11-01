import { createEdgeIdMinter } from "./edgeIds.js";
import { lookupByType } from "./typeLookup.js";
import type { ArchGraph, IacEngine, ResourceEdge } from "./types.js";
import { EdgeType, ResourceType } from "./types.js";

const ENGINE_LABEL: Record<IacEngine, string> = {
  terraform: "Terraform",
  cloudformation: "CloudFormation",
  serverless: "Serverless",
};

/**
 * Groups nodes into per-engine containers using CONTAINS edges.
 *
 * Must run AFTER `groupByStack` so a multi-stack CloudFormation parse nests as
 * engine → stack → resources. Skipped unless at least two engines are present,
 * mirroring `groupByStack`'s own single-group bail.
 */
export function groupByEngine(graph: ArchGraph): ArchGraph {
  const byEngine = new Map<IacEngine, string[]>();
  const nodeEngine = new Map(graph.nodes.map((n) => [n.id, n.engine]));
  for (const node of graph.nodes) {
    if (!node.engine) continue;
    let ids = byEngine.get(node.engine);
    if (!ids) {
      ids = [];
      byEngine.set(node.engine, ids);
    }
    ids.push(node.id);
  }
  if (byEngine.size <= 1) return graph;

  const alreadyContained = new Set<string>();
  // A stack container minted by `groupByStack` carries no `engine` of its own,
  // so it never appears in `byEngine` above. Infer its engine from its
  // CONTAINS children so it can be nested under the right engine container
  // rather than left as a sibling of it.
  const stackEngine = new Map<string, IacEngine | null>();
  for (const edge of graph.edges) {
    if (edge.type !== EdgeType.CONTAINS) continue;
    alreadyContained.add(edge.target);

    const childEngine = nodeEngine.get(edge.target);
    if (!childEngine) continue;
    const seen = stackEngine.get(edge.source);
    stackEngine.set(edge.source, seen === undefined || seen === childEngine ? childEngine : null);
  }
  for (const [stackId, engine] of stackEngine) {
    // `!engine`: children disagreed on engine — leave the stack unattached
    // rather than nest it under an arbitrary one.
    // `nodeEngine.get(stackId)`: this "stack" is actually a real engine-tagged
    // node acting as a CONTAINS source (e.g. an API Gateway with routes) — it
    // is already in `byEngine` directly from the sweep above, so attaching it
    // again here would double it up.
    if (!engine || nodeEngine.get(stackId)) continue;
    // Every value that reaches here came from a real node's `.engine`, which
    // the sweep above already registered as a `byEngine` key.
    (byEngine.get(engine) as string[]).push(stackId);
  }

  const newNodes = [...graph.nodes];
  const newEdges: ResourceEdge[] = [...graph.edges];
  const nextEdgeId = createEdgeIdMinter(graph.edges);

  for (const [engine, nodeIds] of byEngine) {
    const containerId = `engine:${engine}`;
    newNodes.push({
      id: containerId,
      type: ResourceType.CLOUDFORMATION_STACK,
      provider: "aws",
      // A stored `engine` is cast, never validated. Unguarded this read the
      // `Object` function for an unknown engine, and `escapeMermaidLabel`
      // calling `.replace` on it made renderMermaid THROW (#1125).
      name: lookupByType(ENGINE_LABEL, engine) ?? engine,
      resourceType: `arcsync::engine::${engine}`,
      attributes: {},
    });
    for (const nodeId of nodeIds) {
      if (alreadyContained.has(nodeId)) continue;
      newEdges.push({
        id: nextEdgeId(),
        source: containerId,
        target: nodeId,
        type: EdgeType.CONTAINS,
      });
    }
  }

  return { nodes: newNodes, edges: newEdges, metadata: graph.metadata };
}
