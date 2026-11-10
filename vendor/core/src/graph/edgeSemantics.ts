import { classifyLabel, DATA_STORE_TYPES, MESSAGING_TYPES } from "./analyzeAccessPatterns.js";
import { lookupByType } from "./typeLookup.js";
import type { NetworkGlueKind, ResourceEdge, ResourceNode } from "./types.js";
import { EdgeType, ResourceType } from "./types.js";

/**
 * What a drawn edge *is*, as opposed to which way it points.
 *
 * The four kinds are mutually exclusive and each one owns a complete visual
 * treatment — dash pattern, arrowhead shape, stroke weight and whether it may
 * animate. All four stay distinguishable with the animation dropped (reduced
 * motion, or a thumbnail, which never animates), which is what makes the drift
 * safe to switch off wholesale: the one kind that animates is also the only
 * dashed-and-headed one.
 *
 * Note what that does NOT claim. `sync` and `data` are separated by the
 * arrowhead alone — filled against open — so an export that flattened head
 * shapes would merge them. That is the design's own choice (the head is how it
 * distinguishes "something is called" from "something is read"), not an
 * oversight, but it is a single point of failure and worth knowing before
 * adding a fifth kind.
 *
 * Scope: grants resolve on all three clouds (`GRANT_TYPES` carries the GCP and
 * Azure equivalents), but `data` and `async` are recognised through
 * `DATA_STORE_TYPES` and `MESSAGING_TYPES`, which are AWS-only today. So on a
 * GCP or Azure diagram a bucket write or a Pub/Sub hop falls through to `sync`.
 * Widening those two sets is the fix, and deliberately not done here: they are
 * shared with `analyzeAccessPatterns`' direction inference, so a change there
 * moves arrowheads on AWS diagrams too.
 *
 * `containment` is here for exhaustiveness only: both renderers skip
 * `EdgeType.CONTAINS` before they ever ask, because membership is drawn as the
 * container's own frame rather than as a line.
 */
export type EdgeSemanticKind = "sync" | "async" | "data" | "grant" | "containment";

/** How an edge terminates. `open` is a stroked chevron, `filled` a solid
 * triangle, `none` draws nothing — a grant has no direction of travel because
 * nothing travels along it. */
export type EdgeArrowStyle = "filled" | "open" | "none";

export interface EdgeKindStyle {
  /** `strokeDashArray`, or `undefined` for a solid line. Scene units at zoom 1,
   * which is also how both renderers already spell their dashes. */
  dash: number[] | undefined;
  /** Round caps turn a short dash into a dot, which is what separates a grant's
   * `0.5 5` from an async edge's `3 7` at small sizes. */
  roundCap: boolean;
  arrow: EdgeArrowStyle;
  /** Multiplier on the renderer's base edge weight. A grant recedes. */
  weight: number;
  /** Only an async edge drifts. Advisory: a renderer that cannot animate (the
   * thumbnail) ignores it, and so does a viewer with reduced motion. */
  animates: boolean;
}

export const EDGE_KIND_STYLE: Record<EdgeSemanticKind, EdgeKindStyle> = {
  sync: { dash: undefined, roundCap: false, arrow: "filled", weight: 1, animates: false },
  async: { dash: [3, 7], roundCap: true, arrow: "filled", weight: 1, animates: true },
  data: { dash: undefined, roundCap: false, arrow: "open", weight: 1, animates: false },
  grant: { dash: [0.5, 5], roundCap: true, arrow: "none", weight: 0.85, animates: false },
  containment: { dash: [3, 3], roundCap: false, arrow: "none", weight: 1, animates: false },
};

/**
 * The open chevron's path, apex UP at angle 0 so it shares fabric's own
 * `Triangle` orientation and both renderers can aim either head with the same
 * `angle + 90`. Lives here, not in each renderer, because the two had already
 * drifted apart on the stroke weight the first time they were written
 * separately.
 */
export function openArrowheadPath(size: number): string {
  const h = size / 2;
  return `M ${-h} ${h} L 0 ${-h} L ${h} ${h}`;
}

/** The chevron's stroke weight for a given head size — thin enough to read as
 * an outline against the filled triangle it contrasts with. */
export function openArrowheadWidth(size: number): number {
  return size / 8;
}

/**
 * Where a source-hue → target-hue stroke gradient starts and ends, for an edge
 * drawn along `points`.
 *
 * These are `pixels`-space coords measured from the polyline's own bounding-box
 * corner — the space fabric resolves a stroke gradient in, identically for a
 * `Line` and a `Path`. A caller MUST pair them with `gradientUnits: "pixels"`:
 * `"percentage"` is accepted without complaint and then draws nothing at all,
 * measured against fabric 7.4.0, which on the thumbnail renderer means an edge
 * silently vanishing from the PNG.
 *
 * The origin is the box over ALL points, not over the two endpoints, because
 * that is the box fabric measures against once a waypoint sits outside them.
 *
 * On a curve the box is taken from the waypoints rather than from the drawn
 * spline, which stays inside their hull, so the gradient's phase can be a few
 * pixels out on a bezier. Invisible in a two-stop blend, and what the blend
 * encodes — which category each END is — is still stated exactly.
 *
 * `null` when there is no line to lay a gradient along; the caller falls back
 * to a flat stroke. Lives here rather than in each renderer for the reason
 * `openArrowheadPath` does: two copies of geometry drift, and this half drifts
 * invisibly — a gradient whose origin has moved still renders a plausible edge
 * in both places.
 */
export function edgeGradientCoords(
  points: Array<{ x: number; y: number }>,
): { x1: number; y1: number; x2: number; y2: number } | null {
  if (points.length < 2) return null;

  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const first = points[0];
  const last = points[points.length - 1];

  return {
    x1: first.x - minX,
    y1: first.y - minY,
    x2: last.x - minX,
    y2: last.y - minY,
  };
}

/** One drift cycle, shared by every animating edge so a chain of async hops
 * reads as a chain rather than a swarm racing each other. */
export const EDGE_DRIFT_PERIOD_MS = 1600;

/** How far the dash pattern travels in one cycle. Equal to the sum of the
 * `async` dash, so a cycle advances the pattern by exactly one period and the
 * loop point is invisible. */
export const EDGE_DRIFT_DISTANCE = 10;

/** A grant is the one kind that does not inherit its endpoints' hue: it is
 * flat, so the eye finds every permission line in a diagram at once. */
export const GRANT_EDGE_COLOR = { light: "#9333ea", dark: "#c084fc" } as const;

/**
 * Resource types that *hold* a permission rather than participate in a data or
 * control path. An edge touching one of these is a grant.
 *
 * Security groups are here even though `resourceCategory` files them under
 * networking: an SG→service edge states what the service is allowed to accept,
 * which is the same claim an IAM role makes. The category drives the node's
 * own colour and the legend, and neither moves — only the edge is reclassified.
 *
 * MOST OF THIS SET NEVER REACHES A RENDERER. `displayFilter`'s `HIDDEN_TYPES`
 * strips the identity types — `IAM_ROLE`, `IAM_POLICY`, the GCP IAM bindings
 * and service accounts, `AZURE_ROLE_ASSIGNMENT`, `AZURE_USER_IDENTITY` — and
 * their incident edges at every display boundary (API reads, canvas, Mermaid,
 * thumbnail). So the grant kind is DRAWN only for the three types that survive
 * that filter: `EC2_SECURITY_GROUP`, `GCP_COMPUTE_FIREWALL` and `AZURE_NSG`.
 *
 * The identity entries are kept anyway, because this classifier is a pure
 * function callable on an unfiltered graph (the account export keeps those
 * nodes, and the browser specs set `.graph` directly). But anyone adding an
 * eleventh entry should check `HIDDEN_TYPES` first, or it will change nothing
 * anyone can see.
 */
const GRANT_TYPES = new Set<ResourceType>([
  ResourceType.IAM_ROLE,
  ResourceType.IAM_POLICY,
  ResourceType.EC2_SECURITY_GROUP,
  ResourceType.GCP_IAM_BINDING,
  ResourceType.GCP_IAM_MEMBER,
  ResourceType.GCP_SERVICE_ACCOUNT,
  ResourceType.GCP_COMPUTE_FIREWALL,
  ResourceType.AZURE_ROLE_ASSIGNMENT,
  ResourceType.AZURE_USER_IDENTITY,
  // The Azure twin of `EC2_SECURITY_GROUP`, and here for the same reason: an
  // NSG→VM edge states what the VM is allowed to accept.
  ResourceType.AZURE_NSG,
]);

/**
 * The verb a `foldNetworkGlue`-minted edge carries, by the join it replaced.
 *
 * Lives here rather than in the fold pass because this is the file that owns
 * the grammar, and because the dependency has to point this way: `edgeSemantics`
 * is imported by both renderers on the draw path, so importing the fold pass
 * back would pull it into every bundle that only wants to classify an edge.
 *
 * A route composes its destination onto `routes` at mint time (`routes
 * 0.0.0.0/0`) and carries the result on `ResourceEdge.label`; the bare word
 * here is what a route with no spelled-out destination falls back to.
 */
export const FOLD_VERBS: Record<NetworkGlueKind, string> = {
  routeTableAssociation: "routes via",
  route: "routes",
  gatewayAttachment: "attaches",
  securityGroupRule: "connects",
  listener: "forwards",
};

/** Sources whose outbound edge has a name the topology alone establishes. */
const SOURCE_VERBS: Partial<Record<ResourceType, string>> = {
  [ResourceType.ROUTE53_RECORD]: "resolves",
  [ResourceType.ROUTE53_ZONE]: "resolves",
  [ResourceType.CLOUDFRONT_DISTRIBUTION]: "forwards",
  [ResourceType.ELB_LOAD_BALANCER]: "routes",
};

/**
 * Targets an edge can honestly be said to INVOKE.
 *
 * Narrower than the `compute` category, which also holds things an edge reaches
 * for reasons that are not calls. Every CLUSTER is excluded on one rule: an
 * edge to a cluster is a membership claim, not a call — `ECS_CLUSTER` and
 * `EKS_CLUSTER` alike, the latter because a node group or service referencing
 * its cluster is exactly the same shape. `ECS_TASK_DEFINITION` is
 * configuration, and `SFN_STATE` is a transition (labelling every one of them
 * would bury the state rail). Naming any of those "invokes" would assert a call
 * the graph never established.
 *
 * The three clouds are kept in step deliberately — an asymmetry here reads as a
 * missing entry rather than as a rule.
 */
const INVOCABLE_TYPES = new Set<ResourceType>([
  ResourceType.LAMBDA_FUNCTION,
  ResourceType.ECS_SERVICE,
  ResourceType.EC2_INSTANCE,
  ResourceType.APPSYNC_API,
  ResourceType.SFN_STATE_MACHINE,
  ResourceType.GCP_CLOUD_FUNCTION,
  ResourceType.GCP_CLOUD_RUN_SERVICE,
  ResourceType.GCP_COMPUTE_INSTANCE,
  ResourceType.GCP_APP_ENGINE,
  ResourceType.AZURE_FUNCTION_APP,
  ResourceType.AZURE_APP_SERVICE,
  ResourceType.AZURE_CONTAINER_GROUP,
  // All three VM spellings: `azurerm_virtual_machine` is the generic one, and
  // omitting it while listing the Linux/Windows pair is exactly the "missing
  // entry" the note above says not to leave.
  ResourceType.AZURE_VIRTUAL_MACHINE,
  ResourceType.AZURE_LINUX_VM,
  ResourceType.AZURE_WINDOWS_VM,
]);

/** Stores you query rather than read or write wholesale. Used only as the
 * fallback verb when nothing classified the access. */
const QUERYABLE_TYPES = new Set<ResourceType>([
  ResourceType.RDS_INSTANCE,
  ResourceType.RDS_CLUSTER,
  ResourceType.REDSHIFT_CLUSTER,
  ResourceType.OPENSEARCH_DOMAIN,
]);

export interface EdgeSemantics {
  kind: EdgeSemanticKind;
  /**
   * The relationship, named — `allows`, `publishes`, `writes`.
   *
   * Absent whenever the graph does not actually establish one. A generic
   * reference between two resources we know nothing else about gets no verb
   * rather than a filler like "references": the label's whole value is that it
   * says something true, and a word that means "these are related somehow" is
   * noise that reads as precision.
   */
  verb?: string;
}

function isGrant(node: ResourceNode | undefined): boolean {
  return node != null && GRANT_TYPES.has(node.type);
}

function accessVerb(edge: ResourceEdge, target: ResourceNode | undefined): string | undefined {
  // The model's own label, where a parser or `analyzeAccessPatterns` derived
  // one from IAM actions or handler source. Rendered with the interpunct the
  // grammar uses for a compound verb.
  const classified = edge.label ? classifyLabel(edge.label) : null;
  if (classified === "read") return "reads";
  if (classified === "write") return "writes";
  if (classified === "read_write") return "reads · writes";
  if (target && QUERYABLE_TYPES.has(target.type)) return "queries";
  return undefined;
}

/** Whether a broker sits on this end of the edge. There is one set, not two:
 * "delivers to a consumer" and "is published into" are the same resources seen
 * from opposite ends, and which end is what decides the verb. */
function isBroker(node: ResourceNode | undefined): boolean {
  return node != null && MESSAGING_TYPES.has(node.type);
}

function asyncVerb(
  edge: ResourceEdge,
  source: ResourceNode | undefined,
  target: ResourceNode | undefined,
): string | undefined {
  // A topic feeding a queue is the fanout itself, not a plain publish.
  if (source?.type === ResourceType.SNS_TOPIC && target?.type === ResourceType.SQS_QUEUE) {
    return "fans out";
  }

  if (isBroker(target)) {
    // `analyzeAccessPatterns` flips a consumer to `reverse` — a λ whose handler
    // calls ReceiveMessage rather than SendMessage. It does not publish, so
    // saying so would be false about what the code does.
    //
    // The verb stays MODEL-relative, i.e. its subject is `edge.source` (the λ),
    // not the tail of the drawn arrow — the same convention `accessVerb` uses
    // when it says "reads" on a store edge that direction has likewise
    // flipped. Reading it against the arrowhead instead would want "triggers",
    // which is what an AUTHORED queue→λ edge already gets below.
    return edge.direction === "reverse" ? "consumes" : "publishes";
  }
  if (isBroker(source)) return "triggers";
  return undefined;
}

function syncVerb(
  edge: ResourceEdge,
  source: ResourceNode | undefined,
  target: ResourceNode | undefined,
): string | undefined {
  // FIRST, above `SOURCE_VERBS`: a dependency is a deployment ordering
  // constraint, not a call — the ARM parser mints one for every `dependsOn`,
  // and a NIC does not invoke the VM it is ordered before. Below the table it
  // would still have named a Route53/CloudFront/ELB-sourced dependency, which
  // no parser emits today but which contradicts the rule either way.
  if (edge.type === EdgeType.DEPENDENCY) return undefined;
  if (source) {
    const named = lookupByType(SOURCE_VERBS, source.type);
    if (named) return named;
  }
  return target && INVOCABLE_TYPES.has(target.type) ? "invokes" : undefined;
}

/**
 * Classify one edge into the drawn grammar.
 *
 * Endpoints are optional so a caller holding a partially-resolved graph can
 * still ask; a missing endpoint only ever costs precision, never correctness —
 * the edge falls back to `sync` with no verb, which is what an untyped edge
 * already renders as today.
 *
 * Grants are recognised from their ENDPOINTS, never from `EdgeType.IAM`.
 * Despite the name, that type does not mean "a permission": `cfnParser` mints
 * it for the DATA-ACCESS edges it derives from IAM policy statements — a
 * λ→DynamoDB edge labelled `reads`/`writes`/`reads/writes` (see
 * `extractPendingDataAccessEdges`, and `foldEcsTopology`'s note saying the same).
 * Treating it as a grant painted the single most informative edge in a
 * CloudFormation diagram as a headless purple permission line. It falls through
 * to the data branch below instead, where its label becomes the verb.
 */
export function classifyEdgeSemantics(
  edge: ResourceEdge,
  source?: ResourceNode,
  target?: ResourceNode,
): EdgeSemantics {
  if (edge.type === EdgeType.CONTAINS) return { kind: "containment" };

  // FIRST, above every other branch. A folded edge is the one case where the
  // relationship is KNOWN rather than inferred: `foldNetworkGlue` read a join
  // resource that said, in the template's own words, what these two ends are to
  // each other. Every branch below is a heuristic over endpoint types, and on
  // this shape the heuristics are wrong — `PrivateRouteTable -> NatInstance`
  // hits `INVOCABLE_TYPES` and reads "invokes", which a route table does not
  // do.
  //
  // The kind stays `sync`. These edges are structural rather than calls, but
  // the grammar has no fifth kind and adding one costs the head-shape single
  // point of failure this file's header documents. A `topology` kind, if it is
  // ever wanted, should differ by DASH, not by head.
  if (edge.viaFold) {
    return { kind: "sync", verb: edge.label ?? FOLD_VERBS[edge.viaFold] };
  }

  if (isGrant(source) || isGrant(target)) {
    return { kind: "grant", verb: "allows" };
  }

  const touchesBroker = isBroker(source) || isBroker(target);
  if (edge.type === EdgeType.EVENT_FLOW || touchesBroker) {
    return { kind: "async", verb: asyncVerb(edge, source, target) };
  }

  // Direction is what says which end is the store: `analyzeAccessPatterns`
  // flips a pure read to `reverse`, so a read from a table is still an edge
  // between a consumer and a store whichever way it was authored.
  const store = target != null && DATA_STORE_TYPES.has(target.type) ? target : undefined;
  const reverseStore = source != null && DATA_STORE_TYPES.has(source.type) ? source : undefined;
  if (store || reverseStore) {
    return { kind: "data", verb: accessVerb(edge, store ?? reverseStore) };
  }

  return { kind: "sync", verb: syncVerb(edge, source, target) };
}
