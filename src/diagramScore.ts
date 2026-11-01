import { parseArcsync, resolveIcon } from "@auto-arch-diagram/core/authoring";
import { EdgeType } from "@auto-arch-diagram/core/types";

export interface DiagramScore {
  valid: boolean;
  nodes: number;
  containers: number;
  maxDepth: number;
  describedRatio: number;
  iconRatio: number;
  stateMachines: number;
  edgeKindsUsed: number;
  pass: boolean;
}

const ratio = (count: number, total: number) => (total === 0 ? 0 : count / total);

/** The bar the arcsync-diagrams skill's evals hold a written diagram to. */
export const scoreDiagram = (source: string): DiagramScore => {
  const parsed = parseArcsync(source);
  const { nodes: all, edges } = parsed.graph;
  const contains = edges.filter((e) => e.type === EdgeType.CONTAINS);
  const parentOf = new Map(contains.map((e) => [e.target, e.source]));
  const containerIds = new Set(contains.map((e) => e.source));
  const stateBlocks = new Set(parsed.blocks.filter((b) => b.kind === "state").map((b) => b.id));
  // A state block nobody expands becomes its own node; it is not a drawn component.
  const leaves = all.filter((n) => !containerIds.has(n.id) && !stateBlocks.has(n.id));

  const depthOf = (id: string) => {
    let depth = 0;
    for (let p = parentOf.get(id); p !== undefined; p = parentOf.get(p)) depth++;
    return depth;
  };

  const described = leaves.filter((n) => {
    const d = n.attributes.description;
    return typeof d === "string" && d.trim() !== "";
  }).length;
  const iconed = leaves.filter((n) => {
    const icon = n.attributes.icon;
    return typeof icon === "string" && resolveIcon(icon) !== undefined;
  }).length;

  const score = {
    valid: parsed.ok,
    nodes: leaves.length,
    containers: containerIds.size,
    maxDepth: Math.max(0, ...all.map((n) => depthOf(n.id))),
    describedRatio: ratio(described, leaves.length),
    iconRatio: ratio(iconed, leaves.length),
    stateMachines: stateBlocks.size,
    edgeKindsUsed: new Set(edges.filter((e) => e.type !== EdgeType.CONTAINS).map((e) => e.type))
      .size,
  };
  return {
    ...score,
    pass:
      score.valid &&
      score.nodes >= 8 &&
      score.containers >= 2 &&
      score.describedRatio >= 0.6 &&
      score.iconRatio >= 0.8,
  };
};
