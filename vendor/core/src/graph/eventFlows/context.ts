/**
 * What every deriver is handed and what every deriver returns.
 *
 * `extractEventFlows` builds one `DeriveContext` per graph and dispatches on
 * resource type into the per-provider deriver modules beside this one; those
 * modules share nothing with each other except this file and `./refs.js`.
 */
import type { deriveEventNames } from "../filterExpr.js";
import type { ResourceEdge, ResourceNode } from "../types.js";
import { EdgeType, type ResourceType } from "../types.js";

export interface DerivedEvent {
  name: string;
  busId: string | null;
  targets: string[];
  attributes: Record<string, unknown>;
  absorbedIds: string[];
  derivedFrom: string;
  provider: "aws" | "gcp" | "azure";
}

/** Everything a deriver may need, built once per graph and handed to each. */
export interface DeriveContext {
  nodeIds: Set<string>;
  neighbors: Map<string, Set<string>>;
  nodesById: Map<string, ResourceNode>;
  targetsByRule: Map<string, { targetIds: string[]; absorbedIds: string[] }>;
  eventBuses: Map<string, string | null>;
  pubsubTopics: Map<string, string>;
  containsParent: Map<string, string>;
  subTopicOf: (subId: string) => string | null;
}

export type Deriver = (node: ResourceNode, ctx: DeriveContext) => DerivedEvent[];

const NEIGHBOR_EDGE_TYPES = new Set([EdgeType.REFERENCE, EdgeType.IAM, EdgeType.DEPENDENCY]);

/** Undirected adjacency over REFERENCE/IAM/DEPENDENCY edges (CONTAINS, EVENT_FLOW excluded). */
export function buildNeighborIndex(edges: ResourceEdge[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = index.get(a);
    if (!set) {
      set = new Set();
      index.set(a, set);
    }
    set.add(b);
  };
  for (const e of edges) {
    if (!NEIGHBOR_EDGE_TYPES.has(e.type)) continue;
    add(e.source, e.target);
    add(e.target, e.source);
  }
  return index;
}

export function consumersOf(
  nodeId: string,
  exclude: ReadonlySet<string | null>,
  neighbors: Map<string, Set<string>>,
): string[] {
  const set = neighbors.get(nodeId);
  if (!set) return [];
  return [...set].filter((id) => !exclude.has(id)).sort();
}

/** The fields shared by every event a subscription-style node derives. */
export function subscriptionBase(
  nodeId: string,
  busId: string | null,
  provider: DerivedEvent["provider"],
  neighbors: Map<string, Set<string>>,
): Omit<DerivedEvent, "name" | "attributes"> {
  return {
    busId,
    targets: consumersOf(nodeId, new Set([nodeId, busId]), neighbors),
    absorbedIds: [nodeId],
    derivedFrom: nodeId,
    provider,
  };
}

/** The single REFERENCE/IAM/DEPENDENCY neighbor of the given type, or null if none/ambiguous. */
export function soleNeighborOfType(
  nodeId: string,
  type: ResourceType,
  neighbors: Map<string, Set<string>>,
  nodesById: Map<string, ResourceNode>,
): string | null {
  const set = neighbors.get(nodeId);
  if (!set) return null;
  const matches = [...set].filter((id) => nodesById.get(id)?.type === type);
  return matches.length === 1 ? matches[0] : null;
}

/** Turn a filter derivation into DerivedEvents; summarized -> one node named "{owner} filter". */
export function eventsFromFilter(
  rawFilter: string,
  parsed: ReturnType<typeof deriveEventNames> | null,
  base: Omit<DerivedEvent, "name" | "attributes">,
  ownerName: string,
): DerivedEvent[] {
  if (!parsed || parsed.summarized) {
    return [{ ...base, name: `${ownerName} filter`, attributes: { filter: rawFilter } }];
  }
  return parsed.names.map((n) =>
    n.endsWith("*")
      ? { ...base, name: n, attributes: { prefix: n.slice(0, -1), filter: rawFilter } }
      : { ...base, name: n, attributes: { eventType: n, filter: rawFilter } },
  );
}

/** Unwrap a possibly hcl2json-array-wrapped block into its (only) object form. */
export function firstBlock(value: unknown): Record<string, unknown> | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
