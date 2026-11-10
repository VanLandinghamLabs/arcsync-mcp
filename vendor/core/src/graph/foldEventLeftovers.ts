import {
  fallbackRailFor,
  namesNode,
  railLabelFor,
  readAttributeEntry,
  referenceToken,
} from "./fallbackRail.js";
import { lookupByType } from "./typeLookup.js";
import type { ArchGraph, FallbackRail, ResourceEdge, ResourceNode } from "./types.js";
import { EdgeType, hasGraphArrays, ResourceType } from "./types.js";

/**
 * Folds the SNS subscriptions and EventBridge targets `extractEventFlows` left
 * behind into the topic or rule they hang off.
 *
 * That pass absorbs only the subscriptions and targets it turns into event
 * nodes: a filter policy, an event pattern. An unfiltered subscription or a
 * scheduled rule's target derives no event, so it stays a raw node that no
 * parser maps and draws as a "?" card between the topic and its consumer. This
 * pass replaces each with the edge it stands for, `topic -> consumer` or
 * `rule -> target`, typed `EVENT_FLOW` so edge semantics names it the way it
 * names an extracted flow. One with no consumer on the graph (an email or
 * HTTPS endpoint, a target outside the template) becomes a rail on its hub.
 *
 * Must run AFTER `extractEventFlows`: run first, it would consume exactly the
 * subscriptions that pass lifts into events.
 */

type LeftoverKind = "subscription" | "target";

const KIND_BY_RESOURCE_TYPE: Readonly<Record<string, LeftoverKind>> = {
  "AWS::SNS::Subscription": "subscription",
  aws_sns_topic_subscription: "subscription",
  "aws:sns/topicSubscription:TopicSubscription": "subscription",
  aws_cloudwatch_event_target: "target",
  "aws:cloudwatch/eventTarget:EventTarget": "target",
};

/** Hub types per kind, in preference order: a target names both its rule and
 * its bus, and the rule is what actually fires it. */
const HUB_TYPES: Record<LeftoverKind, readonly ResourceType[]> = {
  subscription: [ResourceType.SNS_TOPIC],
  target: [ResourceType.EVENTBRIDGE_RULE, ResourceType.EVENTBRIDGE_BUS],
};

/** The attribute naming the consumer, normalized. A target or subscription also
 * references things that are not its consumer (an ECS target's subnets and
 * task definition, a dead-letter queue), so the consumer is read from here
 * first, and the node keeps its card when the consumer cannot be told apart. */
const CONSUMER_KEY: Record<LeftoverKind, string> = {
  subscription: "endpoint",
  target: "arn",
};

/** Attribute keys a rail names and expands to, normalized. */
const RAIL_KEYS: Record<LeftoverKind, readonly string[]> = {
  subscription: ["protocol", "endpoint"],
  target: ["targetid", "id", "arn"],
};

function isScalar(value: unknown): value is string | number {
  return (
    (typeof value === "string" && value.length > 0 && !value.startsWith("${")) ||
    typeof value === "number"
  );
}

function leftoverRail(node: ResourceNode, kind: LeftoverKind): FallbackRail {
  const policy: string[] = [];
  const parts: string[] = [];
  for (const key of RAIL_KEYS[kind]) {
    const found = readAttributeEntry(node.attributes, key);
    if (!found || !isScalar(found.value)) continue;
    policy.push(`${found.key} ${found.value}`);
    parts.push(String(found.value));
  }
  const name = kind === "subscription" ? parts.join(" ") : parts[0];
  return fallbackRailFor(node, railLabelFor(kind), policy, name || undefined);
}

export function foldEventLeftovers(graph: ArchGraph): ArchGraph {
  if (!hasGraphArrays(graph)) return graph;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const containerIds = new Set(
    graph.edges.filter((e) => e.type === EdgeType.CONTAINS).map((e) => e.source),
  );

  const folded = new Set<string>();
  const minted: ResourceEdge[] = [];
  const railsByHub = new Map<string, FallbackRail[]>();
  const pending: Array<{ hub: string; consumer: string; node: ResourceNode }> = [];

  for (const node of graph.nodes) {
    if (node.type !== ResourceType.UNKNOWN) continue;
    const kind = lookupByType(KIND_BY_RESOURCE_TYPE, node.resourceType);
    if (!kind || containerIds.has(node.id)) continue;

    const neighbours: ResourceNode[] = [];
    for (const edge of graph.edges) {
      if (edge.type === EdgeType.CONTAINS) continue;
      const otherId =
        edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : null;
      const other = otherId === null || otherId === node.id ? undefined : nodeById.get(otherId);
      if (other && !neighbours.includes(other)) neighbours.push(other);
    }
    let hub: ResourceNode | undefined;
    for (const type of HUB_TYPES[kind]) {
      hub = neighbours.find((n) => n.type === type);
      if (hub) break;
    }
    // No topic or rule on the graph means nothing to fold onto; the node keeps
    // its card rather than vanish with whatever it connects.
    if (!hub) continue;
    const hubId = hub.id;
    const others = neighbours.filter((n) => n.id !== hubId);
    const token = referenceToken(readAttributeEntry(node.attributes, CONSUMER_KEY[kind])?.value);
    const named = token ? others.find((n) => namesNode(token, n)) : undefined;
    // A target's other bus reference is its rule's own `event_bus_name`, unless
    // its `arn` names that bus. Any further reference (an ECS target's subnets,
    // a queue URL in its input) is a relationship this pass has no edge for, so
    // the node keeps its card.
    const rest = others.filter(
      (n) => n !== named && !(kind === "target" && n.type === ResourceType.EVENTBRIDGE_BUS),
    );
    const candidates = named ? [named] : rest;
    if (rest.length > (named ? 0 : 1)) continue;
    folded.add(node.id);
    if (candidates.length === 0) {
      const rails = railsByHub.get(hubId);
      if (rails) rails.push(leftoverRail(node, kind));
      else railsByHub.set(hubId, [leftoverRail(node, kind)]);
      continue;
    }
    pending.push({ hub: hubId, consumer: candidates[0].id, node });
  }

  if (folded.size === 0) return graph;

  const survivingEdges = graph.edges.filter((e) => !folded.has(e.source) && !folded.has(e.target));
  const drawn = new Set(
    survivingEdges
      .filter((e) => e.type !== EdgeType.CONTAINS)
      .map((e) => `${e.source}\u0000${e.target}`),
  );
  for (const { hub, consumer, node } of pending) {
    const key = `${hub}\u0000${consumer}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    minted.push({
      id: `fold-${node.id}`,
      source: hub,
      target: consumer,
      type: EdgeType.EVENT_FLOW,
    });
  }

  return {
    ...graph,
    nodes: graph.nodes
      .filter((n) => !folded.has(n.id))
      .map((n) => {
        const rails = railsByHub.get(n.id);
        return rails ? { ...n, fallbackRails: [...(n.fallbackRails ?? []), ...rails] } : n;
      }),
    edges: [...survivingEdges, ...minted],
  };
}
