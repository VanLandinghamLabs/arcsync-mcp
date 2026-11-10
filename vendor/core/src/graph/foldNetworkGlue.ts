import { FOLD_VERBS } from "./edgeSemantics.js";
import {
  fallbackRailFor,
  namesNode,
  railLabelFor,
  readAttribute,
  readAttributeEntry,
  readString,
  referenceToken,
} from "./fallbackRail.js";
import { lookupByType } from "./typeLookup.js";
import type {
  ArchGraph,
  FallbackRail,
  NetworkGlueKind,
  ResourceEdge,
  ResourceNode,
} from "./types.js";
import { EdgeType, ResourceType } from "./types.js";

/**
 * Folds a networking "join" resource into the node that owns it.
 *
 * A VPC template built by hand or by CDK emits roughly nine of these per
 * NAT-instance VPC — `SubnetRouteTableAssociation`, `Route`,
 * `VPCGatewayAttachment`, `InstanceProfile`. None of them is a thing anyone
 * deploys FOR itself: each exists to state a relationship between two resources
 * that are already on the diagram. Drawn as nodes they cost a card plus two
 * edges to say what one labelled edge says, and they push the resources that
 * matter apart to make room.
 *
 * So the pass removes the join and draws the relationship it encoded:
 *
 * - a subnet's route-table association becomes a `Subnet -> RouteTable` edge
 *   verbed `routes via`;
 * - a route becomes a `ROUTE` rail on its table plus a `RouteTable -> target`
 *   edge verbed `routes 0.0.0.0/0`;
 * - a gateway attachment becomes a `VPC -> gateway` edge verbed `attaches`;
 * - an instance profile becomes a `PROFILE` rail on its instance.
 *
 * Display-time only, exactly like `foldFallbackNodes` and `collapseRouteTables`:
 * it never writes the canonical stored graph, and the marker it leaves on an
 * edge (`viaFold`) is unpersisted.
 *
 * WHAT IT KEYS ON, and why that is not `attributes`. `foldFallbackNodes` reads
 * the parent's attribute bag because a dead-letter queue is named INSIDE a
 * `redrive_policy` blob that no parser turns into an edge. A join resource is
 * the opposite shape: its whole content is references (`RouteTableId`,
 * `SubnetId`, `VpcId`, `GatewayId`), and every parser already turns each of
 * those into a real reference EDGE. Reading the edges therefore covers strictly
 * more graphs than reading attributes would — the two plan formats that resolve
 * a reference to an ARN before `attributes` is built, and any graph whose
 * attribute bags were stripped (every `__layout_qa__` fixture, an anonymised
 * export) included. `attributes` is still read, for the CIDR and the lines a
 * rail expands to, but never to decide the fold.
 *
 * Which end of the join is the PARENT is decided by resource type — an
 * association is adjacent to exactly one route table and one subnet — so the
 * pass never has to guess from attribute key order.
 */

/** Route target properties, in the precedence order a route resolves them.
 * Normalized, so the CloudFormation (`GatewayId`), Terraform (`gateway_id`) and
 * Pulumi (`gatewayId`) spellings all collapse onto one entry. */
const ROUTE_TARGET_KEYS: readonly string[] = [
  "gatewayid",
  "instanceid",
  "natgatewayid",
  "transitgatewayid",
  "vpcpeeringconnectionid",
  "networkinterfaceid",
];

/** Destination properties a route's verb and rail name are built from. IPv6 is
 * listed second so a dual-stack route reads as its IPv4 destination, which is
 * the one an operator recognises. */
const ROUTE_DESTINATION_KEYS: readonly string[] = [
  "destinationcidrblock",
  "destinationipv6cidrblock",
  "destinationprefixlistid",
];

/** Attribute keys an expanded `PROFILE` rail reports, in drawn order. */
const PROFILE_POLICY_KEYS: readonly string[] = ["roles", "path"];

/**
 * The four join types, and which treatment each gets. `instanceProfile` is the
 * one that is not a `NetworkGlueKind`: it mints no edge, so nothing ever
 * carries a `viaFold` marker for it.
 */
type GlueKind = NetworkGlueKind | "instanceProfile" | "networkAclEntry";

const GLUE_KIND_BY_TYPE: Partial<Record<ResourceType, GlueKind>> = {
  [ResourceType.EC2_ROUTE_TABLE_ASSOCIATION]: "routeTableAssociation",
  [ResourceType.EC2_ROUTE]: "route",
  [ResourceType.EC2_INTERNET_GATEWAY_ATTACHMENT]: "gatewayAttachment",
  [ResourceType.IAM_INSTANCE_PROFILE]: "instanceProfile",
};

/**
 * The same four joins, keyed off the RAW provider type string.
 *
 * Every one of these mapped to `ResourceType.UNKNOWN` until this change, and
 * `type` is what a stored graph persists — so on the tens of thousands of
 * graphs already in the table, and on every `__layout_qa__` fixture, the enum
 * above matches nothing. Reading the raw string as well is what makes the fold
 * fire on those retroactively instead of waiting for a re-parse, which is the
 * same trade `foldFallbackNodes` makes when it prefers an attribute walk over
 * its own parse-time `viaProperty` tag, and the same reason `displayFilter`
 * keys plumbing off `resourceType` rather than off the enum.
 *
 * Consulted only when `type` is `UNKNOWN`: a re-parsed graph is classified, and
 * a node the classifier gave a real type to must be trusted over a string match.
 */
const GLUE_KIND_BY_RESOURCE_TYPE: Readonly<Record<string, GlueKind>> = {
  "AWS::EC2::SubnetRouteTableAssociation": "routeTableAssociation",
  aws_route_table_association: "routeTableAssociation",
  "aws:ec2/routeTableAssociation:RouteTableAssociation": "routeTableAssociation",
  "AWS::EC2::Route": "route",
  aws_route: "route",
  "aws:ec2/route:Route": "route",
  "AWS::EC2::VPCGatewayAttachment": "gatewayAttachment",
  aws_internet_gateway_attachment: "gatewayAttachment",
  "aws:ec2/internetGatewayAttachment:InternetGatewayAttachment": "gatewayAttachment",
  "AWS::IAM::InstanceProfile": "instanceProfile",
  aws_iam_instance_profile: "instanceProfile",
  "aws:iam/instanceProfile:InstanceProfile": "instanceProfile",
  "AWS::EC2::SecurityGroupIngress": "securityGroupRule",
  "AWS::EC2::SecurityGroupEgress": "securityGroupRule",
  aws_security_group_rule: "securityGroupRule",
  aws_vpc_security_group_ingress_rule: "securityGroupRule",
  aws_vpc_security_group_egress_rule: "securityGroupRule",
  "aws:ec2/securityGroupRule:SecurityGroupRule": "securityGroupRule",
  "aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule": "securityGroupRule",
  "aws:vpc/securityGroupEgressRule:SecurityGroupEgressRule": "securityGroupRule",
  "AWS::ElasticLoadBalancingV2::Listener": "listener",
  aws_lb_listener: "listener",
  aws_alb_listener: "listener",
  "aws:lb/listener:Listener": "listener",
  "aws:alb/listener:Listener": "listener",
  "AWS::EC2::NetworkAclEntry": "networkAclEntry",
  aws_network_acl_rule: "networkAclEntry",
  "aws:ec2/networkAclRule:NetworkAclRule": "networkAclEntry",
  "aws-native:ec2:NetworkAclEntry": "networkAclEntry",
  "AWS::EC2::SubnetNetworkAclAssociation": "networkAclAssociation",
  aws_network_acl_association: "networkAclAssociation",
  "aws:ec2/networkAclAssociation:NetworkAclAssociation": "networkAclAssociation",
  "aws-native:ec2:SubnetNetworkAclAssociation": "networkAclAssociation",
};

/** A NACL as a graph stored before `EC2_NETWORK_ACL` existed spells it. */
const NETWORK_ACL_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "AWS::EC2::NetworkAcl",
  "aws_network_acl",
  "aws_default_network_acl",
  "aws:ec2/networkAcl:NetworkAcl",
  "aws:ec2/defaultNetworkAcl:DefaultNetworkAcl",
  "aws-native:ec2:NetworkAcl",
]);

function isNetworkAcl(node: ResourceNode): boolean {
  return (
    node.type === ResourceType.EC2_NETWORK_ACL ||
    (node.type === ResourceType.UNKNOWN && NETWORK_ACL_RESOURCE_TYPES.has(node.resourceType))
  );
}

/**
 * Which join `node` is, or `undefined` when it is not one.
 *
 * BOTH lookups are own-property guarded, including the one keyed on the enum.
 * `type` is a plain string on a rehydrated graph — it is cast, never validated
 * — so a stored node typed `constructor` or `toString` reads a prototype member
 * back, which is truthy and would be treated as a join whose parent type is
 * `undefined`, matching any type-less neighbour. Same class as the
 * prototype-pollution write closed in #1111, and why both go through
 * `lookupByType`.
 */
function glueKindOf(node: ResourceNode): GlueKind | undefined {
  const byType = lookupByType(GLUE_KIND_BY_TYPE, node.type);
  if (byType) return byType;
  if (node.type !== ResourceType.UNKNOWN) return undefined;
  return lookupByType(GLUE_KIND_BY_RESOURCE_TYPE, node.resourceType);
}

/** The type of node each kind folds INTO. A join adjacent to no node of its
 * parent type is left alone — classified, but unfolded. */
const PARENT_TYPE_BY_KIND: Record<GlueKind, ResourceType> = {
  routeTableAssociation: ResourceType.EC2_ROUTE_TABLE,
  route: ResourceType.EC2_ROUTE_TABLE,
  gatewayAttachment: ResourceType.EC2_VPC,
  instanceProfile: ResourceType.EC2_INSTANCE,
  securityGroupRule: ResourceType.EC2_SECURITY_GROUP,
  listener: ResourceType.ELB_LOAD_BALANCER,
  networkAclEntry: ResourceType.EC2_NETWORK_ACL,
  networkAclAssociation: ResourceType.EC2_NETWORK_ACL,
};

function isParentOf(kind: GlueKind, node: ResourceNode): boolean {
  const type = PARENT_TYPE_BY_KIND[kind];
  return type === ResourceType.EC2_NETWORK_ACL ? isNetworkAcl(node) : node.type === type;
}

/** Whether an edge participates in the "would folding strand anything?" test.
 * Containment is excluded for `foldFallbackNodes`' reason: a join's CONTAINS
 * edge from its stack goes with it, and counting it would block every fold in a
 * multi-stack graph. */
function isStructural(edge: ResourceEdge): boolean {
  return edge.type !== EdgeType.CONTAINS;
}

/** First attribute value under any of `wanted`, with the key AS THE PARSER
 * SPELLED IT — a rail line reads `DestinationCidrBlock 0.0.0.0/0` on a
 * CloudFormation graph and `destination_cidr_block 0.0.0.0/0` on a Terraform
 * one, which is what an operator greps their own source for. */
function attributeUnder(
  attributes: Record<string, unknown>,
  wanted: readonly string[],
): { key: string; value: unknown } | undefined {
  for (const want of wanted) {
    const found = readAttributeEntry(attributes, want);
    if (found) return found;
  }
  return undefined;
}

/**
 * An attribute value rendered for a rail line.
 *
 * A reference arrives as `{ Ref: "PublicRouteTable" }` (CloudFormation),
 * `${aws_internet_gateway.igw.id}` (Terraform) or an unknown-output sentinel (a
 * plan). Printing the raw JSON of any of those is worse than printing nothing,
 * so a non-scalar is reported through `fallbackName` — the resolved node's own
 * name, which the edge already established — and dropped when there is none.
 */
function railValue(value: unknown, fallbackName?: string): string | undefined {
  if (typeof value === "string") return value.startsWith("${") ? fallbackName : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => railValue(item, fallbackName)).filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : fallbackName;
  }
  return fallbackName;
}

/** Key for one ORDERED endpoint pair.
 *
 * Node ids come from IaC logical ids and resource addresses, which can contain
 * almost anything, so the separator is a character that cannot appear in one.
 * Built with `String.fromCharCode` rather than typed as a literal for the
 * reason `foldFallbackNodes`' `PATH_SEP` is: a raw NUL byte in a source file
 * survives every editor and review tool that renders it as nothing, and this
 * module shipped three of them before a test that split on the separator
 * noticed. */
const PAIR_SEP = String.fromCharCode(0);

function orderedPairKey(source: string, target: string): string {
  return `${source}${PAIR_SEP}${target}`;
}

/** Every join that resolved to one ordered pair, collapsed to the single edge
 * they are drawn as. */
interface MergedEdge {
  source: string;
  target: string;
  verb: string;
  /** Per-join detail, in fold order — a route's destination. Empty for the
   * kinds whose verb says everything (`routes via`, `attaches`). */
  details: string[];
  via: NetworkGlueKind;
  /** The first contributing join, which names the minted edge. */
  glueId: string;
}

/**
 * Destinations a merged label spells out before it starts counting.
 *
 * A dual-stack table is the common case at 2, and 3 covers one sending a couple
 * of named prefixes through a single NAT. Past that the label stops being a
 * label: a transit-gateway table with twenty CIDRs to one attachment would
 * compose a caption longer than the diagram is wide, and an unreadable caption
 * on the edge this pass exists to make readable is worse than the parallel
 * lines it replaced.
 *
 * The overflow reads `+N more`, the idiom the card footer already uses for its
 * property overflow, and every destination is still spelled out in full on the
 * table's own `ROUTE` rails.
 */
const MERGED_DETAIL_LIMIT = 3;

/** One merged pair's drawn caption. */
function mergedLabel(pair: MergedEdge): string {
  if (pair.details.length === 0) return pair.verb;
  if (pair.details.length <= MERGED_DETAIL_LIMIT) {
    return `${pair.verb} ${pair.details.join(", ")}`;
  }
  const shown = pair.details.slice(0, MERGED_DETAIL_LIMIT).join(", ");
  return `${pair.verb} ${shown} +${pair.details.length - MERGED_DETAIL_LIMIT} more`;
}

/** One end of a reference edge, seen from the join in the middle of it. */
interface Neighbour {
  edge: ResourceEdge;
  node: ResourceNode;
}

export interface FoldNetworkGlueOptions {
  /**
   * Parents whose joins the viewer has expanded back into nodes. Empty by
   * default — every eligible parent folds — so a diagram opens rolled up and
   * the set only ever records a deliberate expansion.
   */
  unfoldedParents?: ReadonlySet<string>;
  /**
   * Ids that must neither gain a rail nor gain a minted edge. Both callers pass
   * `routeTargetIds`, for `foldFallbackNodes`' reason plus one of this pass's
   * own: a chip qualified as a chip by having exactly ONE inbound source, so an
   * edge minted into one would silently disqualify it after the caller had
   * already committed to placing it.
   */
  skipParents?: ReadonlySet<string>;
}

/** One fold, resolved but not yet applied. */
interface Fold {
  glue: ResourceNode;
  kind: GlueKind;
  parent: ResourceNode;
  rail?: FallbackRail;
  /** A NACL entry's place in its table; see `naclEntryRail`. */
  order?: number;
  /** The edge to mint. Absent when the relationship is drawn as a rail only.
   *
   * `verb` is the bare relationship and `detail` the part that varies per join
   * — a route's destination. They are kept apart rather than composed here
   * because SEVERAL joins can resolve to the same ordered pair (a dual-stack
   * route table reaches its gateway twice; so does one that sends three CIDRs
   * through one NAT), and the pair gets ONE edge whose label carries every
   * destination. Composing at this point would leave the merge no way to say
   * `routes 0.0.0.0/0, ::/0` without re-parsing its own output. */
  mint?: { source: string; target: string; verb: string; detail?: string; via: NetworkGlueKind };
}

export function foldNetworkGlue(graph: ArchGraph, options?: FoldNetworkGlueOptions): ArchGraph {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  // Both directions: a route references its table, where a profile is
  // referenced BY its instance, and the pass must not care which way the parser
  // happened to point the reference.
  const neighbours = new Map<string, Neighbour[]>();
  const containerIds = new Set<string>();
  // A NACL's own `subnet_ids`/`subnetIds` reference, turned round so it reads
  // like the association resource it is the inline form of.
  const naclSubnetEdgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type === EdgeType.CONTAINS) {
      containerIds.add(edge.source);
      continue;
    }
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    if (
      isNetworkAcl(source) &&
      target.type === ResourceType.EC2_SUBNET &&
      isSubnetListEdge(source, target)
    ) {
      naclSubnetEdgeIds.add(edge.id);
    }
    const from = neighbours.get(edge.source);
    if (from) from.push({ edge, node: target });
    else neighbours.set(edge.source, [{ edge, node: target }]);
    const to = neighbours.get(edge.target);
    if (to) to.push({ edge, node: source });
    else neighbours.set(edge.target, [{ edge, node: source }]);
  }

  const folds: Fold[] = [];
  const foldedIds = new Set<string>();
  /** Eligible joins per parent, counted BEFORE `unfoldedParents` is consulted
   * — see `ResourceNode.networkGlue`. */
  const glueCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    const kind = glueKindOf(node);
    if (!kind) continue;
    // A join that somehow contains something is not a join. Folding it would
    // orphan its children exactly as `foldFallbackNodes` documents.
    if (containerIds.has(node.id)) continue;

    const structural = (neighbours.get(node.id) ?? []).filter((n) => isStructural(n.edge));
    const parent =
      kind === "securityGroupRule"
        ? securityGroupRuleOwner(node, structural)
        : structural.find((n) => isParentOf(kind, n.node))?.node;
    // Fold only into a parent that survived filtering. Otherwise the join stays
    // — classified, so it draws as a real networking card rather than a grey
    // one, but unfolded, because there is nothing left to fold it onto.
    if (!parent) continue;
    // A route table here is an API Gateway's collapsed table, whose box is
    // entirely header and rows with no strip below to draw a rail in — the same
    // refusal `foldFallbackNodes` makes.
    if (parent.routeTable) continue;
    if (options?.skipParents?.has(parent.id)) continue;

    const others = structural.filter((n) => n.node.id !== parent.id);
    // Would folding strand anything? A join reaches exactly its parent and, at
    // most, the one resource on the other end of the relationship. Anything
    // else — an authored `depends_on`, a second reference — is a claim this
    // pass has no verb for, so the node survives rather than lose it.
    if (others.length > 1) continue;
    const other = others[0]?.node;
    if (other && options?.skipParents?.has(other.id)) continue;

    const fold = resolveFold(node, kind, parent, other);
    if (!fold) continue;
    glueCounts.set(parent.id, (glueCounts.get(parent.id) ?? 0) + 1);
    // Expanded by the viewer: the join keeps its own card, and the parent still
    // gets the count so its control can offer to roll the joins back up.
    if (options?.unfoldedParents?.has(parent.id)) continue;
    folds.push(fold);
    foldedIds.add(node.id);
  }

  // Inline `ingress`/`egress` blocks on a Terraform or Pulumi NACL are entries
  // too. They are no node, so they draw as rows but are never counted as glue.
  for (const node of graph.nodes) {
    if (!isNetworkAcl(node) || options?.skipParents?.has(node.id)) continue;
    for (const key of ["ingress", "egress"]) {
      const blocks = readAttribute(node.attributes, key);
      if (!Array.isArray(blocks)) continue;
      blocks.forEach((block, i) => {
        if (!block || typeof block !== "object") return;
        const id = `${node.id}/${key}[${i}]`;
        const cidr = attributeUnder(block, NACL_CIDR_KEYS)?.value;
        const peer =
          cidr === undefined ? undefined : graph.nodes.find((n) => referenceNames(cidr, n));
        const entry = naclEntryRail({ id, name: id }, block, key === "egress", peer?.name);
        folds.push({ glue: node, kind: "networkAclEntry", parent: node, ...entry });
      });
    }
  }

  if (folds.length === 0 && glueCounts.size === 0 && naclSubnetEdgeIds.size === 0) return graph;

  // Rail order on a card: every ROUTE rail in template order, then PROFILE,
  // then whatever the later passes append. `folds` is already in node order,
  // and the two kinds are swept separately so a profile declared between two
  // routes cannot land between their rails. NACL entries alone are re-sorted:
  // their rule numbers, not the template, are the order AWS evaluates them in.
  const railsByParent = new Map<string, FallbackRail[]>();
  const kinds = ["route", "instanceProfile", "securityGroupRule", "listener", "networkAclEntry"];
  for (const kind of kinds) {
    const ofKind = folds.filter((fold) => fold.kind === kind && fold.rail);
    if (kind === "networkAclEntry") ofKind.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const fold of ofKind) {
      const rails = railsByParent.get(fold.parent.id);
      if (rails) rails.push(fold.rail as FallbackRail);
      else railsByParent.set(fold.parent.id, [fold.rail as FallbackRail]);
    }
  }

  const survivingEdges = graph.edges
    .filter((e) => !foldedIds.has(e.source) && !foldedIds.has(e.target))
    .map((e) =>
      naclSubnetEdgeIds.has(e.id)
        ? {
            ...e,
            source: e.target,
            target: e.source,
            label: FOLD_VERBS.networkAclAssociation,
            viaFold: "networkAclAssociation" as const,
          }
        : e,
    );
  const existingByPair = new Map<string, ResourceEdge>();
  for (const edge of survivingEdges) {
    if (edge.type === EdgeType.CONTAINS) continue;
    existingByPair.set(orderedPairKey(edge.source, edge.target), edge);
  }

  // ONE edge per ordered pair, however many joins resolved to it. A route table
  // reaches its gateway once per route — twice on a dual-stack table, three
  // times when three CIDRs share a NAT — and each of those is a line between
  // the same two boxes saying the same thing about a different destination.
  // Drawn as N parallel edges they read as N relationships; merged, the label
  // carries every destination, and the ROUTE rails still carry the rest.
  //
  // The merge has to happen BEFORE the authored-edge branch rather than inside
  // it, or the rule applies to whichever kind of edge the graph happens to
  // contain. That was the first version's bug, in both directions: with an
  // authored `DependsOn` between the pair, every fold overwrote the last one's
  // label and N-1 destinations vanished silently; without one, the same input
  // drew N parallel lines.
  const merged = new Map<string, MergedEdge>();
  for (const fold of folds) {
    if (!fold.mint) continue;
    const { source, target, verb, detail, via } = fold.mint;
    const key = orderedPairKey(source, target);
    // The reverse orientation is left exactly as it is. Its verb would read
    // backwards ("a route table routes via a subnet"), and minting alongside it
    // is the doubled line this whole block exists to avoid.
    if (!existingByPair.has(key) && existingByPair.has(orderedPairKey(target, source))) continue;
    const held = merged.get(key);
    if (!held) {
      const details = detail ? [detail] : [];
      merged.set(key, { source, target, verb, details, via, glueId: fold.glue.id });
      continue;
    }
    // Deduped: two routes spelling the same destination say it once.
    if (detail && !held.details.includes(detail)) held.details.push(detail);
  }

  const relabelled = new Map<string, { verb: string; via: NetworkGlueKind }>();
  const minted: ResourceEdge[] = [];
  for (const [key, pair] of merged) {
    const label = mergedLabel(pair);
    // An authored edge between the same pair is RE-LABELLED rather than
    // doubled: a `DependsOn` from a subnet to its route table already draws the
    // line the association would mint.
    const held = existingByPair.get(key);
    if (held) {
      relabelled.set(held.id, { verb: label, via: pair.via });
      continue;
    }
    minted.push({
      // Derived from the FIRST join that resolved to this pair, so the pass is
      // idempotent on ids and a re-render cannot mint a second edge for it.
      id: `fold-${pair.glueId}`,
      source: pair.source,
      target: pair.target,
      type: EdgeType.REFERENCE,
      label,
      viaFold: pair.via,
    });
  }

  return {
    ...graph,
    nodes: graph.nodes
      .filter((n) => !foldedIds.has(n.id))
      .map((n) => {
        const count = glueCounts.get(n.id);
        const rails = railsByParent.get(n.id);
        if (!count && !rails) return n;
        // Rails are appended, never replaced: `filterGraphForDisplay` stamps
        // LOGS rails upstream and `foldFallbackNodes` appends its own
        // downstream.
        return {
          ...n,
          ...(count ? { networkGlue: count } : {}),
          ...(rails ? { fallbackRails: [...(n.fallbackRails ?? []), ...rails] } : {}),
        };
      }),
    edges: [
      ...survivingEdges.map((e) => {
        const label = relabelled.get(e.id);
        return label ? { ...e, label: label.verb, viaFold: label.via } : e;
      }),
      ...minted,
    ],
  };
}

/** Build the rail and the minted edge for one resolved join, or `undefined`
 * when the join carries nothing worth drawing. */
function resolveFold(
  glue: ResourceNode,
  kind: GlueKind,
  parent: ResourceNode,
  other: ResourceNode | undefined,
): Fold | undefined {
  if (kind === "routeTableAssociation" || kind === "networkAclAssociation") {
    // The subnet is the whole content of an association. Without one there is
    // no relationship to draw, and folding would delete the join outright
    // rather than compact it.
    if (other?.type !== ResourceType.EC2_SUBNET) return undefined;
    return {
      glue,
      kind,
      parent,
      mint: { source: other.id, target: parent.id, verb: FOLD_VERBS[kind], via: kind },
    };
  }

  if (kind === "networkAclEntry") {
    // The one other node an entry may reach is the one its CIDR names: a rule
    // admitting `aws_vpc.main.cidr_block` is still just a row.
    const cidr = attributeUnder(glue.attributes, NACL_CIDR_KEYS)?.value;
    if (other && !referenceNames(cidr, other)) return undefined;
    const egress = readAttribute(glue.attributes, "egress");
    return {
      glue,
      kind,
      parent,
      ...naclEntryRail(glue, glue.attributes, egress === true || egress === "true", other?.name),
    };
  }

  if (kind === "gatewayAttachment") {
    if (!other) return undefined;
    return {
      glue,
      kind,
      parent,
      mint: {
        source: parent.id,
        target: other.id,
        verb: FOLD_VERBS.gatewayAttachment,
        via: "gatewayAttachment",
      },
    };
  }

  if (kind === "instanceProfile") {
    // The only reference a profile is allowed to carry besides its instance is
    // the role it wraps, which the rail then reports. `filterGraphForDisplay`
    // hides IAM roles, so on the display path there is usually nothing here at
    // all — the check is what keeps the fold correct on an UNFILTERED graph
    // (the account export, a browser spec that sets `.graph` directly), where
    // absorbing some other reference would delete a relationship.
    if (other && other.type !== ResourceType.IAM_ROLE) return undefined;
    return { glue, kind, parent, rail: profileRail(glue, other) };
  }

  if (kind === "securityGroupRule") return securityGroupRuleFold(glue, parent, other);
  if (kind === "listener") return listenerFold(glue, parent, other);

  const destination = attributeUnder(glue.attributes, ROUTE_DESTINATION_KEYS);
  const cidr = destination ? railValue(destination.value) : undefined;
  return {
    glue,
    kind,
    parent,
    rail: routeRail(glue, destination, cidr, other),
    // A route whose target is not in the graph still gets its rail; there is
    // simply nothing to point an edge at.
    mint: other
      ? {
          source: parent.id,
          target: other.id,
          // The destination stays SEPARATE from the verb: several routes can
          // reach one target, and the merge composes `routes 0.0.0.0/0, ::/0`
          // from the parts rather than re-parsing a composed label.
          verb: FOLD_VERBS.route,
          detail: cidr,
          via: "route",
        }
      : undefined,
  };
}

/** `ROUTE` rail: `0.0.0.0/0 -> IGW`, expanding to the destination and target
 * properties as the template spelled them. */
function routeRail(
  glue: ResourceNode,
  destination: { key: string; value: unknown } | undefined,
  cidr: string | undefined,
  target: ResourceNode | undefined,
): FallbackRail {
  const policy: string[] = [];
  if (destination && cidr) policy.push(`${destination.key} ${cidr}`);
  const targetAttribute = attributeUnder(glue.attributes, ROUTE_TARGET_KEYS);
  if (targetAttribute) {
    const value = railValue(targetAttribute.value, target?.name);
    if (value) policy.push(`${targetAttribute.key} ${value}`);
  }
  const name = [cidr, target?.name].filter(Boolean).join(" → ");
  // The join's own name is the last resort — a synthesised logical id, but
  // still the string a viewer greps their template for.
  return fallbackRailFor(glue, railLabelFor("route"), policy, name || glue.name);
}

/** `PROFILE` rail: the profile's name, expanding to the role it carries. */
function profileRail(glue: ResourceNode, role: ResourceNode | undefined): FallbackRail {
  const policy: string[] = [];
  for (const key of PROFILE_POLICY_KEYS) {
    const found = attributeUnder(glue.attributes, [key]);
    if (!found) continue;
    const value = railValue(found.value, role?.name);
    if (value) policy.push(`${found.key} ${value}`);
  }
  return fallbackRailFor(glue, railLabelFor("instanceprofile"), policy);
}

/** The rule's own group, and the group on its other side. A rule between two
 * groups references both, so type alone cannot say which one owns it. */
const SG_OWNER_KEYS: readonly string[] = ["groupid", "securitygroupid"];
const SG_PEER_KEYS: readonly string[] = [
  "sourcesecuritygroupid",
  "destinationsecuritygroupid",
  "referencedsecuritygroupid",
];
const SG_CIDR_KEYS: readonly string[] = [
  "cidrip",
  "cidripv6",
  "cidrblocks",
  "ipv6cidrblocks",
  "cidripv4",
  "sourceprefixlistid",
  "destinationprefixlistid",
  "prefixlistids",
  "prefixlistid",
];

function securityGroupRuleOwner(
  rule: ResourceNode,
  structural: readonly Neighbour[],
): ResourceNode | undefined {
  const groups = [
    ...new Set(
      structural.filter((n) => n.node.type === ResourceType.EC2_SECURITY_GROUP).map((n) => n.node),
    ),
  ];
  if (groups.length === 0) return undefined;
  const ownerToken = referenceToken(attributeUnder(rule.attributes, SG_OWNER_KEYS)?.value);
  const named = ownerToken ? groups.find((g) => namesNode(ownerToken, g)) : undefined;
  if (named) return named;
  if (groups.length !== 1) return undefined;
  // One group, and an owner reference that names nothing on the graph: still
  // the owner, unless the peer reference is the one that names it.
  const peerToken = referenceToken(attributeUnder(rule.attributes, SG_PEER_KEYS)?.value);
  return ownerToken && peerToken && namesNode(peerToken, groups[0]) ? undefined : groups[0];
}

/** Whether a rule lets traffic out rather than in. One Terraform type covers
 * both and says which in its `type` attribute. */
function isEgressRule(rule: ResourceNode): boolean {
  const raw = rule.resourceType ?? "";
  if (/egress/i.test(raw)) return true;
  if (/ingress/i.test(raw)) return false;
  return attributeUnder(rule.attributes, ["type"])?.value === "egress";
}

/** `tcp 5432`, `all`, `tcp 8000-8080`. */
function trafficOf(rule: ResourceNode): string {
  const protocol = railValue(attributeUnder(rule.attributes, ["ipprotocol", "protocol"])?.value);
  const from = railValue(attributeUnder(rule.attributes, ["fromport"])?.value);
  const to = railValue(attributeUnder(rule.attributes, ["toport"])?.value);
  const allTraffic = protocol === "-1" || protocol?.toLowerCase() === "all";
  const ports = allTraffic || !from ? undefined : !to || to === from ? from : `${from}-${to}`;
  return [allTraffic ? "all" : protocol?.toLowerCase(), ports].filter(Boolean).join(" ");
}

function securityGroupRuleFold(
  glue: ResourceNode,
  parent: ResourceNode,
  other: ResourceNode | undefined,
): Fold | undefined {
  if (other && other.type !== ResourceType.EC2_SECURITY_GROUP) return undefined;
  const egress = isEgressRule(glue);
  const traffic = trafficOf(glue);
  const cidr = attributeUnder(glue.attributes, SG_CIDR_KEYS);
  const cidrValue = cidr ? railValue(cidr.value) : undefined;
  const peerToken = referenceToken(attributeUnder(glue.attributes, SG_PEER_KEYS)?.value);
  // A group that admits itself reaches no second node, so `other` is empty.
  const self = !other && peerToken !== undefined && namesNode(peerToken, parent);
  const peer = other?.name ?? (self ? parent.name : cidrValue);
  const name = [traffic, peer ? `${egress ? "→" : "←"} ${peer}` : undefined]
    .filter(Boolean)
    .join(" ");
  const policy: string[] = [];
  const description = attributeUnder(glue.attributes, ["description"]);
  const descriptionValue = description ? railValue(description.value) : undefined;
  if (description && descriptionValue) policy.push(`${description.key} ${descriptionValue}`);
  if (traffic) policy.push(traffic);
  if (cidr && cidrValue) policy.push(`${cidr.key} ${cidrValue}`);
  const rail = fallbackRailFor(
    glue,
    railLabelFor(egress ? "egress" : "ingress"),
    policy,
    name || undefined,
  );
  if (!other) return { glue, kind: "securityGroupRule", parent, rail };
  return {
    glue,
    kind: "securityGroupRule",
    parent,
    rail,
    // Drawn the way traffic flows, so an ingress rule on the database's group
    // from the service's group and the service group's matching egress rule
    // resolve to one pair and merge into one edge.
    mint: {
      source: egress ? parent.id : other.id,
      target: egress ? other.id : parent.id,
      verb: FOLD_VERBS.securityGroupRule,
      detail: traffic || undefined,
      via: "securityGroupRule",
    },
  };
}

/** Target groups have no `ResourceType` of their own, so a listener's one
 * permitted neighbour besides its load balancer is matched by raw type. */
const TARGET_GROUP_TYPES: ReadonlySet<string> = new Set([
  "AWS::ElasticLoadBalancingV2::TargetGroup",
  "aws_lb_target_group",
  "aws_alb_target_group",
  "aws:lb/targetGroup:TargetGroup",
  "aws:alb/targetGroup:TargetGroup",
]);

/** `LISTENER` rail reading `HTTPS 443`, plus a `LB -> target group` edge for
 * the default forward. A listener reaching anything else (a certificate, an
 * alarm, a rule) keeps its card: this pass has no verb for those. */
function listenerFold(
  glue: ResourceNode,
  parent: ResourceNode,
  other: ResourceNode | undefined,
): Fold | undefined {
  if (other && !TARGET_GROUP_TYPES.has(other.resourceType ?? "")) return undefined;
  const protocol = attributeUnder(glue.attributes, ["protocol"]);
  const port = attributeUnder(glue.attributes, ["port"]);
  const protocolValue = protocol ? railValue(protocol.value) : undefined;
  const portValue = port ? railValue(port.value) : undefined;
  const policy: string[] = [];
  if (protocol && protocolValue) policy.push(`${protocol.key} ${protocolValue}`);
  if (port && portValue) policy.push(`${port.key} ${portValue}`);
  const detail = [protocolValue, portValue].filter(Boolean).join(" ");
  const rail = fallbackRailFor(glue, railLabelFor("listener"), policy, detail || undefined);
  if (!other) return { glue, kind: "listener", parent, rail };
  return {
    glue,
    kind: "listener",
    parent,
    rail,
    mint: {
      source: parent.id,
      target: other.id,
      verb: FOLD_VERBS.listener,
      detail: detail || undefined,
      via: "listener",
    },
  };
}

const NACL_CIDR_KEYS = ["cidrblock", "ipv6cidrblock"];

/** Whether a reference names `node`, read loosely enough to accept the
 * attribute forms a CIDR or subnet list uses: `${aws_vpc.main.cidr_block}`,
 * `{ "Fn::GetAtt": ["Vpc", "CidrBlock"] }`, `${aws_subnet.a.id}`. */
function referenceNames(value: unknown, node: ResourceNode): boolean {
  const token = referenceToken(value);
  if (!token) return false;
  if (namesNode(token, node)) return true;
  return typeof value === "string" && namesNode(token.replace(/\.[^.]+$/, ""), node);
}

/** What a Pulumi plan writes for an input it cannot resolve yet. */
export const PULUMI_UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

/** Whether a Terraform expression (`${aws_subnet.a[*].id}`, `${concat(...)}`,
 * `${[for s in aws_subnet.a : s.id]}`) mentions `address` as a whole address. */
function mentionsAddress(value: unknown, address: string): boolean {
  if (typeof value !== "string" || !value.startsWith("${")) return false;
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.])${escaped}(\\W|$)`).test(value);
}

/** Whether an `ACL -> Subnet` reference edge is the ACL's own `subnet_ids`.
 * A rule CIDR or a `depends_on` can reference a subnet too, and must not read
 * as an association. An item names the subnet by reference, by address inside
 * an expression, or by the resolved id a Terraform plan carries. An item a
 * Pulumi plan could not resolve yet may be any subnet whose id is unknown. */
function isSubnetListEdge(acl: ResourceNode, subnet: ResourceNode): boolean {
  const raw = readAttribute(acl.attributes, "subnetids");
  const items = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const address = subnet.id.slice(subnet.id.lastIndexOf("/") + 1).replace(/#\d+$/, "");
  const resolvedId = readString(subnet.attributes, "id");
  return (
    items.some(
      (item) =>
        referenceNames(item, subnet) ||
        mentionsAddress(item, address) ||
        (resolvedId !== undefined && item === resolvedId),
    ) ||
    (resolvedId === undefined && items.includes(PULUMI_UNKNOWN))
  );
}

/** IANA numbers a NACL entry spells its protocol with (`-1` is every protocol). */
const NACL_PROTOCOLS: Readonly<Record<string, string>> = {
  "-1": "all",
  "1": "icmp",
  "6": "tcp",
  "17": "udp",
  "58": "icmpv6",
};

/**
 * One NACL entry as a rail reading `#105 allow tcp 443 → 0.0.0.0/0`: the SG
 * rule's `traffic arrow peer` row, led by the rule number and action that make
 * a NACL ordered and stateless. `order` sorts ingress before egress and each by
 * rule number; an unnumbered entry goes last, where AWS keeps its `*` rule.
 * Reads a CloudFormation/aws-native entry, a Terraform or Pulumi rule resource,
 * and an inline `ingress`/`egress` block alike.
 */
function naclEntryRail(
  entry: Pick<ResourceNode, "id" | "name">,
  attributes: Record<string, unknown>,
  egress: boolean,
  /** The node a referenced CIDR resolves to, shown in its place. */
  peerName?: string,
): { rail: FallbackRail; order: number } {
  const value = (keys: string[], fallbackName?: string) => {
    const found = attributeUnder(attributes, keys);
    const shown = found ? railValue(found.value, fallbackName) : undefined;
    return found && shown ? { key: found.key, shown } : undefined;
  };
  const number = value(["rulenumber", "ruleno"]);
  const action = value(["ruleaction", "action"]);
  const cidr = value(NACL_CIDR_KEYS, peerName);
  const raw = value(["protocol"])?.shown.toLowerCase();
  const protocol = raw ? (lookupByType(NACL_PROTOCOLS, raw) ?? raw) : undefined;
  const range = readAttribute(attributes, "portrange") as Record<string, unknown> | undefined;
  const from = railValue(readAttribute(range ?? attributes, range ? "from" : "fromport"));
  const to = railValue(readAttribute(range ?? attributes, range ? "to" : "toport"));
  const ports =
    (protocol === "tcp" || protocol === "udp") && from
      ? !to || to === from
        ? from
        : `${from}-${to}`
      : undefined;
  const traffic = [protocol, ports].filter(Boolean).join(" ");
  const name = [
    number && `#${number.shown}`,
    action?.shown,
    traffic,
    cidr && `${egress ? "→" : "←"} ${cidr.shown}`,
  ]
    .filter(Boolean)
    .join(" ");
  const policy = [
    number && `${number.key} ${number.shown}`,
    action && `${action.key} ${action.shown}`,
    traffic,
    cidr && `${cidr.key} ${cidr.shown}`,
  ].filter((line): line is string => !!line);
  const rank = Number(number?.shown);
  return {
    rail: fallbackRailFor(
      entry,
      railLabelFor(egress ? "egress" : "ingress"),
      policy,
      name || undefined,
    ),
    order: (egress ? 1e5 : 0) + (Number.isInteger(rank) ? rank : 65536),
  };
}
