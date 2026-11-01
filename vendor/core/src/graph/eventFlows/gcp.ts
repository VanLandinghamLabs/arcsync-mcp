/**
 * GCP event derivations: Pub/Sub subscription CEL filters and Eventarc
 * trigger matching criteria.
 */
import { deriveEventNames, parseCelFilter } from "../filterExpr.js";
import type { ResourceNode } from "../types.js";
import type { DeriveContext, DerivedEvent } from "./context.js";
import { eventsFromFilter, firstBlock, subscriptionBase } from "./context.js";
import { resolveTfRef } from "./refs.js";

function pubsubBusId(
  topicAttr: unknown,
  nodeIds: DeriveContext["nodeIds"],
  pubsubTopics: DeriveContext["pubsubTopics"],
): string | null {
  const topicRef =
    resolveTfRef(topicAttr) ??
    (typeof topicAttr === "string" ? (pubsubTopics.get(topicAttr) ?? null) : null);
  return topicRef && nodeIds.has(topicRef) ? topicRef : null;
}

export function deriveFromPubsubSubscription(
  sub: ResourceNode,
  { nodeIds, pubsubTopics, neighbors }: DeriveContext,
): DerivedEvent[] {
  const filter = sub.attributes.filter;
  if (typeof filter !== "string" || !filter.trim()) return [];
  const topicAttr = sub.attributes.topic;
  const busId = pubsubBusId(topicAttr, nodeIds, pubsubTopics);
  const base = subscriptionBase(sub.id, busId, "gcp", neighbors);
  const ast = parseCelFilter(filter);
  return eventsFromFilter(filter, ast ? deriveEventNames(ast) : null, base, sub.name);
}

export function deriveFromEventarcTrigger(
  trigger: ResourceNode,
  { nodeIds, pubsubTopics, neighbors }: DeriveContext,
): DerivedEvent[] {
  const raw = trigger.attributes.matching_criteria;
  const entries = (Array.isArray(raw) ? raw : [raw])
    .map((e) => firstBlock(e))
    .filter((e): e is Record<string, unknown> => e !== null);
  const types: string[] = [];
  const criteria: Record<string, string> = {};
  for (const entry of entries) {
    if (typeof entry.attribute !== "string" || typeof entry.value !== "string") continue;
    if (entry.attribute === "type") types.push(entry.value);
    else criteria[entry.attribute] = entry.value;
  }
  if (types.length === 0) return [];
  const transport = firstBlock(trigger.attributes.transport);
  const pubsub = transport ? firstBlock(transport.pubsub) : null;
  const topicAttr = pubsub?.topic;
  const busId = pubsubBusId(topicAttr, nodeIds, pubsubTopics);
  const base = subscriptionBase(trigger.id, busId, "gcp", neighbors);
  return types.map((t) => ({
    ...base,
    name: t,
    attributes: {
      eventType: t,
      ...(Object.keys(criteria).length > 0 ? { criteria } : {}),
    },
  }));
}
