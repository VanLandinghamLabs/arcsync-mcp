import {
  type ChangedNodeDetail,
  diffNodeAttributes,
  withoutDeployArtifacts,
} from "./attributeDiff.js";
import { stableStringify } from "./stableStringify.js";
import { lookupByType } from "./typeLookup.js";
import type { ArchGraph, EdgeType, ResourceEdge, ResourceNode, ResourceType } from "./types.js";

export type { ChangedNodeDetail };

/** A node as the PR comment and the canvas overlay name it. */
export interface DeltaNode {
  id: string;
  type: ResourceType;
  name: string;
  resourceType: string;
}

/** Edge identity is the triple, never `edge.id` — ids are positional. */
export interface DeltaEdge {
  source: string;
  target: string;
  type: EdgeType;
}

export interface GraphDelta {
  added: DeltaNode[];
  removed: DeltaNode[];
  changed: DeltaNode[];
  /** Changed only in deploy-artifact pointers; not in `changed`. Absent from
   * deltas stored before the classification existed. */
  codeOnly?: DeltaNode[];
  edgesAdded: DeltaEdge[];
  edgesRemoved: DeltaEdge[];
}

export interface DeltaCounts {
  added: number;
  removed: number;
  changed: number;
  edgesAdded: number;
  edgesRemoved: number;
  /** added + removed + changed */
  resources: number;
  /** Changed resources whose only changes are deploy-artifact pointers
   * (`Code.S3Key` and the like). Counted here, not in `changed` or
   * `resources`. Absent on summaries stored before it existed. */
  codeOnly?: number;
}

export interface DeltaBaseInfo {
  graphId: string;
  ref: string;
  sha: string;
  /** Whether the base graph's recorded commit equals the PR's base SHA. */
  exact: boolean;
}

/** The wire shape returned by ingest and by GET /graphs/{id}. */
export type DeltaEnvelope =
  | { status: "no-base"; baseRef: string }
  | { status: "ok"; tier: "free"; base: DeltaBaseInfo; counts: DeltaCounts }
  /** The caller is Pro but the full delta could not be read; counts only, no upsell. */
  | { status: "ok"; tier: "pro-counts"; base: DeltaBaseInfo; counts: DeltaCounts }
  | {
      status: "ok";
      tier: "pro";
      base: DeltaBaseInfo;
      counts: DeltaCounts;
      summary: string;
      nodes: { added: DeltaNode[]; removed: DeltaNode[]; changed: DeltaNode[] };
      edges: { added: DeltaEdge[]; removed: DeltaEdge[] };
    };

// The persisted node fields. Everything else on ResourceNode is display-time
// (`position`, `routeTable`, `fallbackRails`, ...) and would report a change
// that no template author made.
const PERSISTED_KEYS = [
  "type",
  "resourceType",
  "name",
  "engine",
  "decodedPaths",
  "attributes",
] as const;

function fingerprint(n: ResourceNode): string {
  const picked: Record<string, unknown> = {};
  for (const k of PERSISTED_KEYS) picked[k] = n[k];
  return stableStringify(picked);
}

const withoutArtifacts = (n: ResourceNode): ResourceNode => ({
  ...n,
  attributes: withoutDeployArtifacts(n.resourceType, n.attributes) as ResourceNode["attributes"],
});

/** True when two versions of a node differ, and differ only in deploy-artifact
 * pointers. Any other persisted difference, `resourceType` included, makes it
 * a real change. */
export function isCodeOnlyChange(before: ResourceNode, after: ResourceNode): boolean {
  return (
    fingerprint(before) !== fingerprint(after) &&
    fingerprint(withoutArtifacts(before)) === fingerprint(withoutArtifacts(after))
  );
}

const toDeltaNode = (n: ResourceNode): DeltaNode => ({
  id: n.id,
  type: n.type,
  name: n.name,
  resourceType: n.resourceType,
});

const toDeltaEdge = (e: ResourceEdge): DeltaEdge => ({
  source: e.source,
  target: e.target,
  type: e.type,
});

const edgeKey = (e: { source: string; target: string; type: string }): string =>
  `${e.source}\n${e.target}\n${e.type}`;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a: DeltaNode, b: DeltaNode): number => cmp(a.id, b.id);
const byEdge = (a: DeltaEdge, b: DeltaEdge): number => cmp(edgeKey(a), edgeKey(b));

const nodesOf = (g: ArchGraph): ResourceNode[] => (Array.isArray(g?.nodes) ? g.nodes : []);
const edgesOf = (g: ArchGraph): ResourceEdge[] => (Array.isArray(g?.edges) ? g.edges : []);

export function diffGraphs(base: ArchGraph, head: ArchGraph): GraphDelta {
  const baseNodes = new Map(nodesOf(base).map((n) => [n.id, n]));
  const headNodes = new Map(nodesOf(head).map((n) => [n.id, n]));

  const added: DeltaNode[] = [];
  const changed: DeltaNode[] = [];
  const codeOnly: DeltaNode[] = [];
  const removed: DeltaNode[] = [];
  for (const [id, n] of headNodes) {
    const b = baseNodes.get(id);
    if (!b) added.push(toDeltaNode(n));
    else if (fingerprint(b) === fingerprint(n)) continue;
    else if (isCodeOnlyChange(b, n)) codeOnly.push(toDeltaNode(n));
    else changed.push(toDeltaNode(n));
  }
  for (const [id, n] of baseNodes) {
    if (!headNodes.has(id)) removed.push(toDeltaNode(n));
  }

  const baseEdges = new Map(edgesOf(base).map((e) => [edgeKey(e), e]));
  const headEdges = new Map(edgesOf(head).map((e) => [edgeKey(e), e]));
  const edgesAdded: DeltaEdge[] = [];
  const edgesRemoved: DeltaEdge[] = [];
  for (const [k, e] of headEdges) if (!baseEdges.has(k)) edgesAdded.push(toDeltaEdge(e));
  for (const [k, e] of baseEdges) if (!headEdges.has(k)) edgesRemoved.push(toDeltaEdge(e));

  return {
    added: added.sort(byId),
    removed: removed.sort(byId),
    changed: changed.sort(byId),
    codeOnly: codeOnly.sort(byId),
    edgesAdded: edgesAdded.sort(byEdge),
    edgesRemoved: edgesRemoved.sort(byEdge),
  };
}

export function deltaCounts(d: GraphDelta): DeltaCounts {
  return {
    added: d.added.length,
    removed: d.removed.length,
    changed: d.changed.length,
    edgesAdded: d.edgesAdded.length,
    edgesRemoved: d.edgesRemoved.length,
    resources: d.added.length + d.removed.length + d.changed.length,
    codeOnly: d.codeOnly?.length ?? 0,
  };
}

function plural(label: string, count: number): string {
  if (count === 1 || label.endsWith("s")) return label;
  return `${label}s`;
}

function phrase(
  verb: string,
  nodes: DeltaNode[],
  labels: Partial<Record<ResourceType, string>>,
): string {
  if (nodes.length === 0) return "";
  const groups = new Map<string, number>();
  for (const n of nodes) {
    const label = lookupByType(labels, n.type) ?? n.resourceType;
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }
  const entries = [...groups].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  const shown = entries.slice(0, 3).map(([label, count]) => `${count} ${plural(label, count)}`);
  const rest = entries.slice(3).reduce((sum, [, count]) => sum + count, 0);
  const list = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
  return `${verb} ${list}`;
}

/**
 * One sentence for the PR comment: "adds 1 RDS, removes 1 NAT Gateway, changes
 * 2 Security Groups". Edges are not in the sentence; they live in the counts.
 * `labels` is `RESOURCE_DISPLAY_NAMES` from the Mermaid renderer at the one
 * call site; it is a parameter so this module owes the renderer nothing.
 */
export function summarizeDelta(
  d: GraphDelta,
  labels: Partial<Record<ResourceType, string>> = {},
): string {
  const parts = [
    phrase("adds", d.added, labels),
    phrase("removes", d.removed, labels),
    phrase("changes", d.changed, labels),
  ].filter((p) => p !== "");
  return parts.length === 0 ? "no infrastructure changes" : parts.join(", ");
}

export interface DetailedGraphDelta {
  added: DeltaNode[];
  removed: DeltaNode[];
  changed: ChangedNodeDetail[];
  codeOnly: ChangedNodeDetail[];
  edgesAdded: DeltaEdge[];
  edgesRemoved: DeltaEdge[];
}

/**
 * `diffGraphs` plus per-node attribute detail on the changed set. Separate
 * entry point so the PR-comment and overlay callers keep the cheaper shape.
 */
export function diffGraphsDetailed(base: ArchGraph, head: ArchGraph): DetailedGraphDelta {
  const shallow = diffGraphs(base, head);
  const baseNodes = new Map(nodesOf(base).map((n) => [n.id, n]));
  const headNodes = new Map(nodesOf(head).map((n) => [n.id, n]));

  const detailed = (n: DeltaNode): ChangedNodeDetail => {
    const b = baseNodes.get(n.id);
    const h = headNodes.get(n.id);
    const detail = b && h ? diffNodeAttributes(b, h) : { changes: [], truncated: 0 };
    return { ...n, changes: detail.changes, truncated: detail.truncated };
  };

  return {
    ...shallow,
    changed: shallow.changed.map(detailed),
    codeOnly: (shallow.codeOnly ?? []).map(detailed),
  };
}
