import { authoredHeaderLabel } from "../../graph/authored.js";
import { containerChildSets } from "../../graph/containment.js";
import { foldNetworkGlue } from "../../graph/foldNetworkGlue.js";
import type { GraphDelta } from "../../graph/graphDelta.js";
import { prepare } from "../../graph/preparePipeline.js";
import { CATEGORY_BY_TYPE } from "../../graph/resourceCategory.js";
import { CATEGORY_COLORS, type NodeColors } from "../../graph/resourceColors.js";
import { apiGatewayTypeLabel } from "../../graph/stageTypes.js";
import { lookupByType } from "../../graph/typeLookup.js";
import type { ArchGraph, ResourceEdge, ResourceNode } from "../../graph/types.js";
import { EdgeType, ResourceType } from "../../graph/types.js";
import { iconSubpathForNode } from "../../icons/iconAssets.js";

export interface MermaidRenderOptions {
  /** When set, embeds <img> icon tags in node labels (requires securityLevel: 'loose').
   * The root the `aws/`, `gcp/` and `azure/` icon directories sit under. */
  iconBaseUrl?: string;
  /** Extract event-type nodes from IaC event semantics. Default true. */
  eventFlows?: boolean;
  /** Infra delta to highlight: added and changed nodes get a second class.
   * Removed nodes are not in this graph and are not drawn. */
  delta?: Pick<GraphDelta, "added" | "changed">;
}

/** Exported for the infra-delta summary; the renderer's own use is unchanged. */
export const RESOURCE_DISPLAY_NAMES: Record<ResourceType, string> = {
  [ResourceType.EC2_INSTANCE]: "EC2 Instance",
  [ResourceType.LAMBDA_FUNCTION]: "Lambda",
  [ResourceType.ECS_SERVICE]: "ECS Service",
  [ResourceType.S3_BUCKET]: "S3 Bucket",
  [ResourceType.DYNAMODB_TABLE]: "DynamoDB",
  [ResourceType.RDS_INSTANCE]: "RDS",
  [ResourceType.EC2_VPC]: "VPC",
  [ResourceType.EC2_SUBNET]: "Subnet",
  [ResourceType.EC2_SECURITY_GROUP]: "Security Group",
  [ResourceType.ELB_LOAD_BALANCER]: "Load Balancer",
  [ResourceType.IAM_ROLE]: "IAM Role",
  [ResourceType.IAM_POLICY]: "IAM Policy",
  [ResourceType.IAM_INSTANCE_PROFILE]: "Instance Profile",
  [ResourceType.APIGW_REST_API]: "API Gateway",
  [ResourceType.APIGW_V2_API]: "API Gateway",
  [ResourceType.SQS_QUEUE]: "SQS Queue",
  [ResourceType.CLOUDFRONT_DISTRIBUTION]: "CloudFront",
  [ResourceType.ROUTE53_ZONE]: "Route53 Zone",
  [ResourceType.ROUTE53_RECORD]: "Route53 Record",
  [ResourceType.ACM_CERTIFICATE]: "ACM Certificate",
  [ResourceType.EVENTBRIDGE_RULE]: "EventBridge Rule",
  [ResourceType.SNS_TOPIC]: "SNS Topic",
  [ResourceType.APIGW_V2_ROUTE]: "Route",
  [ResourceType.APIGW_V2_INTEGRATION]: "Integration",
  // Forced by `Record<ResourceType, string>`'s exhaustiveness, not a
  // route-table rendering decision: Mermaid never runs collapseRouteTables
  // (canvas-only), so a REST API still renders these as raw nodes exactly
  // as it did when they were untyped UNKNOWN — same "Resource"-style label,
  // just no longer generic. See routeTable.ts for where REST types are
  // actually collapsed away, canvas-only.
  [ResourceType.APIGW_REST_RESOURCE]: "API Resource",
  [ResourceType.APIGW_REST_METHOD]: "API Method",
  [ResourceType.APIGW_REST_INTEGRATION]: "Integration",
  [ResourceType.EC2_NAT_GATEWAY]: "NAT Gateway",
  [ResourceType.EC2_INTERNET_GATEWAY]: "Internet Gateway",
  [ResourceType.EC2_VPC_ENDPOINT]: "VPC Endpoint",
  [ResourceType.EC2_TRANSIT_GATEWAY]: "Transit Gateway",
  [ResourceType.EC2_EIP]: "Elastic IP",
  [ResourceType.EC2_ROUTE_TABLE]: "Route Table",
  [ResourceType.EC2_ROUTE_TABLE_ASSOCIATION]: "Route Table Association",
  [ResourceType.EC2_ROUTE]: "Route",
  [ResourceType.EC2_INTERNET_GATEWAY_ATTACHMENT]: "Gateway Attachment",
  [ResourceType.ECS_CLUSTER]: "ECS Cluster",
  [ResourceType.ECS_TASK_DEFINITION]: "ECS Task Definition",
  [ResourceType.EKS_CLUSTER]: "EKS Cluster",
  [ResourceType.SFN_STATE_MACHINE]: "Step Functions",
  [ResourceType.SFN_STATE]: "State",
  [ResourceType.AUTOSCALING_GROUP]: "Auto Scaling Group",
  [ResourceType.RDS_CLUSTER]: "Aurora Cluster",
  [ResourceType.ELASTICACHE_CLUSTER]: "ElastiCache",
  [ResourceType.OPENSEARCH_DOMAIN]: "OpenSearch",
  [ResourceType.EFS_FILE_SYSTEM]: "EFS",
  [ResourceType.REDSHIFT_CLUSTER]: "Redshift",
  [ResourceType.COGNITO_USER_POOL]: "Cognito",
  [ResourceType.WAF_WEB_ACL]: "WAF",
  [ResourceType.KMS_KEY]: "KMS Key",
  [ResourceType.SECRETSMANAGER_SECRET]: "Secrets Manager",
  [ResourceType.EVENTBRIDGE_BUS]: "EventBridge Bus",
  [ResourceType.KINESIS_STREAM]: "Kinesis Stream",
  [ResourceType.KINESIS_FIREHOSE]: "Kinesis Firehose",
  [ResourceType.MSK_CLUSTER]: "MSK (Kafka)",
  [ResourceType.ECR_REPOSITORY]: "ECR Repository",
  [ResourceType.CODEPIPELINE_PIPELINE]: "CodePipeline",
  [ResourceType.CODEBUILD_PROJECT]: "CodeBuild",
  [ResourceType.APPSYNC_API]: "AppSync",
  [ResourceType.CLOUDFORMATION_STACK]: "Stack",

  // GCP Compute
  [ResourceType.GCP_COMPUTE_INSTANCE]: "GCE Instance",
  [ResourceType.GCP_CONTAINER_CLUSTER]: "GKE Cluster",
  [ResourceType.GCP_CLOUD_RUN_SERVICE]: "Cloud Run",
  [ResourceType.GCP_CLOUD_FUNCTION]: "Cloud Function",
  [ResourceType.GCP_APP_ENGINE]: "App Engine",

  // GCP Storage
  [ResourceType.GCP_STORAGE_BUCKET]: "GCS Bucket",
  [ResourceType.GCP_BIGQUERY_DATASET]: "BigQuery",
  [ResourceType.GCP_SQL_INSTANCE]: "Cloud SQL",
  [ResourceType.GCP_SPANNER_INSTANCE]: "Spanner",
  [ResourceType.GCP_FIRESTORE_DATABASE]: "Firestore",
  [ResourceType.GCP_REDIS_INSTANCE]: "Memorystore",
  [ResourceType.GCP_BIGTABLE_INSTANCE]: "Bigtable",

  // GCP Networking
  [ResourceType.GCP_COMPUTE_NETWORK]: "VPC Network",
  [ResourceType.GCP_COMPUTE_SUBNETWORK]: "Subnet",
  [ResourceType.GCP_FORWARDING_RULE]: "Forwarding Rule",
  [ResourceType.GCP_DNS_ZONE]: "Cloud DNS",
  [ResourceType.GCP_SECURITY_POLICY]: "Cloud Armor",
  [ResourceType.GCP_COMPUTE_ROUTER]: "Cloud Router",
  [ResourceType.GCP_COMPUTE_FIREWALL]: "Firewall Rule",

  // GCP Messaging
  [ResourceType.GCP_PUBSUB_TOPIC]: "Pub/Sub Topic",
  [ResourceType.GCP_PUBSUB_SUBSCRIPTION]: "Pub/Sub Sub",
  [ResourceType.GCP_EVENTARC_TRIGGER]: "Eventarc Trigger",

  // GCP Security
  [ResourceType.GCP_IAM_BINDING]: "IAM Binding",
  [ResourceType.GCP_IAM_MEMBER]: "IAM Member",
  [ResourceType.GCP_SERVICE_ACCOUNT]: "Service Account",
  [ResourceType.GCP_KMS_KEY]: "KMS Key",

  // GCP API
  [ResourceType.GCP_API_GATEWAY]: "API Gateway",
  [ResourceType.GCP_ENDPOINTS_SERVICE]: "Endpoints",

  // Azure Compute
  [ResourceType.AZURE_VIRTUAL_MACHINE]: "Azure VM",
  [ResourceType.AZURE_LINUX_VM]: "Linux VM",
  [ResourceType.AZURE_WINDOWS_VM]: "Windows VM",
  [ResourceType.AZURE_FUNCTION_APP]: "Azure Function",
  [ResourceType.AZURE_KUBERNETES_CLUSTER]: "AKS",
  [ResourceType.AZURE_CONTAINER_GROUP]: "Container Group",
  [ResourceType.AZURE_APP_SERVICE]: "App Service",

  // Azure Storage
  [ResourceType.AZURE_STORAGE_ACCOUNT]: "Storage Account",
  [ResourceType.AZURE_COSMOSDB_ACCOUNT]: "Cosmos DB",
  [ResourceType.AZURE_SQL_DATABASE]: "SQL Database",
  [ResourceType.AZURE_SQL_SERVER]: "SQL Server",
  [ResourceType.AZURE_REDIS_CACHE]: "Redis Cache",

  // Azure Networking
  [ResourceType.AZURE_VIRTUAL_NETWORK]: "VNet",
  [ResourceType.AZURE_SUBNET]: "Subnet",
  [ResourceType.AZURE_LOAD_BALANCER]: "Load Balancer",
  [ResourceType.AZURE_APP_GATEWAY]: "App Gateway",
  [ResourceType.AZURE_DNS_ZONE]: "DNS Zone",
  [ResourceType.AZURE_FRONTDOOR]: "Front Door",
  [ResourceType.AZURE_NSG]: "NSG",

  // Azure Security
  [ResourceType.AZURE_KEY_VAULT]: "Key Vault",
  [ResourceType.AZURE_ROLE_ASSIGNMENT]: "Role Assignment",
  [ResourceType.AZURE_USER_IDENTITY]: "Managed Identity",

  // Azure Messaging
  [ResourceType.AZURE_SERVICEBUS_NAMESPACE]: "Service Bus",
  [ResourceType.AZURE_SERVICEBUS_QUEUE]: "Service Bus Queue",
  [ResourceType.AZURE_SERVICEBUS_TOPIC]: "Service Bus Topic",
  [ResourceType.AZURE_EVENTGRID_TOPIC]: "Event Grid",
  [ResourceType.AZURE_EVENTHUB_NAMESPACE]: "Event Hub",

  // Azure API
  [ResourceType.AZURE_API_MANAGEMENT]: "API Management",

  // Azure Grouping
  [ResourceType.AZURE_RESOURCE_GROUP]: "Resource Group",

  [ResourceType.EVENT_TYPE]: "Event",
  [ResourceType.AUTHORED]: "Node",
  [ResourceType.UNKNOWN]: "Resource",
};

const displayNameOf = (type: ResourceType): string =>
  lookupByType(RESOURCE_DISPLAY_NAMES, type) ?? "Resource";

/** Every lowercase word mermaid@11.17's flowchart lexer rejects as a node or
 * subgraph id — probed against the real parser, which is case-sensitive here
 * (`End` and `Default` parse fine). A Serverless function key or a CFN logical
 * id can be any of them, and one bare keyword fails the whole diagram. */
const MERMAID_RESERVED_IDS = new Set([
  "end",
  "style",
  "default",
  "graph",
  "flowchart",
  "subgraph",
  "class",
  "classDef",
  "click",
  "linkStyle",
  "interpolate",
  "href",
  "call",
  "_self",
  "_blank",
  "_parent",
  "_top",
]);

/**
 * Raw node id → Mermaid id, injective over `ids`. Replacing every character
 * outside `[A-Za-z0-9_]` with `_` is lossy (`a-b`, `a.b` and `a_b` all land on
 * `a_b`). Ids that are already valid keep their exact name; the rest take a
 * `_2`, `_3`… suffix on collision, assigned in sorted raw-id order so the
 * answer depends on the id set and not on parser order. Never emits `-`,
 * which the layout harnesses rely on to split Mermaid's `flowchart-<id>-<n>`
 * element ids.
 */
export function mermaidNodeIds(ids: Iterable<string>): Map<string, string> {
  const result = new Map<string, string>();
  const taken = new Set<string>();
  const rewritten: string[] = [];
  for (const raw of [...new Set(ids)].sort()) {
    if (/^[a-zA-Z0-9_]+$/.test(raw) && !MERMAID_RESERVED_IDS.has(raw)) {
      taken.add(raw);
      result.set(raw, raw);
    } else {
      rewritten.push(raw);
    }
  }
  for (const raw of rewritten) {
    const sanitized = raw.replace(/[^a-zA-Z0-9_]/g, "_");
    const base = MERMAID_RESERVED_IDS.has(sanitized) || !sanitized ? `${sanitized}_` : sanitized;
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
    taken.add(id);
    result.set(raw, id);
  }
  return result;
}

const CATEGORY_TEXT: Readonly<Record<keyof typeof CATEGORY_COLORS, string>> = {
  networking: "#9a3412",
  compute: "#1e40af",
  storage: "#166534",
  security: "#6b21a8",
  messaging: "#92400e",
  events: "#9d174d",
  infra: "#334155",
};

const CLASS_DEF_LINES = (
  Object.entries(CATEGORY_COLORS) as [keyof typeof CATEGORY_COLORS, NodeColors][]
).map(([cat, c]) => `classDef ${cat} fill:${c.bg},stroke:${c.border},color:${CATEGORY_TEXT[cat]}`);

const DELTA_CLASS_DEF_LINES = [
  "classDef arcAdded stroke:#16a34a,stroke-width:3px",
  "classDef arcChanged stroke:#d97706,stroke-width:3px,stroke-dasharray:6 3",
];

/** `class a,b cls` statements for the delta ids the rendered graph carries.
 * A separate statement rather than the `:::` suffix, which takes one class
 * and is already spent on the resource category. */
function deltaClassLines(delta: MermaidRenderOptions["delta"], ids: Map<string, string>): string[] {
  if (!delta) return [];
  const lines: string[] = [];
  for (const [cls, nodes] of [
    ["arcAdded", delta.added],
    ["arcChanged", delta.changed],
  ] as const) {
    const classed = nodes.flatMap((n) => ids.get(n.id) ?? []);
    if (classed.length > 0) lines.push(`  class ${classed.join(",")} ${cls}`);
  }
  return lines;
}

function getStyleSuffix(type: ResourceType): string {
  const cls = lookupByType(CATEGORY_BY_TYPE, type);
  return cls ? `:::${cls}` : "";
}

/**
 * HTML-entity-encode text destined for a quoted Mermaid label (node
 * `["..."]`, subgraph, or edge `|"..."|`). Names come from arbitrary user
 * IaC (event detail-types, SNS filter values, resource/stack/integration
 * names) and the frontend renders Mermaid with
 * securityLevel "loose", so an unescaped `"` breaks out of the label quotes
 * and `<`/`>` are an HTML-injection vector (e.g. `<img onerror=...>`).
 * Mermaid accepts entities inside quoted labels, so this is safe to apply
 * unconditionally.
 */
function escapeMermaidLabel(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;");
}

/**
 * The rail tags this renderer draws.
 *
 * ONLY the two `foldNetworkGlue` produces, because that is the only fold this
 * renderer runs. A node reaching `renderMermaid` on the shipping path has
 * already been through `filterGraphForDisplay`, which stamps a `LOGS` rail on
 * every owner of a hidden log group — so rendering rails unconditionally put
 * `↳ LOGS Logs` on every Lambda in every PR comment and every `arcsync
 * generate` diagram. That is a change to diagrams this feature has nothing to
 * do with, and the name it prints is the log group's LOGICAL ID, which reads as
 * noise inline where it reads fine beside the card it hangs off on the canvas.
 */
const MERMAID_RAIL_LABELS: ReadonlySet<string> = new Set(["ROUTE", "PROFILE"]);

/**
 * The folded rails a card draws as strips, as extra lines under the node's
 * name — the closest thing this renderer has to the canvas's strip, and the
 * only way a folded route survives into an exported Markdown diagram at all.
 *
 * `<br/>` is emitted RAW, outside `escapeMermaidLabel`, exactly as the icon
 * `<img>` below already is: the escape exists to neutralise a resource NAME,
 * not the markup this function composes around it. Mermaid treats `<br/>` in
 * node text as a line break in every label mode.
 */
function railLines(node: ResourceNode): string {
  const rails = node.fallbackRails ?? [];
  return rails
    .filter((rail) => MERMAID_RAIL_LABELS.has(rail.label))
    .map((rail) => `<br/>${escapeMermaidLabel(`↳ ${rail.label} ${rail.name}`)}`)
    .join("");
}

function formatNodeLabel(node: ResourceNode, options?: MermaidRenderOptions): string {
  const text =
    escapeMermaidLabel(
      authoredHeaderLabel(node, node.name) ?? `${displayNameOf(node.type)}: ${node.name}`,
    ) + railLines(node);
  if (!options?.iconBaseUrl) return text;

  const iconFile = iconSubpathForNode(node);
  if (!iconFile) return text;

  const iconUrl = `${options.iconBaseUrl}/${iconFile}`;
  return `<img src='${iconUrl}' width='24' height='24' alt='' style='vertical-align:middle;margin-right:6px'/>${text}`;
}

function getSubgraphLabel(node: ResourceNode): string {
  if (node.type === ResourceType.CLOUDFORMATION_STACK) return escapeMermaidLabel(node.name);
  const authored = authoredHeaderLabel(node, node.name);
  if (authored !== undefined) return escapeMermaidLabel(authored);
  const displayName = displayNameOf(node.type);
  const typeLabel = apiGatewayTypeLabel(node);
  return escapeMermaidLabel(
    typeLabel ? `${displayName} (${typeLabel}): ${node.name}` : `${displayName}: ${node.name}`,
  );
}

interface RenderContext {
  containers: Map<string, Set<string>>;
  nodeMap: Map<string, ResourceNode>;
  ids: Map<string, string>;
  lines: string[];
  options?: MermaidRenderOptions;
}

function nodeLine(node: ResourceNode, indent: string, ctx: RenderContext): string {
  return `${indent}${ctx.ids.get(node.id)}["${formatNodeLabel(node, ctx.options)}"]${getStyleSuffix(node.type)}`;
}

function renderContainer(
  parentId: string,
  childIds: Set<string>,
  indent: string,
  ctx: RenderContext,
): void {
  const parent = ctx.nodeMap.get(parentId);
  if (!parent) return;

  ctx.lines.push(`${indent}subgraph ${ctx.ids.get(parentId)}["${getSubgraphLabel(parent)}"]`);
  for (const childId of childIds) {
    // A child that is itself a container renders as a nested subgraph.
    const grandchildren = ctx.containers.get(childId);
    if (grandchildren) {
      renderContainer(childId, grandchildren, `${indent}  `, ctx);
      continue;
    }
    const child = ctx.nodeMap.get(childId);
    if (child) ctx.lines.push(nodeLine(child, `${indent}  `, ctx));
  }
  ctx.lines.push(`${indent}end`);
}

function edgeLine(edge: ResourceEdge, ids: Map<string, string>): string {
  const source = ids.get(edge.source);
  const target = ids.get(edge.target);
  if (edge.type === EdgeType.EVENT_FLOW) return `  ${source} -.-> ${target}`;

  const label = edge.label ? `|"${escapeMermaidLabel(edge.label)}"|` : "";
  // Best-effort cross-engine matches (literal/ARN, not a real reference in
  // either engine's source) render as a dotted link — the same visual
  // distinction the canvas already makes with a dashed stroke — so an
  // exported Mermaid artifact never presents a guess as a parsed fact.
  if (edge.inferredCrossEngine) return `  ${source} -.->${label} ${target}`;

  // Mermaid's flowchart grammar has no one-sided `<--` link, so a reverse
  // edge swaps its endpoints and draws a forward arrow.
  if (edge.direction === "reverse") return `  ${target} -->${label} ${source}`;
  const arrow = edge.direction === "bidirectional" ? "<-->" : "-->";
  return `  ${source} ${arrow}${label} ${target}`;
}

export function renderMermaid(graph: ArchGraph, options?: MermaidRenderOptions): string {
  // The networking roll-up is the ONE fold this renderer runs. The others
  // (`collapseRouteTables`, `foldFallbackNodes`, the ECS and autoscaling folds)
  // all trade a node for a drawn affordance Mermaid has no equivalent of — a
  // table of rows, a policy strip. This one trades it for a LABELLED EDGE and a
  // line of text, both of which Mermaid draws natively, so the Markdown export
  // and the PR comment get the same reading as the canvas rather than nine grey
  // boxes the canvas no longer shows.
  const transformed = foldNetworkGlue(prepare(graph, { eventFlows: options?.eventFlows }));
  const lines: string[] = [
    graph.metadata?.rankdir === "LR" ? "graph LR" : "graph TD",
    ...CLASS_DEF_LINES.map((l) => `  ${l}`),
    ...(options?.delta ? DELTA_CLASS_DEF_LINES.map((l) => `  ${l}`) : []),
  ];

  // Where each node is DRAWN, resolved the one way the whole codebase resolves
  // it (`containment.ts`). A multi-parent walk here emitted the shared node
  // inside both `subgraph` blocks; Mermaid tolerates the duplicate declaration
  // and places it in the first, so the picture already matched first-parent-
  // wins — by coincidence rather than by construction.
  //
  // `containedNodes` comes from the WON children rather than from every
  // CONTAINS target, which matters for exactly one shape: a node whose only
  // claimant is a container the graph does not carry. `containerChildSets`
  // drops that edge, so reading targets would mark the node contained while no
  // block emits it and it would vanish from the diagram entirely — which is
  // what the old walk did. A node whose claim merely LOST is never at risk:
  // under first-parent-wins some other container won it by definition.
  const containers = containerChildSets(transformed);
  const containedNodes = new Set<string>();
  for (const children of containers.values()) {
    for (const childId of children) containedNodes.add(childId);
  }

  const nodeMap = new Map(transformed.nodes.map((n) => [n.id, n]));
  const ids = mermaidNodeIds(nodeMap.keys());
  const ctx: RenderContext = { containers, nodeMap, ids, lines, options };

  // Render root containers (containers not themselves contained)
  for (const [parentId, childSet] of containers) {
    if (containedNodes.has(parentId)) continue;
    renderContainer(parentId, childSet, "  ", ctx);
  }

  // Render top-level nodes (not containers, not contained)
  for (const node of transformed.nodes) {
    if (containers.has(node.id) || containedNodes.has(node.id)) continue;
    lines.push(nodeLine(node, "  ", ctx));
  }

  lines.push(...deltaClassLines(options?.delta, ids));

  for (const edge of transformed.edges) {
    if (edge.type === EdgeType.CONTAINS) continue;
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    lines.push(edgeLine(edge, ids));
  }

  return `${lines.join("\n")}\n`;
}
