import { isSyntheticStateId } from "./syntheticStateId.js";
import type { ArchGraph } from "./types.js";
import { EdgeType } from "./types.js";

/**
 * The one answer, for every pass that reasons about GEOMETRY, to "which
 * container does this node belong to".
 *
 * `ArchGraph` represents containment as ordinary `CONTAINS` edges, so nothing
 * in the type stops two of them naming the same target. Three passes used to
 * resolve that case three different ways — the layout adapter took the FIRST
 * parent, `layoutGraph`'s growth honoured EVERY parent, and `routeTable`'s
 * ancestor walk took the LAST — which meant a second `CONTAINS` edge made the
 * model, the ranking and the box geometry disagree about where a node lives
 * (#771). Measured before this module existed: a two-stack graph with one
 * shared child grew BOTH stacks to 5,200px wide to reach a node the layout
 * engine had ranked inside only the first of them.
 *
 * Deliberate holdouts, all of them asking a different question than "where is
 * this drawn", so none of them was rewired here:
 *
 * - `placeRouteTargets`' `nestedIds` asks "is this node nested AT ALL", which
 *   correctly reads every edge.
 * - `eventFlows`' `containsParent` is model semantics (which topic owns this
 *   subscription), not a box.
 * - `resolveDeletedIds` cascades a `deletedNodes` override through every
 *   CONTAINS edge, so deleting a group removes a node two containers claimed
 *   even when the OTHER container survives and was the one drawing it. The
 *   choice is between deleting that node too and leaving it where it is already
 *   drawn; it is NOT between deleting it and moving it, because neither rule
 *   ever re-homes a survivor. Deletion only ever turns live claimants into
 *   absent ones, and a node cannot outlive its WINNING claimant under either
 *   rule — both cascade a container's deletion to the children it won — so the
 *   earliest surviving claimant of a surviving node is the one it already had.
 *   Left cascading because a delete is destructive and explicit, and this is
 *   milder than the collapse defect it resembles — deletion runs BEFORE layout
 *   (`applyNodeDeletions` -> `prepare` -> `layoutGraph`), so the surviving
 *   container is re-laid-out around what remains and no boundary is ever
 *   painted around a node that is gone. Pinned by a two-parent case in
 *   `nodeDeletions.test.ts`, so switching it is a decision and not a tidy-up.
 *
 * Group COLLAPSE was a holdout too and is not any more (#773). Both renderers
 * built their own multi-parent map and fed it to `hiddenDescendants`, so a node
 * two containers claimed was DRAWN in the first and HIDDEN by either — collapse
 * the second and it vanished out of a box still on screen around the hole.
 * They call `containerChildSets` now, which makes hiding ask what drawing
 * asked. `hiddenDescendants` stays transitive, so the nested case is unchanged:
 * an Azure subnet resolved into its vnet still hides when the resource group
 * around that vnet collapses.
 *
 * FIRST-parent-wins is the rule, because it is the one the layout engine
 * actually honours: Mermaid's model allows a node exactly one parent, so
 * `toData4Layout` has to drop the extras regardless, and every other pass is
 * describing geometry the engine already produced under that choice.
 *
 * The node-existence check is part of the rule, not a defensive extra. A
 * `CONTAINS` edge naming a node the graph does not carry is skipped and
 * resolution falls through to the NEXT edge, so a dangling edge can never
 * shadow the real parent behind it.
 *
 * Multi-parent containment stays REPRESENTABLE, and the holdouts above depend
 * on that. What changed is that it is no longer RESOLVABLE to more than one
 * answer.
 */
export interface Containment {
  /** Child id → its single effective container. */
  parentOf: Map<string, string>;
  /**
   * Container id → the children it WON, in first-claim order. A node that
   * sources a `CONTAINS` edge whose target was already claimed appears in
   * `hasChildren` with no entry here, so read it as `childrenOf.get(id) ?? []`.
   */
  childrenOf: Map<string, string[]>;
  /**
   * Every node sourcing at least one usable `CONTAINS` edge — the "is a
   * container" question, which is separate from "won any children" on purpose:
   * a group whose only child another container claimed first is still drawn as
   * a group, and demoting it to a leaf here would make it pinnable and give it
   * a leaf's grid slot.
   */
  hasChildren: Set<string>;
}

/** Resolves `graph`'s `CONTAINS` edges under the rule documented on
 * {@link Containment}. Edge order is the tie-break, so callers that mint
 * edges control which parent wins by where they append. */
export function resolveContainment(graph: ArchGraph): Containment {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const hasChildren = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.type !== EdgeType.CONTAINS) continue;
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    hasChildren.add(edge.source);
    if (parentOf.has(edge.target)) continue;
    parentOf.set(edge.target, edge.source);
    const siblings = childrenOf.get(edge.source);
    if (siblings) siblings.push(edge.target);
    else childrenOf.set(edge.source, [edge.target]);
  }

  return { parentOf, childrenOf, hasChildren };
}

/**
 * `resolveContainment` reshaped as the container → children-set map the
 * geometry passes want, with an entry for every container — including one that
 * won no children, so `containers.has(id)` keeps answering "is a container"
 * rather than "has children of its own".
 */
export function containerChildSets(graph: ArchGraph): Map<string, Set<string>> {
  return containerChildSetsOf(resolveContainment(graph));
}

/** The grouping nodes the display pipeline adds (`groupByStack`,
 * `groupByEngine`): containers, not resources the diagram declares. */
const SYNTHETIC_GROUP = /^(stack|engine):/;

/**
 * Whether a node is a resource the diagram declares, which is what the legend
 * counts: a container that is a real resource (an expanded state machine, a
 * VPC, a nested stack) is one; an expanded machine's minted ASL states and the
 * pipeline's own `stack:*` / `engine:*` groups are not.
 */
export function isDeclaredResource(id: string): boolean {
  return !isSyntheticStateId(id) && !SYNTHETIC_GROUP.test(id);
}

/**
 * When a diagram's only root container holds every other node, how many
 * declared resources are inside it (`isDeclaredResource`, the legend's rule,
 * not counting the root itself, since the chip already names it);
 * otherwise null, and null too when none are. A field that tints the whole
 * diagram says nothing, so that root paints none and its chip carries the
 * count instead. `containers` is `containerChildSets`' map; the first parent
 * that claims a node wins, as it does there.
 */
export function soleRootResourceCount(
  nodeIds: Iterable<string>,
  containers: ReadonlyMap<string, ReadonlySet<string>>,
  roots: readonly string[],
): number | null {
  if (roots.length !== 1) return null;
  const [root] = roots;
  const parentOf = new Map<string, string>();
  for (const [parent, kids] of containers) {
    for (const kid of kids) if (!parentOf.has(kid)) parentOf.set(kid, parent);
  }
  const inside = (id: string) => {
    for (let p = parentOf.get(id); p !== undefined; p = parentOf.get(p))
      if (p === root) return true;
    return false;
  };
  let count = 0;
  for (const id of nodeIds) {
    if (id === root) continue;
    if (!inside(id)) return null;
    if (isDeclaredResource(id)) count++;
  }
  return count > 0 ? count : null;
}

/** `containerChildSets` for a caller that has already resolved the graph and
 * would otherwise pay for a second walk over the same `CONTAINS` edges. */
export function containerChildSetsOf(containment: Containment): Map<string, Set<string>> {
  const containers = new Map<string, Set<string>>();
  for (const id of containment.hasChildren) {
    containers.set(id, new Set(containment.childrenOf.get(id) ?? []));
  }
  return containers;
}
