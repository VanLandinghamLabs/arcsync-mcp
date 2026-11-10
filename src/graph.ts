import type { ArchGraph, ResourceNode } from "@auto-arch-diagram/core/types";

type Row = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** Drops undefined fields so the JSON an agent reads carries no noise. */
export const compact = <T extends Row>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export const canvasUrl = (appUrl: string, graphId: string) =>
  `${appUrl}/canvas/${encodeURIComponent(graphId)}`;

type TitleFields = Pick<Row, "displayOwner" | "displayRepo" | "repoUrl" | "branch" | "subpath">;

function repoLabel(row: Partial<TitleFields>): string | undefined {
  const owner = str(row.displayOwner);
  const repo = str(row.displayRepo);
  if (owner && repo) return `${owner}/${repo}`;
  const url = str(row.repoUrl);
  return url?.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
}

export function diagramTitle(row: Partial<TitleFields>): string {
  const repo = repoLabel(row) ?? "diagram";
  const branch = str(row.branch);
  const subpath = str(row.subpath);
  return `${repo}${branch ? `@${branch}` : ""}${subpath ? ` (${subpath})` : ""}`;
}

/** One row of `GET /graphs`, reduced to what an agent needs to pick a diagram. */
export function summarizeListItem(row: Row, appUrl: string) {
  const graphId = str(row.graphId) ?? "";
  return compact({
    graphId,
    title: diagramTitle(row),
    repoUrl: str(row.repoUrl),
    branch: str(row.branch),
    subpath: str(row.subpath),
    projectType: str(row.projectType),
    provider: str(row.provider),
    status: str(row.status),
    resources: num(row.nodeCount),
    relationships: num(row.edgeCount),
    lastParsedAt: str(row.lastParsedAt),
    prNumber: num(row.prNumber),
    canvasUrl: canvasUrl(appUrl, graphId),
  });
}

export function matchesQuery(row: Row, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.repoUrl, row.branch, row.subpath, row.displayOwner, row.displayRepo, row.projectType]
    .filter((v): v is string => typeof v === "string")
    .some((v) => v.toLowerCase().includes(q));
}

export function graphOf(raw: { graphData?: unknown }): ArchGraph | null {
  const g = raw.graphData as ArchGraph | undefined;
  return g && Array.isArray(g.nodes) && Array.isArray(g.edges) ? g : null;
}

type ResourceMatch =
  | { kind: "found"; node: ResourceNode }
  | { kind: "ambiguous"; candidates: ResourceNode[] }
  | { kind: "none" };

const MAX_CANDIDATES = 20;

/** Exact id, then exact name (case-insensitive), then a substring of id, name
 * or resource type. A unique hit at any stage wins. */
export function findResource(graph: ArchGraph, query: string): ResourceMatch {
  const q = query.trim().toLowerCase();
  if (!q) return { kind: "none" };
  const byId = graph.nodes.find((n) => n.id === query.trim());
  if (byId) return { kind: "found", node: byId };
  const stages = [
    graph.nodes.filter((n) => n.id.toLowerCase() === q || n.name?.toLowerCase() === q),
    graph.nodes.filter((n) =>
      [n.id, n.name, n.resourceType].some((v) => v?.toLowerCase().includes(q)),
    ),
  ];
  for (const hits of stages) {
    if (hits.length === 1) return { kind: "found", node: hits[0] };
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits.slice(0, MAX_CANDIDATES) };
  }
  return { kind: "none" };
}

export const nodeRef = (n: ResourceNode) =>
  compact({ id: n.id, name: n.name, resourceType: n.resourceType });

const MAX_ATTRIBUTE_CHARS = 6000;

/** Attributes are IaC source values and can be large (inline policies, user
 * data). Past the budget the JSON is cut and says so, rather than flooding the
 * agent's context. */
export function boundedAttributes(attrs: unknown): unknown {
  const text = JSON.stringify(attrs ?? {});
  if (text.length <= MAX_ATTRIBUTE_CHARS) return attrs ?? {};
  return {
    truncated: true,
    note: `attributes are ${text.length} characters; showing the first ${MAX_ATTRIBUTE_CHARS}`,
    json: text.slice(0, MAX_ATTRIBUTE_CHARS),
  };
}

export function describeResource(graph: ArchGraph, node: ResourceNode) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const peer = (id: string) => {
    const n = byId.get(id);
    return n ? nodeRef(n) : { id };
  };
  return compact({
    id: node.id,
    name: node.name,
    type: node.type,
    resourceType: node.resourceType,
    provider: node.provider,
    engine: node.engine,
    attributes: boundedAttributes(node.attributes),
    outgoing: graph.edges
      .filter((e) => e.source === node.id)
      .map((e) => compact({ type: e.type, label: e.label, to: peer(e.target) })),
    incoming: graph.edges
      .filter((e) => e.target === node.id)
      .map((e) => compact({ type: e.type, label: e.label, from: peer(e.source) })),
  });
}

/** The graph as plain lists, for an agent that wants to reason over it rather
 * than read a picture. */
export function graphAsJson(graph: ArchGraph) {
  return {
    resources: graph.nodes.map((n) => compact({ ...nodeRef(n), type: n.type })),
    relationships: graph.edges.map((e) =>
      compact({ source: e.source, target: e.target, type: e.type, label: e.label }),
    ),
  };
}
