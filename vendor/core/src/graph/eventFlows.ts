import {
  deriveFromCfnRule,
  deriveFromSnsSubscription,
  deriveFromTfRule,
} from "./eventFlows/aws.js";
import { deriveFromEventGridSubscription, deriveFromServiceBusRule } from "./eventFlows/azure.js";
import type { DeriveContext, DerivedEvent, Deriver } from "./eventFlows/context.js";
import { buildNeighborIndex, soleNeighborOfType } from "./eventFlows/context.js";
import { deriveFromEventarcTrigger, deriveFromPubsubSubscription } from "./eventFlows/gcp.js";
import { resolveTfRef, scopedIdMatch, stringValues } from "./eventFlows/refs.js";
import type { ArchGraph, IacEngine, ResourceEdge, ResourceNode } from "./types.js";
import { EdgeType, hasGraphArrays, ResourceType } from "./types.js";

const SCHEMA_RESOURCE_TYPES = new Set(["AWS::EventSchemas::Schema", "aws_schemas_schema"]);

function schemaNameTail(name: string): string {
  const idx = Math.max(name.lastIndexOf("/"), name.lastIndexOf("@"));
  return idx === -1 ? name : name.slice(idx + 1);
}

function parseSchemaContent(raw: unknown): unknown | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Map schema-name tail -> parsed payload, for AWS::EventSchemas::Schema / aws_schemas_schema nodes. */
function buildSchemaByTail(nodes: ResourceNode[]): Map<string, unknown> {
  const byTail = new Map<string, unknown>();
  for (const node of nodes) {
    if (!SCHEMA_RESOURCE_TYPES.has(node.resourceType)) continue;
    const isCfn = node.resourceType === "AWS::EventSchemas::Schema";
    const rawName = isCfn ? node.attributes.SchemaName : node.attributes.name;
    const name = typeof rawName === "string" ? rawName : node.name;
    const content = parseSchemaContent(isCfn ? node.attributes.Content : node.attributes.content);
    if (content === null) continue;
    byTail.set(schemaNameTail(name), content);
  }
  return byTail;
}

/**
 * Derived event node id. A multi-stack CFN bus/topic id carries its stack as
 * a `{Stack}/{Logical}` prefix — keep that prefix in front of `event:` so
 * groupByStack's id-prefix grouping puts the event in the bus's own stack
 * container instead of fabricating a phantom "event:{Stack}" one.
 *
 * The event NAME (detail-type, filter value, etc.) is arbitrary user-IaC
 * text and may itself contain `/` — replace it (id only; `node.name` stays
 * verbatim) so it can't be mistaken for a stack-prefix separator by
 * groupByStack's id-prefix split.
 */
function eventNodeId(busId: string | null, name: string): string {
  const safeName = name.replaceAll("/", ":");
  if (!busId) return `event:default:${safeName}`;
  const slashIdx = busId.lastIndexOf("/");
  if (slashIdx === -1) return `event:${busId}:${safeName}`;
  const stackPrefix = busId.slice(0, slashIdx);
  const busLeaf = busId.slice(slashIdx + 1);
  return `${stackPrefix}/event:${busLeaf}:${safeName}`;
}

/** Structural mirror of the backend's publish-fact shape (core cannot import backend). */
interface PublishAttr {
  api: string;
  eventName?: string;
  dynamic?: boolean;
  busRef?: string;
  payloadShape?: Record<string, unknown>;
}

interface PublishFact {
  fnId: string;
  eventName: string;
  busRef?: string;
  payloadShape?: Record<string, unknown>;
}

/** Collect valid publish facts (dynamic and nameless facts are unresolvable, skip). Read-only. */
function collectPublishFacts(nodes: ResourceNode[]): PublishFact[] {
  const facts: PublishFact[] = [];
  for (const node of nodes) {
    const publishes = node.attributes?.publishes;
    if (!Array.isArray(publishes)) continue;
    for (const raw of publishes) {
      if (raw == null || typeof raw !== "object") continue;
      const p = raw as Partial<PublishAttr>;
      if (p.dynamic === true) continue;
      if (typeof p.eventName !== "string" || p.eventName === "") continue;
      const payloadShape =
        p.payloadShape != null &&
        typeof p.payloadShape === "object" &&
        !Array.isArray(p.payloadShape)
          ? p.payloadShape
          : undefined;
      facts.push({
        fnId: node.id,
        eventName: p.eventName,
        busRef: typeof p.busRef === "string" ? p.busRef : undefined,
        payloadShape,
      });
    }
  }
  return facts;
}

interface ConsumeAttr {
  eventName?: string;
  payloadShape: Record<string, unknown>;
}

/**
 * One event's reachable consume facts, plus which NODES produced each shape.
 *
 * The owner set is the part that matters for exclusivity: identical shapes
 * declared by different consumers are different answers, not a tie.
 */
interface CandidateSet {
  candidates: ConsumeAttr[];
  ownersByKey: Map<string, Set<string>>;
}

/**
 * `attributes.consumes` per node id — payload shapes read off the handlers that
 * RECEIVE an event, keyed by the node that declares them.
 *
 * An event's fields are usually declared once, as a type on the consuming
 * handler, and never as a literal a publisher builds — so for most codebases
 * this is the only place the shape exists at all.
 */
function collectConsumeFacts(nodes: ResourceNode[]): Map<string, ConsumeAttr[]> {
  const byNode = new Map<string, ConsumeAttr[]>();
  for (const node of nodes) {
    const consumes = node.attributes?.consumes;
    if (!Array.isArray(consumes)) continue;
    const facts: ConsumeAttr[] = [];
    for (const raw of consumes) {
      if (raw == null || typeof raw !== "object") continue;
      const c = raw as Partial<ConsumeAttr>;
      // A fact with no usable shape is not a payload, whatever else it carries.
      if (c.payloadShape == null || typeof c.payloadShape !== "object") continue;
      if (Array.isArray(c.payloadShape)) continue;
      facts.push({
        eventName: typeof c.eventName === "string" ? c.eventName : undefined,
        payloadShape: c.payloadShape,
      });
    }
    if (facts.length > 0) byNode.set(node.id, facts);
  }
  return byNode;
}

/**
 * Every consume fact reachable from one event's targets, then ONE hop past any
 * target that declares nothing itself. That hop is what makes the common
 * delivery shape work: EventBridge -> SQS -> Lambda puts the queue in the
 * target slot, so the handler holding the type is never a direct target.
 * Bounded to one hop deliberately — further out, "reachable from this event"
 * stops meaning "handles this event".
 *
 * Two separate sets, not one. `counted` stops a node's facts being taken twice
 * when several targets reach it. `expanded` is kept SEPARATE from it so that a
 * sibling's hop can never suppress a target's own expansion — conflating the
 * two made a target that happened to neighbour ANOTHER target skip its
 * expansion, so the payload depended on the order the template listed its
 * targets in. `expanded` does no work of its own beyond that separation:
 * `targets` is a Set, so no target is visited twice and `expanded.has(target)`
 * is never true (see the note at the loop).
 *
 * `neighbors` is undirected, so a hop can land on a PRODUCER of the queue as
 * easily as a consumer of it. That is why the caller still has to check what a
 * fact claims rather than trusting reachability.
 */
function consumerCandidatesFor(
  targets: Set<string>,
  consumeFacts: Map<string, ConsumeAttr[]>,
  neighbors: Map<string, Set<string>>,
): CandidateSet {
  const counted = new Set<string>();
  const expanded = new Set<string>();
  const out: ConsumeAttr[] = [];
  // Recorded BEFORE the content dedupe below. Two nodes declaring a
  // byte-identical shape collapse to one candidate, and an owner set built
  // after that would forget the one that lost the tie — which is precisely the
  // node that might also be reachable from another event.
  const ownersByKey = new Map<string, Set<string>>();
  const take = (id: string): boolean => {
    if (counted.has(id)) return false;
    const facts = consumeFacts.get(id);
    if (!facts) return false;
    counted.add(id);
    for (const f of facts) {
      const key = consumeKey(f);
      const owners = ownersByKey.get(key);
      if (owners) owners.add(id);
      else ownersByKey.set(key, new Set([id]));
    }
    out.push(...facts);
    return true;
  };
  for (const target of targets) {
    if (take(target)) continue;
    // KNOWN, pre-existing, and deliberately not fixed here: whether a
    // fact-declaring target is also EXPANDED depends on where it sits in
    // `Targets`, because a sibling's hop can count it first and make `take`
    // return false. Skipping the expansion outright looks like the fix and is
    // not: a handler TAGGED with this event's own name, one hop behind such a
    // target, stops being a candidate, and a tag is the strongest signal here.
    // Expanding every target instead is the promising direction, and is a far
    // wider behaviour change than a payload-attribution fix should carry —
    // roughly 27x the events touched, most of them LOSING a payload (measured
    // with a throwaway fuzz harness over generated graphs — not checked in, so
    // that figure is not re-derivable from this repo alone). Note it
    // would not be `expanded` doing that work: `targets` is a Set, so each is
    // visited once and `expanded.has(target)` is never true, here or under
    // that variant.
    if (expanded.has(target)) continue;
    expanded.add(target);
    for (const hop of neighbors.get(target) ?? []) take(hop);
  }
  // A handler annotated on both its const and its parameter reports one shape
  // twice; counting that as two candidates would refuse a case that is not
  // ambiguous at all. Deduped by CONTENT, which is why everything downstream
  // must count by content too — see `consumeKey`.
  const seenKeys = new Set<string>();
  const candidates = out.filter((c) => {
    const key = consumeKey(c);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  return { candidates, ownersByKey };
}

/**
 * Identity of a consume fact for counting purposes: its content, never the
 * object.
 *
 * Two handlers unpacking the same imported interface produce byte-identical
 * facts as DIFFERENT objects. Because candidates are deduped by content per
 * event, an identity-keyed count would see only whichever object happened to
 * survive that dedupe — so which event got labelled depended on edge iteration
 * order, and a shape both events reach could still label one of them.
 */
function consumeKey(c: ConsumeAttr): string {
  return JSON.stringify([c.eventName ?? null, c.payloadShape]);
}

/**
 * Consumer-declared payloads per event node id.
 *
 * Resolved for every event at once rather than one at a time, because the
 * decisive question is global: an untagged shape reachable from TWO events
 * describes at most one of them, and nothing says which — so it must label
 * neither. Per-event resolution cannot see that and would label both.
 */
function resolveConsumerPayloads(
  entries: Array<{ id: string; name: string; targets: Set<string> }>,
  consumeFacts: Map<string, ConsumeAttr[]>,
  neighbors: Map<string, Set<string>>,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (consumeFacts.size === 0) return out;

  const found = entries.map((entry) => ({
    ...entry,
    ...consumerCandidatesFor(entry.targets, consumeFacts, neighbors),
  }));
  // How many events each declaring NODE is reachable from — not how many events
  // reach its shape. "Reachable" is this traversal's sense: a target, or one hop
  // from a target along an UNDIRECTED edge, so it can include a node that WRITES
  // to the queue rather than one that reads from it.
  //
  // The two counts differ whenever a codebase declares one interface
  // per handler and they happen to coincide: seven handlers each unpacking
  // `{ eventId: string }`, each behind its own rule, are seven unambiguous
  // answers, and counting by shape read them as one seven-way tie and refused
  // all seven. Ambiguity is a NODE reachable from two events, which is exactly
  // what this counts.
  const eventsPerOwner = new Map<string, number>();
  for (const { ownersByKey } of found) {
    // Dedupe per event so an owner declaring several shapes counts once. No
    // test can observe this today and none pretends to: an owner appears under
    // two keys only by declaring two distinct shapes, and any event reaching
    // such an owner has >= 2 candidates and is refused at the `sole` check
    // before this map is ever read. Kept because the invariant it maintains is
    // the one the count is supposed to have.
    const reached = new Set<string>();
    for (const owners of ownersByKey.values()) {
      for (const owner of owners) reached.add(owner);
    }
    for (const owner of reached) {
      eventsPerOwner.set(owner, (eventsPerOwner.get(owner) ?? 0) + 1);
    }
  }

  for (const { id, name, candidates, ownersByKey } of found) {
    const named = candidates.filter((c) => c.eventName === name);
    // A tag naming this event wins outright, with no exclusivity count.
    //
    // Note what that does and does not say. Entries are keyed
    // `eventNodeId(bus, name)`, so a NAME is not unique — two buses each
    // carrying detail-type `OrderPlaced` are two entries, and a handler
    // reachable from both, tagged `OrderPlaced`, labels both. That is
    // deliberate: the tag names the event TYPE, and both entries genuinely are
    // that type. It is only wrong if two buses carry different versions of one
    // type name, which no signal here can distinguish.
    //
    // Exactly one, so two contradictory tags naming this event fall through
    // rather than the first winning. They then fail the sole-candidate check
    // below on their own — `named` is a subset of `candidates`, so two of them
    // means at least two candidates — which is why there is no separate
    // `named.length > 1` guard here.
    if (named.length === 1) {
      out.set(id, named[0].payloadShape);
      continue;
    }
    const sole = candidates.length === 1 ? candidates[0] : undefined;
    if (!sole) continue;
    // Only an UNTAGGED sole shape can stand in. One naming a DIFFERENT event is
    // describing something else, and reachability alone does not make it this
    // event's payload.
    //
    // This costs the case where an event's own name is synthetic — a rule
    // matching on `source` alone is named "source: com.acme.orders", which no
    // handler tags a type with, so its consumers' tags always "mismatch". That
    // loss is deliberate. Gating on `attributes.detailType` to recover it is
    // WRONG and was tried: only the two EventBridge rule derivations stamp it,
    // so the gate reads as vacuously permissive for SNS, Pub/Sub, Eventarc,
    // EventGrid and Service Bus, and re-opens the mislabelling for all of them.
    // Recovering it properly needs the derivations to record whether an event's
    // name IS an event type, which none of them does today.
    if (sole.eventName !== undefined) continue;
    // And every node that declared this shape for this event has to be reached
    // by THIS event alone. All of them, not just the one that survived the
    // content dedupe: a node whose shape was deduped away still describes
    // whatever else reaches it.
    let exclusive = true;
    // The `?? []` is a type-level fallback that cannot fire: `candidates` is
    // `out` deduped by this very key, so a sole candidate means `ownersByKey`
    // holds exactly this key, non-empty. Kept because the lookup is nullable by
    // type, not because anything reaches the empty arm.
    for (const owner of ownersByKey.get(consumeKey(sole)) ?? []) {
      if (eventsPerOwner.get(owner) !== 1) exclusive = false;
    }
    if (!exclusive) continue;
    // Known and accepted: this labels an event whose sole candidate came from a
    // node the hop reached in the wrong direction — a Lambda that WRITES to the
    // queue, carrying a shape for some other event. Counting by shape used to
    // block a subset of those by accident, whenever a second event happened to
    // declare the same shape; it never blocked the case where only one did. The
    // guard against it is the hop itself, not the exclusivity count, and
    // narrowing the hop to consumer-directed edges is the fix if it ever bites.
    out.set(id, sole.payloadShape);
  }
  return out;
}

/** AWS services that put their own events on the default bus, and the
 * resource that emits them. A rule matching `source: aws.ecs` subscribes to
 * every cluster's task and container state changes, so the cluster is the
 * event's producer even though no IaC names it as one. */
const AWS_SOURCE_EMITTERS: ReadonlyMap<string, ResourceType> = new Map([
  ["aws.ecs", ResourceType.ECS_CLUSTER],
]);

const BUS_NODE_TYPES = new Set<ResourceType>([
  ResourceType.EVENTBRIDGE_BUS,
  ResourceType.SNS_TOPIC,
  ResourceType.GCP_PUBSUB_TOPIC,
]);

/**
 * Provider for a producer-derived event node, mirroring how consumer
 * derivations label DerivedEvents (GCP topics -> "gcp", Azure -> "azure",
 * everything else / no bus -> "aws").
 */
function derivedProviderOf(busNode: ResourceNode | undefined): "aws" | "gcp" | "azure" {
  if (!busNode) return "aws";
  if (busNode.type === ResourceType.GCP_PUBSUB_TOPIC) return "gcp";
  if (busNode.provider === "azurerm" || busNode.provider === "azure") return "azure";
  return "aws";
}

/**
 * Resolve a publish fact's busRef to a node id: bare/owner-prefixed id match
 * first (accepted only when the matched node is bus/topic-typed — a busRef
 * colliding with an unrelated node's id, e.g. a Lambda, must not resolve),
 * then a unique name match among bus/topic-typed nodes. Two same-named buses
 * (or no match at all) resolve to null — the caller then falls back to
 * name-only join.
 */
function resolveBusRef(
  busRef: string,
  ownerId: string,
  nodeIds: Set<string>,
  nodesById: Map<string, ResourceNode>,
): string | null {
  const idMatch = scopedIdMatch(busRef, ownerId, nodeIds);
  if (idMatch) {
    const idMatchNode = nodesById.get(idMatch);
    if (idMatchNode && BUS_NODE_TYPES.has(idMatchNode.type)) return idMatch;
  }
  let match: string | null = null;
  let count = 0;
  for (const node of nodesById.values()) {
    if (!BUS_NODE_TYPES.has(node.type) || node.name !== busRef) continue;
    match = node.id;
    count++;
  }
  return count === 1 ? match : null;
}

interface EventEntry {
  node: ResourceNode;
  targets: Set<string>;
  busId: string | null;
  derivedFrom: string[];
  producerIds: Set<string>;
  /** AWS resources inferred to emit the event from its `aws.*` source. They
   * draw producer edges but vote on the engine only when nothing else does. */
  emitterIds: Set<string>;
  unconsumed: boolean;
}

/**
 * Which engine a derived event belongs to. No IaC file declares one, so it
 * inherits: its bus's engine when the bus has one, else the single engine its
 * producers and consumers agree on. Left unset when they disagree, mirroring
 * `groupByEngine`'s own rule for a stack container whose children disagree —
 * an arbitrary pick would put the event in the wrong box, which is worse than
 * leaving it loose.
 *
 * This is the multi-ENGINE counterpart to the `{Stack}/` prefix `eventNodeId`
 * keeps for multi-stack CFN, and exists for the same reason: to land the event
 * in its neighbours' container. Load-bearing for layout, not cosmetic.
 * `groupByEngine` only sweeps nodes carrying `.engine`, so without this the
 * event is left parentless beside the engine containers; its edges then cross
 * a container boundary, which keeps that cluster compound rather than
 * extracted (mermaid's `extractor` skips a cluster with `externalConnections`),
 * and dagre's compound ordering cannot interleave a non-member into a
 * cluster's rank. The event is therefore exiled past the container's entire
 * width instead of sitting beside it — on the multi-engine graph that surfaced
 * this, 2,270px from the consumer it fed. That figure is one observation, not
 * an invariant; `layoutGraph.test.ts`'s own fixture is what actually holds the
 * geometry.
 *
 * The bus outranks the vote, and not only by symmetry with `eventNodeId`: the
 * two rules have to AGREE. A bus id carrying a stack prefix already puts the
 * event in that bus's stack container via `groupByStack`, and `groupByEngine`
 * then infers that container's engine from its children. A consumers-first
 * rule could hand the event an engine its stack siblings disagree with, which
 * drives that inference to `null` and orphans the whole stack container from
 * every engine box. Deciding both from the same bus makes that unreachable.
 *
 * Ignores a neighbour with no `engine` of its own rather than treating it as a
 * disagreement: `engine` is only stamped on a multi-engine parse, and on one
 * of those every real node carries it, so an absent value means "not
 * applicable", never "a different engine".
 *
 * Skips `absorbed` ids, so the vote is taken over exactly the neighbours that
 * survive into the graph — the same set the emit loop below keeps. `absorbed`
 * and `targets` really do overlap: a second Service Bus rule on one
 * subscription reaches the first's `targets` via `consumersOf` while being
 * absorbed by its own derivation.
 *
 * Counting one is wrong in BOTH directions, which is why the filter is not
 * merely tidiness. As the only engine-carrying voter it supplies the stamp
 * outright, branding the event with a node this same pass deletes. Alongside a
 * surviving voter of a DIFFERENT engine it instead vetoes the one that is
 * there, and a well-formed event silently loses its container.
 */
function resolveEventEngine(
  entry: EventEntry,
  nodesById: Map<string, ResourceNode>,
  absorbed: ReadonlySet<string>,
): IacEngine | undefined {
  const busEngine = entry.busId ? nodesById.get(entry.busId)?.engine : undefined;
  if (busEngine) return busEngine;
  const voted = voteEngine([...entry.targets, ...entry.producerIds], nodesById, absorbed);
  if (voted !== null) return voted;
  return voteEngine(entry.emitterIds, nodesById, absorbed) ?? undefined;
}

/** The engine the voters agree on; `undefined` when they disagree, `null`
 * when none of them carries one. */
function voteEngine(
  ids: Iterable<string>,
  nodesById: Map<string, ResourceNode>,
  absorbed: ReadonlySet<string>,
): IacEngine | undefined | null {
  let engine: IacEngine | null = null;
  for (const id of ids) {
    if (absorbed.has(id)) continue;
    const candidate = nodesById.get(id)?.engine;
    if (!candidate) continue;
    if (engine === null) engine = candidate;
    else if (engine !== candidate) return undefined;
  }
  return engine;
}

/** Which deriver reads a consumer node, by the resource type each parser emits. */
const DERIVER_BY_TYPE: ReadonlyMap<string, Deriver> = new Map<string, Deriver>([
  ["AWS::Events::Rule", deriveFromCfnRule],
  ["aws_cloudwatch_event_rule", deriveFromTfRule],
  ["aws:cloudwatch/eventRule:EventRule", deriveFromTfRule],
  ["AWS::SNS::Subscription", deriveFromSnsSubscription],
  ["aws_sns_topic_subscription", deriveFromSnsSubscription],
  ["aws:sns/topicSubscription:TopicSubscription", deriveFromSnsSubscription],
  ["google_pubsub_subscription", deriveFromPubsubSubscription],
  ["google_eventarc_trigger", deriveFromEventarcTrigger],
  ["azurerm_eventgrid_event_subscription", deriveFromEventGridSubscription],
  ["azurerm_servicebus_subscription_rule", deriveFromServiceBusRule],
  ["Microsoft.ServiceBus/namespaces/topics/subscriptions/rules", deriveFromServiceBusRule],
]);

/** ARM nests an Event Grid subscription under its scope, so its type is a family.
 * `unknown` because a stored graph can predate the parser guard that keeps a
 * Type-less CloudFormation resource out (#1434). */
function deriverFor(resourceType: unknown): Deriver | undefined {
  if (typeof resourceType !== "string") return undefined;
  const exact = DERIVER_BY_TYPE.get(resourceType);
  if (exact) return exact;
  return resourceType.startsWith("Microsoft.EventGrid/") &&
    resourceType.endsWith("/eventSubscriptions")
    ? deriveFromEventGridSubscription
    : undefined;
}

/**
 * Display-time pass: lift EventBridge rule patterns, SNS subscription filter
 * policies, GCP Pub/Sub subscription filters, GCP Eventarc trigger matching
 * criteria, Azure Event Grid subscription event types, and Azure Service Bus
 * subscription-rule filters into first-class event nodes. One node per event
 * type per bus/topic; the
 * rule/subscription plumbing node is absorbed and its edges replaced by
 * bus/topic -> event -> consumer EVENT_FLOW edges.
 * Pure; returns the input unchanged when nothing is derivable.
 */
export function extractEventFlows(graph: ArchGraph): ArchGraph {
  if (!hasGraphArrays(graph)) return graph;
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const neighbors = buildNeighborIndex(graph.edges);
  const containsParent = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.type === EdgeType.CONTAINS) containsParent.set(e.target, e.source);
  }
  const nodesById = new Map<string, ResourceNode>();
  for (const node of graph.nodes) nodesById.set(node.id, node);
  const subTopicOf = (subId: string): string | null => {
    const subNode = nodesById.get(subId);
    if (subNode && subNode.resourceType === "azurerm_servicebus_subscription") {
      return resolveTfRef(subNode.attributes.topic_id);
    }
    return containsParent.get(subId) ?? null;
  };
  const pubsubTopics = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.type === ResourceType.GCP_PUBSUB_TOPIC) {
      pubsubTopics.set(node.name, node.id);
      pubsubTopics.set(node.id, node.id);
    }
  }
  const eventBuses = new Map<string, string | null>();
  for (const node of graph.nodes) {
    if (node.type !== ResourceType.EVENTBRIDGE_BUS) continue;
    eventBuses.set(node.name, eventBuses.has(node.name) ? null : node.id);
  }
  const derived: DerivedEvent[] = [];

  const targetsByRule = new Map<string, { targetIds: string[]; absorbedIds: string[] }>();
  for (const node of graph.nodes) {
    if (node.resourceType === "aws_cloudwatch_event_target") {
      const ruleId = resolveTfRef(node.attributes.rule);
      const targetId = resolveTfRef(node.attributes.arn);
      if (!ruleId) continue;
      let entry = targetsByRule.get(ruleId);
      if (!entry) {
        entry = { targetIds: [], absorbedIds: [] };
        targetsByRule.set(ruleId, entry);
      }
      entry.absorbedIds.push(node.id);
      if (targetId && nodeIds.has(targetId)) entry.targetIds.push(targetId);
    }
    if (node.resourceType === "aws:cloudwatch/eventTarget:EventTarget") {
      const ruleId = soleNeighborOfType(
        node.id,
        ResourceType.EVENTBRIDGE_RULE,
        neighbors,
        nodesById,
      );
      if (!ruleId) continue;
      let entry = targetsByRule.get(ruleId);
      if (!entry) {
        entry = { targetIds: [], absorbedIds: [] };
        targetsByRule.set(ruleId, entry);
      }
      entry.absorbedIds.push(node.id);
      const arnRef = typeof node.attributes.arn === "string" ? node.attributes.arn : null;
      if (arnRef && nodeIds.has(arnRef)) entry.targetIds.push(arnRef);
      else {
        for (const nb of neighbors.get(node.id) ?? []) {
          if (nb !== ruleId) entry.targetIds.push(nb);
        }
      }
    }
  }

  const ctx: DeriveContext = {
    nodeIds,
    neighbors,
    nodesById,
    targetsByRule,
    eventBuses,
    pubsubTopics,
    containsParent,
    subTopicOf,
  };
  for (const node of graph.nodes) {
    const derive = deriverFor(node.resourceType);
    if (derive) derived.push(...derive(node, ctx));
  }

  const publishFacts = collectPublishFacts(graph.nodes);
  if (derived.length === 0 && publishFacts.length === 0) return graph;

  const schemaByTail = buildSchemaByTail(graph.nodes);
  const consumeFacts = collectConsumeFacts(graph.nodes);

  // Merge by event node id; absorb plumbing nodes.
  const events = new Map<string, EventEntry>();
  const absorbed = new Set<string>();
  for (const d of derived) {
    for (const id of d.absorbedIds) absorbed.add(id);
    const eventId = eventNodeId(d.busId, d.name);
    let entry = events.get(eventId);
    if (!entry) {
      entry = {
        node: {
          id: eventId,
          type: ResourceType.EVENT_TYPE,
          // First derivation for this event id decides the provider.
          provider: d.provider,
          name: d.name,
          resourceType: "arcsync:event",
          attributes: { ...d.attributes, derivedFrom: [] as string[] },
        },
        targets: new Set(),
        busId: d.busId,
        derivedFrom: [],
        producerIds: new Set(),
        emitterIds: new Set(),
        unconsumed: false,
      };
      events.set(eventId, entry);
    }
    for (const t of d.targets) entry.targets.add(t);
    entry.derivedFrom.push(d.derivedFrom);
    // Per derivation, not per merged entry: only the first derivation's
    // attributes survive the merge. A source-named event reads its own source,
    // since each sibling split off a multi-source rule keeps the whole pattern.
    const own = d.attributes.source;
    const pattern = d.attributes.pattern as Record<string, unknown> | undefined;
    const sources = typeof own === "string" ? [own] : (stringValues(pattern?.source) ?? []);
    for (const source of sources) {
      const emitterType = AWS_SOURCE_EMITTERS.get(source);
      if (!emitterType) continue;
      for (const n of graph.nodes) {
        if (n.type === emitterType) entry.emitterIds.add(n.id);
      }
    }
  }

  // Same-named events for the busless single-candidate scan below, kept in
  // step as producer facts add entries, so each fact does not rescan the map.
  const sameName = new Map<string, EventEntry[]>();
  const indexByName = (e: EventEntry) => {
    const list = sameName.get(e.node.name);
    if (list) list.push(e);
    else sameName.set(e.node.name, [e]);
  };
  for (const e of events.values()) indexByName(e);

  // Producer pass: join publish facts to existing (consumer- or
  // producer-derived) events by bus+name, or by name alone when the busRef
  // is absent/unresolved and exactly one same-named event exists. No match
  // creates an "unconsumed" event; a name-ambiguous busless fact derives
  // nothing rather than guessing which event it feeds.
  // Stable partition: resolve bus-refs up front and process bus-resolved
  // facts first, so a same-named busless fact's single-candidate scan (below)
  // finds the bus-keyed entry instead of creating a second "event:default:"
  // one. Keying rules are unchanged — only processing order.
  const withResolvedBus = publishFacts.map((fact) => ({
    fact,
    resolvedBusId: fact.busRef ? resolveBusRef(fact.busRef, fact.fnId, nodeIds, nodesById) : null,
  }));
  const orderedFacts = [
    ...withResolvedBus.filter((f) => f.resolvedBusId),
    ...withResolvedBus.filter((f) => !f.resolvedBusId),
  ];

  for (const { fact, resolvedBusId } of orderedFacts) {
    let entry: EventEntry | undefined;
    let joinBusId: string | null = resolvedBusId;
    if (resolvedBusId) {
      entry = events.get(eventNodeId(resolvedBusId, fact.eventName));
    } else {
      const candidates = sameName.get(fact.eventName) ?? [];
      if (candidates.length > 1) continue;
      if (candidates.length === 1) {
        entry = candidates[0];
        joinBusId = entry.busId;
      } else {
        joinBusId = null;
      }
    }

    if (!entry) {
      const eventId = eventNodeId(joinBusId, fact.eventName);
      entry = {
        node: {
          id: eventId,
          type: ResourceType.EVENT_TYPE,
          provider: derivedProviderOf(joinBusId ? nodesById.get(joinBusId) : undefined),
          name: fact.eventName,
          resourceType: "arcsync:event",
          attributes: { eventType: fact.eventName, unconsumed: true, derivedFrom: [] as string[] },
        },
        targets: new Set(),
        busId: joinBusId,
        derivedFrom: [],
        producerIds: new Set(),
        emitterIds: new Set(),
        unconsumed: true,
      };
      events.set(eventId, entry);
      indexByName(entry);
    }

    entry.producerIds.add(fact.fnId);
    if (fact.payloadShape) {
      const detailType = entry.node.attributes.detailType;
      const schemaWins = typeof detailType === "string" && schemaByTail.has(detailType);
      if (!schemaWins) entry.node.attributes.payload = fact.payloadShape;
    }
  }

  const nodes = graph.nodes.filter((n) => !absorbed.has(n.id));
  const edges: ResourceEdge[] = graph.edges.filter(
    (e) => !absorbed.has(e.source) && !absorbed.has(e.target),
  );
  // Resolved for every event before the loop: whether an untagged shape may
  // label THIS event depends on how many OTHER events also reach it.
  const consumerPayloads = resolveConsumerPayloads(
    [...events.values()].map((e) => ({ id: e.node.id, name: e.node.name, targets: e.targets })),
    consumeFacts,
    neighbors,
  );
  let counter = 0;
  for (const entry of events.values()) {
    entry.node.attributes.derivedFrom = entry.derivedFrom;
    const detailType = entry.node.attributes.detailType;
    if (typeof detailType === "string" && schemaByTail.has(detailType)) {
      entry.node.attributes.schema = schemaByTail.get(detailType);
    }
    // Last resort, and deliberately so. A registry schema is declared; a
    // producer's shape is what actually gets sent; a consumer's type is only
    // what one reader expects to receive. It is also, for most codebases, the
    // only one of the three that exists.
    if (entry.node.attributes.payload === undefined && entry.node.attributes.schema === undefined) {
      const consumed = consumerPayloads.get(entry.node.id);
      if (consumed) entry.node.attributes.payload = consumed;
    }
    const engine = resolveEventEngine(entry, nodesById, absorbed);
    if (engine) entry.node.engine = engine;
    nodes.push(entry.node);
    if (entry.busId) {
      counter++;
      edges.push(
        entry.unconsumed
          ? {
              id: `event-flow-${counter}`,
              source: entry.node.id,
              target: entry.busId,
              type: EdgeType.EVENT_FLOW,
            }
          : {
              id: `event-flow-${counter}`,
              source: entry.busId,
              target: entry.node.id,
              type: EdgeType.EVENT_FLOW,
            },
      );
    }
    for (const target of entry.targets) {
      if (absorbed.has(target)) continue;
      counter++;
      edges.push({
        id: `event-flow-${counter}`,
        source: entry.node.id,
        target,
        type: EdgeType.EVENT_FLOW,
      });
    }
    for (const producerId of new Set([...entry.producerIds, ...entry.emitterIds])) {
      if (absorbed.has(producerId)) continue;
      counter++;
      edges.push({
        id: `event-flow-${counter}`,
        source: producerId,
        target: entry.node.id,
        type: EdgeType.EVENT_FLOW,
      });
    }
  }

  return { ...graph, nodes, edges };
}
