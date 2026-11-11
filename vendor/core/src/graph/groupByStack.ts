import { createEdgeIdMinter } from "./edgeIds.js";
import type { ArchGraph, IacEngine, ResourceEdge } from "./types.js";
import { EdgeType, ResourceType } from "./types.js";

/**
 * An ARM resource type's namespace segment (e.g. "Microsoft.Web" out of
 * "Microsoft.Web/serverfarms/plan") — always `Word.Word`, per the ARM spec.
 * The armParser mints node ids as `<type>/<name>`, which collides with this
 * function's generic "first `/`-segment is a stack" convention: a single ARM
 * template with two or more provider namespaces has no stacks at all (#1275),
 * only resource-type prefixes that happen to contain a `/`.
 *
 * This is a fallback shape guess, not the source of truth: an environment- or
 * region-suffixed document stem (`azuredeploy.prod`, `storage.westus2`) has
 * the same `Word.Word` shape and is a REAL document boundary. Any prefix
 * `graph.metadata.stackPrefixes` names is trusted over this pattern — see
 * `ArchGraphBuilder.addStackPrefixes`/`mergePrefixedGraphs`, the one place
 * that mints a genuine document prefix.
 */
const ARM_PROVIDER_NAMESPACE = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9]+$/;

/**
 * The stack each node id belongs to, by `groupByStack`'s own rules: the id's
 * first `/`-segment, ARM provider namespaces excluded (see
 * `ARM_PROVIDER_NAMESPACE`), and only when the graph has two or more stacks.
 * A node with no stack maps to nothing.
 */
export function stackMembership(graph: ArchGraph): Map<string, string> {
  // `metadata` is typed as required, but some frontend fixtures and graphs
  // stored before it was guaranteed still reach this function without one
  // (#1296 CI failure) — read it defensively rather than trust the type.
  const isArm = graph.metadata?.source === "arm";
  const knownDocumentPrefixes = new Set(graph.metadata?.stackPrefixes ?? []);

  const stackOf = new Map<string, string>();
  const stackNames = new Set<string>();
  for (const node of graph.nodes) {
    const slashIdx = node.id.indexOf("/");
    if (slashIdx === -1) continue;
    const stackName = node.id.substring(0, slashIdx);
    const looksLikeArmNamespace = isArm && ARM_PROVIDER_NAMESPACE.test(stackName);
    if (looksLikeArmNamespace && !knownDocumentPrefixes.has(stackName)) continue;
    stackOf.set(node.id, stackName);
    stackNames.add(stackName);
  }
  return stackNames.size <= 1 ? new Map() : stackOf;
}

/**
 * CDK's `NestedStack` resource in its parent's template:
 * `<scope path><id>NestedStack<id>NestedStackResource<hash>`.
 */
const NESTED_STACK_RESOURCE = /^(.*)NestedStack(.+)NestedStackResource[0-9A-F]{8}$/;
/** The hash CDK appends to a unique id (a nested stack's template file name, a
 * Stage stack's artifact id). */
const CDK_ID_HASH = /[0-9A-F]{8}$/;

/**
 * The child stack each CDK nested-stack resource deploys, keyed by the
 * resource's node id. The child's template file is named after its full
 * construct path plus a hash: the parent's name (without its own hash) and the
 * scope path from the resource's logical id. A resource with no single
 * matching stack in the graph is left out.
 */
function nestedStackChildren(
  graph: ArchGraph,
  stackOf: ReadonlyMap<string, string>,
  stackNames: ReadonlySet<string>,
): Map<string, string> {
  const children = new Map<string, string>();
  for (const node of graph.nodes) {
    const parent = stackOf.get(node.id);
    if (parent === undefined || node.resourceType !== "AWS::CloudFormation::Stack") continue;
    const match = NESTED_STACK_RESOURCE.exec(node.id.slice(parent.length + 1));
    if (!match?.[1].endsWith(match[2])) continue;
    const stem = `${parent.replace(CDK_ID_HASH, "")}${match[1]}`;
    const found = [...stackNames].filter(
      (name) => CDK_ID_HASH.test(name) && name.replace(CDK_ID_HASH, "") === stem,
    );
    if (found.length === 1) children.set(node.id, found[0]);
  }
  return children;
}

/**
 * Groups nodes into CloudFormation stack containers using CONTAINS edges.
 *
 * Extracts stack names from node ID prefixes (e.g., "CCHttpApi/CreateFn" → stack "CCHttpApi").
 * Creates virtual stack nodes and CONTAINS edges from stack → its top-level resources.
 * Resources already contained by another node (e.g., routes inside an API Gateway)
 * are skipped — their container becomes the stack's direct child instead.
 *
 * Skipped when fewer than 2 stacks are detected (no grouping needed). For an ARM
 * graph, a prefix that looks like an ARM provider namespace is never treated as a
 * stack unless `graph.metadata.stackPrefixes` explicitly names it (see
 * `ARM_PROVIDER_NAMESPACE`) — a multi-document ARM parse still groups per document
 * because `mergePrefixedGraphs` records each document's filename stem there.
 */
export function groupByStack(graph: ArchGraph): ArchGraph {
  // Identify which nodes are already contained
  const alreadyContained = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type === EdgeType.CONTAINS) {
      alreadyContained.add(edge.target);
    }
  }

  const stackOf = stackMembership(graph);
  const stacks = new Map<string, string[]>();
  for (const [nodeId, stackName] of stackOf) {
    let stack = stacks.get(stackName);
    if (!stack) {
      stack = [];
      stacks.set(stackName, stack);
    }
    stack.push(nodeId);
  }

  if (stacks.size <= 1) return graph;

  // A nested-stack resource duplicates its child's container: its edges (the
  // child's Parameters and Outputs) move onto the container, which nests in
  // the parent.
  const nestedChildren = nestedStackChildren(graph, stackOf, new Set(stacks.keys()));
  // The child container stands in for the resource, engine included, so
  // `groupByEngine` can still place a parent whose only children are stacks.
  const childEngine = new Map<string, IacEngine>();
  for (const node of graph.nodes) {
    const child = nestedChildren.get(node.id);
    if (child !== undefined && node.engine) childEngine.set(child, node.engine);
  }
  const containerOf = (id: string) => {
    const child = nestedChildren.get(id);
    return child === undefined ? id : `stack:${child}`;
  };
  const newNodes = graph.nodes.filter((node) => !nestedChildren.has(node.id));
  const newEdges: ResourceEdge[] = graph.edges.flatMap((edge) => {
    if (!nestedChildren.has(edge.source) && !nestedChildren.has(edge.target)) return [edge];
    if (edge.type === EdgeType.CONTAINS) return [];
    return [{ ...edge, source: containerOf(edge.source), target: containerOf(edge.target) }];
  });
  const nextEdgeId = createEdgeIdMinter(graph.edges);
  for (const [resourceId, child] of nestedChildren) {
    newEdges.push({
      id: nextEdgeId(),
      source: `stack:${stackOf.get(resourceId)}`,
      target: `stack:${child}`,
      type: EdgeType.CONTAINS,
    });
  }

  for (const [stackName, nodeIds] of stacks) {
    const stackId = `stack:${stackName}`;
    const engine = childEngine.get(stackName);

    newNodes.push({
      id: stackId,
      type: ResourceType.CLOUDFORMATION_STACK,
      provider: "aws",
      name: stackName,
      resourceType: "AWS::CloudFormation::Stack",
      attributes: {},
      ...(engine && { engine }),
    });

    for (const nodeId of nodeIds) {
      // Skip nodes already contained by another resource (they're nested inside it)
      if (alreadyContained.has(nodeId) || nestedChildren.has(nodeId)) continue;

      newEdges.push({
        id: nextEdgeId(),
        source: stackId,
        target: nodeId,
        type: EdgeType.CONTAINS,
      });
    }
  }

  return { nodes: newNodes, edges: newEdges, metadata: graph.metadata };
}
