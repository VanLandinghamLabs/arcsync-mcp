import { createEdgeIdMinter } from "./edgeIds.js";
import { stackMembership } from "./groupByStack.js";
import type { ArchGraph, ResourceEdge } from "./types.js";
import { EdgeType, ResourceType } from "./types.js";

/**
 * Transforms APIGW_V2_INTEGRATION nodes into labeled edges.
 *
 * Routes connect directly to their Lambda targets (labeled with integration name).
 * The API Gateway becomes a container (CONTAINS edges) for its routes and targets.
 * A target in a different stack than its API is not contained: it belongs in its
 * own stack's box, which `groupByStack` only draws around uncontained nodes (#2514).
 */
export function collapseIntegrations(graph: ArchGraph): ArchGraph {
  const integrationIds = new Set(
    graph.nodes.filter((n) => n.type === ResourceType.APIGW_V2_INTEGRATION).map((n) => n.id),
  );

  if (integrationIds.size === 0) return graph;

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const stackOf = stackMembership(graph);
  const edgesBySource = new Map<string, ResourceEdge[]>();
  const edgesByTarget = new Map<string, ResourceEdge[]>();
  const edgeBySourceTarget = new Map<string, ResourceEdge>();
  for (const edge of graph.edges) {
    let bySource = edgesBySource.get(edge.source);
    if (!bySource) {
      bySource = [];
      edgesBySource.set(edge.source, bySource);
    }
    bySource.push(edge);
    let byTarget = edgesByTarget.get(edge.target);
    if (!byTarget) {
      byTarget = [];
      edgesByTarget.set(edge.target, byTarget);
    }
    byTarget.push(edge);
    const key = `${edge.source}->${edge.target}`;
    if (!edgeBySourceTarget.has(key)) edgeBySourceTarget.set(key, edge);
  }

  const newEdges: ResourceEdge[] = [];
  const nextEdgeId = createEdgeIdMinter(graph.edges);

  // Track which edges to remove (route→api, route→integration)
  const edgesToRemove = new Set<string>();
  // Track containment: apiId → Set of child node ids
  const containment = new Map<string, Set<string>>();

  for (const integrationId of integrationIds) {
    const integration = nodeById.get(integrationId);
    if (!integration) continue;

    // Find edges from integration → other nodes
    const outEdges = edgesBySource.get(integrationId) ?? [];

    let apiId: string | undefined;
    const targetIds: string[] = [];

    for (const edge of outEdges) {
      const targetNode = nodeById.get(edge.target);
      if (
        targetNode &&
        (targetNode.type === ResourceType.APIGW_V2_API ||
          targetNode.type === ResourceType.APIGW_REST_API)
      ) {
        apiId = edge.target;
      } else if (targetNode) {
        targetIds.push(edge.target);
      }
    }

    if (!apiId) continue;

    // Find routes that reference this integration
    const routeEdges = (edgesByTarget.get(integrationId) ?? []).filter(
      (e) => !integrationIds.has(e.source),
    );

    for (const routeEdge of routeEdges) {
      const routeId = routeEdge.source;
      edgesToRemove.add(routeEdge.id);

      // Also remove the route→API edge (route is now inside the API subgraph)
      const routeToApi = edgeBySourceTarget.get(`${routeId}->${apiId}`);
      if (routeToApi) edgesToRemove.add(routeToApi.id);

      // Create route → target edges, labeled with integration name
      for (const targetId of targetIds) {
        newEdges.push({
          id: nextEdgeId(),
          source: routeId,
          target: targetId,
          type: EdgeType.REFERENCE,
          label: integration.name,
        });
      }

      // Track containment
      if (!containment.has(apiId)) containment.set(apiId, new Set());
      const children = containment.get(apiId);
      if (!children) continue;
      children.add(routeId);
      for (const targetId of targetIds) {
        const targetStack = stackOf.get(targetId);
        if (targetStack !== undefined && targetStack !== stackOf.get(apiId)) continue;
        children.add(targetId);
      }
    }
  }

  // --- Phase 2: Associate custom domain Route53 records with API Gateway containers ---
  // Pattern: Route53Record → DomainName ← ApiMapping → ApiGateway
  // Route53 records and API mappings both reference the same DomainName node,
  // and the API mapping also references the API Gateway.
  const customDomainNodesToRemove = new Set<string>();

  if (containment.size > 0) {
    const apiContainerIds = new Set(containment.keys());

    // Build edge indexes (excluding integration nodes already being removed)
    const outEdges = new Map<string, Set<string>>();
    const inEdges = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      if (edge.type === EdgeType.CONTAINS) continue;
      if (integrationIds.has(edge.source) || integrationIds.has(edge.target)) continue;
      if (!outEdges.has(edge.source)) outEdges.set(edge.source, new Set());
      const outSet = outEdges.get(edge.source);
      if (outSet) outSet.add(edge.target);
      if (!inEdges.has(edge.target)) inEdges.set(edge.target, new Set());
      const inSet = inEdges.get(edge.target);
      if (inSet) inSet.add(edge.source);
    }

    for (const node of graph.nodes) {
      if (node.type !== ResourceType.ROUTE53_RECORD) continue;
      // Skip if already contained
      if ([...containment.values()].some((c) => c.has(node.id))) continue;

      const recordTargets = outEdges.get(node.id);
      if (!recordTargets) continue;

      // Check direct association: Route53 → ApiGateway
      let found = false;
      for (const targetId of recordTargets) {
        if (apiContainerIds.has(targetId)) {
          const children = containment.get(targetId);
          if (children) children.add(node.id);
          found = true;
          break;
        }
      }

      // Check indirect via co-reference: Route53 → Intermediate ← Bridge → ApiGateway
      if (!found) {
        for (const intermediateId of recordTargets) {
          if (found) break;
          const coReferencers = inEdges.get(intermediateId);
          if (!coReferencers) continue;

          for (const bridgeId of coReferencers) {
            if (found) break;
            if (bridgeId === node.id) continue;
            const bridgeTargets = outEdges.get(bridgeId);
            if (!bridgeTargets) continue;

            for (const apiId of bridgeTargets) {
              if (apiContainerIds.has(apiId)) {
                const apiChildren = containment.get(apiId);
                if (apiChildren) apiChildren.add(node.id);
                // Mark intermediate nodes for removal (DomainName, ApiMapping are implementation details)
                customDomainNodesToRemove.add(intermediateId);
                customDomainNodesToRemove.add(bridgeId);
                found = true;
                break;
              }
            }
          }
        }
      }
    }
  }

  // Create CONTAINS edges
  for (const [apiId, children] of containment) {
    for (const childId of children) {
      newEdges.push({
        id: nextEdgeId(),
        source: apiId,
        target: childId,
        type: EdgeType.CONTAINS,
      });
    }
  }

  // Build set of all contained children for quick lookup
  const childToContainer = new Map<string, string>();
  for (const [apiId, children] of containment) {
    for (const childId of children) {
      childToContainer.set(childId, apiId);
    }
  }

  // Filter out integration nodes, custom domain intermediaries, and edges that reference them,
  // and remove edges between a container and its contained children
  const removedNodes = new Set([...integrationIds, ...customDomainNodesToRemove]);
  const nodes = graph.nodes.filter((n) => !removedNodes.has(n.id));
  // Minted edges get the same filter as pre-existing ones (#638). `containment`
  // and `customDomainNodesToRemove` are built by two independent passes with no
  // cross-check, so a node can be in both — an integration target that the
  // Route53 walk later picks as a custom-domain intermediate — and every entry
  // in `containment` has a CONTAINS edge minted for it. Filtering here rather
  // than at each mint site covers both edge kinds at once, including the
  // route→target REFERENCEs minted in phase 1, before phase 2 has decided what
  // it is removing.
  const mintedEdges = newEdges.filter(
    (e) => !removedNodes.has(e.source) && !removedNodes.has(e.target),
  );
  const edges = graph.edges.filter((e) => {
    if (removedNodes.has(e.source) || removedNodes.has(e.target)) return false;
    if (edgesToRemove.has(e.id)) return false;
    // Remove child → container edges (e.g. Lambda → its API Gateway)
    if (childToContainer.get(e.source) === e.target) return false;
    // Remove container → child edges that aren't CONTAINS
    if (containment.get(e.source)?.has(e.target) && e.type !== EdgeType.CONTAINS) return false;
    return true;
  });

  return {
    nodes,
    edges: [...edges, ...mintedEdges],
    metadata: graph.metadata,
  };
}
