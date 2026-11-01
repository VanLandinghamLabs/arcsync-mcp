import type { StickyNote } from "../collab/types.js";

export enum ResourceType {
  EC2_INSTANCE = "aws_instance",
  LAMBDA_FUNCTION = "aws_lambda_function",
  ECS_SERVICE = "aws_ecs_service",
  S3_BUCKET = "aws_s3_bucket",
  DYNAMODB_TABLE = "aws_dynamodb_table",
  RDS_INSTANCE = "aws_db_instance",
  EC2_VPC = "aws_vpc",
  EC2_SUBNET = "aws_subnet",
  EC2_SECURITY_GROUP = "aws_security_group",
  ELB_LOAD_BALANCER = "aws_lb",
  IAM_ROLE = "aws_iam_role",
  IAM_POLICY = "aws_iam_policy",
  /** The join between an EC2 instance and its role. Folded onto the instance
   * as a `PROFILE` rail by `foldNetworkGlue`. */
  IAM_INSTANCE_PROFILE = "aws_iam_instance_profile",
  APIGW_REST_API = "aws_api_gateway_rest_api",
  APIGW_V2_API = "aws_apigatewayv2_api",
  SQS_QUEUE = "aws_sqs_queue",
  CLOUDFRONT_DISTRIBUTION = "aws_cloudfront_distribution",
  ROUTE53_ZONE = "aws_route53_zone",
  ROUTE53_RECORD = "aws_route53_record",
  ACM_CERTIFICATE = "aws_acm_certificate",
  EVENTBRIDGE_RULE = "aws_cloudwatch_event_rule",
  SNS_TOPIC = "aws_sns_topic",
  APIGW_V2_ROUTE = "aws_apigatewayv2_route",
  APIGW_V2_INTEGRATION = "aws_apigatewayv2_integration",

  // REST (v1) API Gateway — resources form a tree (parent_id/ParentId/parentId
  // references), unlike v2's single route_key string. See routeTable.ts.
  APIGW_REST_RESOURCE = "aws_api_gateway_resource",
  APIGW_REST_METHOD = "aws_api_gateway_method",
  APIGW_REST_INTEGRATION = "aws_api_gateway_integration",

  // EC2 / Networking (new)
  EC2_NAT_GATEWAY = "aws_nat_gateway",
  EC2_INTERNET_GATEWAY = "aws_internet_gateway",
  EC2_VPC_ENDPOINT = "aws_vpc_endpoint",
  EC2_TRANSIT_GATEWAY = "aws_ec2_transit_gateway",
  EC2_EIP = "aws_eip",
  EC2_ROUTE_TABLE = "aws_route_table",

  // Networking "join" resources. Each one expresses a RELATIONSHIP rather than
  // a thing — an association, a route, an attachment — and `foldNetworkGlue`
  // folds them display-time into the node that owns them. They are still
  // first-class types: a graph that is never folded (Mermaid, the account
  // export, a `Route` whose table was filtered away) has to draw them as
  // something better than an `UNKNOWN` grey box.
  EC2_ROUTE_TABLE_ASSOCIATION = "aws_route_table_association",
  EC2_ROUTE = "aws_route",
  EC2_INTERNET_GATEWAY_ATTACHMENT = "aws_internet_gateway_attachment",

  // ECS (new)
  ECS_CLUSTER = "aws_ecs_cluster",
  ECS_TASK_DEFINITION = "aws_ecs_task_definition",

  // EKS
  EKS_CLUSTER = "aws_eks_cluster",

  // Step Functions
  SFN_STATE_MACHINE = "aws_sfn_state_machine",
  /** A single ASL state inside a state machine. Synthesised by
   * `expandStateMachines` at display time — never parsed, never persisted. */
  SFN_STATE = "aws_sfn_state",

  // Auto Scaling
  AUTOSCALING_GROUP = "aws_autoscaling_group",

  // RDS (new)
  RDS_CLUSTER = "aws_rds_cluster",

  // ElastiCache
  ELASTICACHE_CLUSTER = "aws_elasticache_cluster",

  // OpenSearch
  OPENSEARCH_DOMAIN = "aws_opensearch_domain",

  // EFS
  EFS_FILE_SYSTEM = "aws_efs_file_system",

  // Redshift
  REDSHIFT_CLUSTER = "aws_redshift_cluster",

  // Security / Auth (new)
  COGNITO_USER_POOL = "aws_cognito_user_pool",
  WAF_WEB_ACL = "aws_wafv2_web_acl",
  KMS_KEY = "aws_kms_key",
  SECRETSMANAGER_SECRET = "aws_secretsmanager_secret",

  // Events / Streaming (new)
  EVENTBRIDGE_BUS = "aws_cloudwatch_event_bus",
  KINESIS_STREAM = "aws_kinesis_stream",
  KINESIS_FIREHOSE = "aws_kinesis_firehose_delivery_stream",
  MSK_CLUSTER = "aws_msk_cluster",

  // Container Registry
  ECR_REPOSITORY = "aws_ecr_repository",

  // CI/CD
  CODEPIPELINE_PIPELINE = "aws_codepipeline",
  CODEBUILD_PROJECT = "aws_codebuild_project",

  // AppSync
  APPSYNC_API = "aws_appsync_graphql_api",

  // Grouping / containers
  CLOUDFORMATION_STACK = "aws_cloudformation_stack",

  // GCP Compute
  GCP_COMPUTE_INSTANCE = "google_compute_instance",
  GCP_CONTAINER_CLUSTER = "google_container_cluster",
  GCP_CLOUD_RUN_SERVICE = "google_cloud_run_service",
  GCP_CLOUD_FUNCTION = "google_cloudfunctions_function",
  GCP_APP_ENGINE = "google_app_engine_application",

  // GCP Storage
  GCP_STORAGE_BUCKET = "google_storage_bucket",
  GCP_BIGQUERY_DATASET = "google_bigquery_dataset",
  GCP_SQL_INSTANCE = "google_sql_database_instance",
  GCP_SPANNER_INSTANCE = "google_spanner_instance",
  GCP_FIRESTORE_DATABASE = "google_firestore_database",
  GCP_REDIS_INSTANCE = "google_redis_instance",
  GCP_BIGTABLE_INSTANCE = "google_bigtable_instance",

  // GCP Networking
  GCP_COMPUTE_NETWORK = "google_compute_network",
  GCP_COMPUTE_SUBNETWORK = "google_compute_subnetwork",
  GCP_FORWARDING_RULE = "google_compute_forwarding_rule",
  GCP_DNS_ZONE = "google_dns_managed_zone",
  GCP_SECURITY_POLICY = "google_compute_security_policy",
  GCP_COMPUTE_ROUTER = "google_compute_router",
  GCP_COMPUTE_FIREWALL = "google_compute_firewall",

  // GCP Messaging
  GCP_PUBSUB_TOPIC = "google_pubsub_topic",
  GCP_PUBSUB_SUBSCRIPTION = "google_pubsub_subscription",
  GCP_EVENTARC_TRIGGER = "google_eventarc_trigger",

  // GCP Security
  GCP_IAM_BINDING = "google_project_iam_binding",
  GCP_IAM_MEMBER = "google_project_iam_member",
  GCP_SERVICE_ACCOUNT = "google_service_account",
  GCP_KMS_KEY = "google_kms_crypto_key",

  // GCP API
  GCP_API_GATEWAY = "google_api_gateway_api",
  GCP_ENDPOINTS_SERVICE = "google_endpoints_service",

  // Azure Compute
  AZURE_VIRTUAL_MACHINE = "azurerm_virtual_machine",
  AZURE_LINUX_VM = "azurerm_linux_virtual_machine",
  AZURE_WINDOWS_VM = "azurerm_windows_virtual_machine",
  AZURE_FUNCTION_APP = "azurerm_function_app",
  AZURE_KUBERNETES_CLUSTER = "azurerm_kubernetes_cluster",
  AZURE_CONTAINER_GROUP = "azurerm_container_group",
  AZURE_APP_SERVICE = "azurerm_app_service",

  // Azure Storage
  AZURE_STORAGE_ACCOUNT = "azurerm_storage_account",
  AZURE_COSMOSDB_ACCOUNT = "azurerm_cosmosdb_account",
  AZURE_SQL_DATABASE = "azurerm_mssql_database",
  AZURE_SQL_SERVER = "azurerm_mssql_server",
  AZURE_REDIS_CACHE = "azurerm_redis_cache",

  // Azure Networking
  AZURE_VIRTUAL_NETWORK = "azurerm_virtual_network",
  AZURE_SUBNET = "azurerm_subnet",
  AZURE_LOAD_BALANCER = "azurerm_lb",
  AZURE_APP_GATEWAY = "azurerm_application_gateway",
  AZURE_DNS_ZONE = "azurerm_dns_zone",
  AZURE_FRONTDOOR = "azurerm_frontdoor",
  AZURE_NSG = "azurerm_network_security_group",

  // Azure Security
  AZURE_KEY_VAULT = "azurerm_key_vault",
  AZURE_ROLE_ASSIGNMENT = "azurerm_role_assignment",
  AZURE_USER_IDENTITY = "azurerm_user_assigned_identity",

  // Azure Messaging
  AZURE_SERVICEBUS_NAMESPACE = "azurerm_servicebus_namespace",
  AZURE_SERVICEBUS_QUEUE = "azurerm_servicebus_queue",
  AZURE_SERVICEBUS_TOPIC = "azurerm_servicebus_topic",
  AZURE_EVENTGRID_TOPIC = "azurerm_eventgrid_topic",
  AZURE_EVENTHUB_NAMESPACE = "azurerm_eventhub_namespace",

  // Azure API
  AZURE_API_MANAGEMENT = "azurerm_api_management",

  // Azure Grouping
  AZURE_RESOURCE_GROUP = "azurerm_resource_group",

  // Synthetic node type: an event/message type extracted from IaC event
  // semantics (EventBridge patterns, SNS filter policies). Never emitted by
  // parsers — only by the extractEventFlows display-time pass.
  EVENT_TYPE = "arcsync_event_type",

  // A hand-authored node, not a cloud resource: see `authored.ts`.
  AUTHORED = "authored",

  UNKNOWN = "unknown",
}

export enum EdgeType {
  REFERENCE = "reference",
  DEPENDENCY = "dependency",
  NETWORK = "network",
  IAM = "iam",
  CONTAINS = "contains",
  EVENT_FLOW = "event-flow",
}

export type EdgeDirection = "forward" | "reverse" | "bidirectional";

/** The IaC project types ArcSync detects and parses. Spelled as an array so the
 * set is enumerable at runtime — the agent-facing docs guard walks it to assert
 * every shipped parser is named as supported, which a bare type union cannot do.
 * Adding an engine here fails that guard until the docs name it. */
export const ALL_PROJECT_TYPES = [
  "terraform",
  "cdk",
  "cloudformation",
  "arm",
  "pulumi",
  "serverless",
] as const;

export type ProjectType = (typeof ALL_PROJECT_TYPES)[number];

/** The engines one multi-engine parse can combine. */
export type IacEngine = Extract<ProjectType, "terraform" | "cloudformation" | "serverless">;

/**
 * The engines ArcSync executes server-side, in a per-language sandbox builder.
 *
 * These are the two expensive ones — a 10 GB Docker Lambda running a package
 * manager and a synth for 25-160s — and the only two `checkAndConsumeSynth`
 * meters against `serverSynthsPerMonth`. Everything else parses statically on
 * the cheap lane at roughly $0.00008.
 *
 * Spelled once, as an array, because two places have to agree on it and used
 * to do so by repeating a literal: the sandbox router decides here whether to
 * charge a synth, and the Action's Lane A exists precisely to move this set
 * into the caller's own CI. An engine metered here with no Action path leaves
 * those users nothing to do but stop at the quota or pay (#1083).
 */
export const SERVER_SYNTH_ENGINES = ["cdk", "pulumi"] as const;

export type ServerSynthEngine = (typeof SERVER_SYNTH_ENGINES)[number];

/**
 * The engines the GitHub Action can upload an artifact for.
 *
 * Its `collectArtifacts` reads a directory of `*.template.json` (CDK synth
 * output) or a single plan file — `terraform show -json`, or
 * `pulumi preview --save-plan`. Nothing else has a CI representation it can
 * send.
 *
 * A SUPERSET of `SERVER_SYNTH_ENGINES`, and that is the load-bearing property:
 * an engine ArcSync meters as a server synth with no Action path leaves those
 * users nothing to do but stop at the free quota or pay. Pinned by a test in
 * `workflowPr.test.ts`, and read by the docs guard so the Action's own setup
 * guide cannot quietly stop mentioning an engine it accepts.
 *
 * CloudFormation, ARM and Serverless Framework are absent at no cost: they parse
 * statically on the cheap lane, so there is no compute to move.
 */
export const ACTION_UPLOADABLE_ENGINES = [...SERVER_SYNTH_ENGINES, "terraform"] as const;

const SERVER_SYNTH_SET: ReadonlySet<string> = new Set(SERVER_SYNTH_ENGINES);

/** Reads `SERVER_SYNTH_ENGINES`, never its own copy of the literals. */
export const isServerSynthEngine = (
  projectType: ProjectType | null | undefined,
): projectType is ServerSynthEngine =>
  typeof projectType === "string" && SERVER_SYNTH_SET.has(projectType);

/** What the local-folder upload lane accepts, on both sides of the wire.
 * `mixed` is the scan verdict for a folder holding more than one `IacEngine`;
 * ARM and Pulumi have neither local-scan detection nor an upload path. */
export type UploadProjectType = Exclude<ProjectType, "arm" | "pulumi"> | "mixed";

/** What a JOB or CANON row and the parser event actually carry: a `ProjectType`,
 * or `mixed` once more than one `IacEngine` was combined. */
export type StoredProjectType = ProjectType | "mixed";

/** The authorizer guarding a route. `name` is the authorizer resource's name
 * when one is referenced, else the bare authorization type (e.g. "AWS_IAM"). */
export interface RouteAuthorizer {
  name: string;
  type: string;
}

export interface RouteTableRow {
  method: string;
  path: string;
  /** Target node id. Absent for routes with no outgoing integration edges or
   * orphaned targets not in the graph. */
  targetId?: string;
  /** The integration resource's name (e.g. `GetLobbyIntegration`), not its
   * `IntegrationType`. */
  integrationName?: string;
  hasInvokePermission: boolean;
  /** Original route node id — the stable identity a row keeps after it stops
   * being a node. ⌘F results and inspector selections resolve against this. */
  sourceRouteId: string;
  /** Absent for an unauthenticated route (no authorizer, or AuthorizationType
   * "NONE"). */
  authorizer?: RouteAuthorizer;
}

/** A path-prefix bucket of routes. `rowIndices` index into `RouteTable.rows`,
 * so a group never copies row data and row order is preserved. */
export interface RouteGroup {
  prefix: string;
  rowIndices: number[];
}

/** One drawn edge at the collapsed (1a) zoom level: the API's fanout to a
 * single λ target, weighted by how many routes it carries. */
export interface RouteEdgeSummary {
  targetId: string;
  routeCount: number;
}

export interface RouteTable {
  rows: RouteTableRow[];
  chips: string[];
  protocolLabel: string;
  /** Distinct authorizer names across all rows, in first-appearance order.
   * Drives the collapsed (1a) card's badge. */
  authorizers: string[];
  groups: RouteGroup[];
}

/** A 1:1 fallback resource folded into the node that declares it — a queue's
 * dead-letter queue, a Lambda's `DeadLetterConfig` target. Drawn as a strip
 * fused to the bottom of the parent's box. See `foldFallbackNodes`. */
export interface FallbackRail {
  /** The folded node's id — the identity the rail keeps after it stops being a
   * node. Both renderers and ⌘F key `DiagramOverrides.labels` off it, so a
   * resource the viewer renamed before it folded still shows, and is still
   * found by, the name they gave it. */
  nodeId: string;
  /** The folded node's own name. Read through `labels[nodeId]` at every draw
   * and match site, never directly — see `nodeId`. */
  name: string;
  /** Short type tag drawn ahead of the name ("DLQ", "ON FAIL", "LOGS"). */
  label: string;
  /** Lines the canvas drops into the rail when the parent is selected —
   * `maxReceiveCount 3`, `retention 14d · fifo false`. May be empty. */
  policy: string[];
}

/** One Application Auto Scaling policy, reduced to the row the inspector draws.
 * Composed in core rather than in the frontend so the canvas rail and the
 * inspector cannot start phrasing the same policy two different ways. */
export interface ScalingPolicy {
  /** The folded policy's id. Kept for the same reason `FallbackRail.nodeId` is:
   * it is the identity a viewer's rename and a ⌘F match key off. */
  nodeId: string;
  name: string;
  /** Which way it moves capacity. `track` covers the policies that move it to a
   * level rather than by an amount — target tracking, which goes both ways, and
   * exact capacity, which goes neither. */
  direction: "up" | "down" | "track";
  /** CloudWatch metric, e.g. `CPUUtilization`. Absent on a step policy whose
   * driving alarm names none. */
  metric?: string;
  /** What makes it fire — `> 70% for 2 min`, `target 65%`. Absent on a step
   * policy with no alarm to read it from: the policy resource does not carry a
   * threshold, so there is nothing honest to print. */
  trigger?: string;
  /** What it does when it fires — `+1`, `−1`, `tracking`. */
  effect: string;
  /** Cooldown in seconds, when the policy declares one. */
  cooldown?: number;
}

/** One container out of a task definition's `container_definitions`, reduced to
 * what the card rail and the inspector show. Counts rather than contents for
 * environment and secrets — a name/value list belongs in the dialog, and a
 * secret's value must never be near either. */
export interface TaskContainer {
  name: string;
  image?: string;
  essential?: boolean;
  ports: number[];
  environmentCount: number;
  secretCount: number;
  logGroup?: string;
}

/** An `aws_ecs_task_definition` folded onto the service that runs it by
 * `foldEcsTopology`. Display-time only: never parsed, never persisted, never
 * written to the canonical stored graph — the same lifecycle as `ScalingSpec`. */
export interface TaskSpec {
  taskNodeId: string;
  taskName: string;
  family?: string;
  cpu?: string;
  memory?: string;
  networkMode?: string;
  launchType?: string;
  requiresCompatibilities: string[];
  containers: TaskContainer[];
  /** True when `container_definitions` could not be read as data — a `file()`
   * or `templatefile()` definition the parser left as a raw string. The panel
   * says so; showing zero containers where there are two is worse than saying
   * it could not read them. */
  containersUnresolved: boolean;
}

/** An `aws_appautoscaling_target` and its policies, folded onto the service they
 * scale by `foldAutoscaling`. Display-time only: never parsed, never persisted,
 * never written to the canonical stored graph. */
export interface ScalingSpec {
  targetNodeId: string;
  targetName: string;
  minCapacity?: number;
  maxCapacity?: number;
  /** The service's own `desired_count`, and ONLY when it is a literal number.
   * The common real spelling is an unresolved interpolation, which must leave
   * this undefined rather than render a capacity marker at a guessed position. */
  desiredCount?: number;
  scalableDimension?: string;
  serviceNamespace?: string;
  policies: ScalingPolicy[];
  /** Alarms this fold also removed — those that existed only to drive these
   * policies. An alarm that also pages elsewhere keeps its node and is absent
   * here, even though its threshold still feeds a policy's `trigger`.
   *
   * Names, not just a count: an alarm is gone as a node, so `computeMatches`
   * indexes these against the service the way it indexes a rail and a policy,
   * and `nodeId` is what a viewer's rename override is still keyed on. */
  foldedAlarms: { nodeId: string; name: string }[];
}

export interface ResourceNode {
  id: string;
  type: ResourceType;
  provider: string;
  name: string;
  resourceType: string;
  attributes: Record<string, unknown>;
  /**
   * Parser provenance: the `attributes`-relative key paths whose value holds
   * data recovered from a `jsonencode(...)` expression rather than written
   * literally. Set by `hclParser` (Terraform HCL is the only source of a
   * decode) and PERSISTED, because it describes where the data came from rather
   * than how some pass chose to draw it.
   *
   * A PATH rather than a top-level key, because hcl2json lifts a nested HCL
   * block to a top-level `attributes` key: one `jsonencode` under an EventBridge
   * pipe's `source_parameters` would otherwise mark that whole block, including
   * the `dead_letter_config` sibling that is provider schema and folds. Array
   * indices are omitted — hcl2json's single-element block arrays are a
   * representation artifact, never an author's choice.
   *
   * `foldFallbackNodes` reads it: inside a decoded document every key is the
   * template author's, so a fallback-shaped one (an ASL state named
   * `OnFailure`, an SSM key named `deadLetterQueue`) is a collision that would
   * DELETE a separately declared resource. Outside one the keys are the
   * provider's schema, and the fold walks them as it always has. Segments are
   * stored in the parser's spelling and normalized by the reader.
   */
  decodedPaths?: string[][];
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  /** Synthesized by the display-time `collapseRouteTables` pass. Never parsed,
   * never persisted. */
  routeTable?: RouteTable;
  /** Folded 1:1 fallback resources, written by TWO display-time passes and
   * appended to, never replaced: `filterGraphForDisplay` stamps a LOGS rail for
   * an owned CloudWatch log group (which it removes as a node, #617), then
   * `foldFallbackNodes` appends everything it folds itself. Never parsed, and
   * never written to the canonical stored graph — but, like
   * `invokePermissionPeers`, the filter-stamped half DOES appear in API
   * responses and in any layout-QA fixture regenerated from filter output. */
  fallbackRails?: FallbackRail[];
  /**
   * How many networking join resources `foldNetworkGlue` found that this node
   * owns — its route-table associations, routes, gateway attachments, instance
   * profile. Same display-time-only lifecycle as `fallbackRails`.
   *
   * Stamped whether or not the joins actually folded, which is the whole point:
   * it is what the per-node caret counts, and the caret has to read the same
   * number in both states or expanding a node would make its own "roll up 3"
   * control disappear.
   */
  networkGlue?: number;
  /** Application Auto Scaling folded onto this service by `foldAutoscaling`.
   * Same display-time-only lifecycle as `fallbackRails`. */
  scaling?: ScalingSpec;
  /** Task definition folded onto this service by `foldEcsTopology`. Same
   * display-time-only lifecycle as `scaling`. */
  task?: TaskSpec;
  /** Ids a dropped `AWS::Lambda::Permission` node linked this node to, stamped
   * by `filterGraphForDisplay` so `collapseRouteTables` can still set a route
   * row's invoke shield once the grant node itself is hidden. Display-time
   * only: never parsed, and never written to the canonical stored graph
   * (it does appear in API responses and in the committed layout-QA fixtures,
   * which are snapshots of filter output). */
  invokePermissionPeers?: string[];
  /** Names of the API Gateway stages that referenced this API, stamped by
   * `filterGraphForDisplay` so `collapseRouteTables` can still show the stage
   * in the table header once the stage node itself is hidden (#673). Same
   * display-time-only lifecycle as `invokePermissionPeers`. */
  apiStageNames?: string[];
  /** Which IaC engine declared this resource. Set by `mergeEngineGraphs` on a
   * multi-engine parse and persisted; absent on single-engine graphs. Also
   * stamped at display time by `extractEventFlows` on a derived event node,
   * which no engine declares — see `resolveEventEngine` for what it inherits
   * from and why `groupByEngine` needs it. */
  engine?: IacEngine;
}

/** Where an ASL transition came from. Lives here rather than in
 * `stateMachine.ts` because `ResourceEdge` carries it and `stateMachine.ts`
 * already imports this module — the other direction would be a cycle. */
export type AslTransitionKind = "next" | "choice" | "default" | "catch";

export interface ResourceEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label?: string;
  /** Set by `expandStateMachines` on a flow edge between two ASL states, so the
   * canvas can colour an error path apart from a happy one. Display-time only,
   * never persisted. */
  aslTransition?: AslTransitionKind;
  direction?: EdgeDirection;
  points?: Array<{ x: number; y: number }>;
  /** Laid-out box for `label`, set by `layoutGraph` only when the Mermaid
   * engine ran (never on the grid fallback) and `label` is set — dagre
   * convention, so `x`/`y` are the box's CENTRE, not its top-left, matching
   * how the canvas places a `FabricText`/`Textbox` via `originX`/`originY:
   * "center"`. See `AdapterResult.edgeLabelRects` for where the numbers
   * come from. */
  labelRect?: { x: number; y: number; width: number; height: number };
  /** Index of the route-table row this edge leaves from. Set by
   * `collapseRouteTables`; drives row-anchored edge geometry. */
  rowIndex?: number;
  /** Set by `collapseRouteTables` on an edge it re-pointed off a folded
   * authorizer onto the API. Marks the edge as "this is what guards the API",
   * NOT "this table owns this λ" — `routeTargetIds` must not count it as an
   * inbound source, or a λ backing one API's authorizer loses its chip column
   * in an unrelated API's table (#654). Display-time only, never persisted. */
  viaAuthorizer?: boolean;
  /** Set by `collapseRouteTables` on a CONTAINS edge it minted to re-parent a
   * dissolved API's child onto the API's own container. Carries MODEL
   * containment (group membership, collapse, hiding, the inspector) but not
   * the "this node is nested in that box, leave its position alone" claim an
   * authored CONTAINS edge makes: the child was placed by a layout that had no
   * such parent, so `placeRouteTargets`' band sweep must still be free to move
   * it off a table's λ column. See `placeRouteTargets`' `nestedIds`.
   * Display-time only, never persisted. */
  viaPromotion?: boolean;
  /**
   * The parent property whose value produced this edge, as the parser spelled
   * it (`redrive_policy`, `redrivePolicy`). Set at PARSE time, unlike the two
   * display-time markers above, and therefore persisted.
   *
   * `foldFallbackNodes` normally recovers this by walking the parent's
   * `attributes` for a fallback-keyed subtree naming the target — which works
   * wherever `attributes` preserves the reference verbatim (CloudFormation's
   * `Ref`/`Fn::GetAtt`, Terraform HCL's `${...}` interpolation). Two parsers
   * destroy it before `attributes` is built: `terraform show -json` resolves
   * `planned_values` to concrete ARNs, and a Pulumi plan replaces every
   * cross-resource reference with an unknown-output sentinel. Both DO still
   * know the property name at the point they mint the edge — from
   * `configuration.*.expressions` and `goal.propertyDependencies` respectively
   * — so they record it here instead.
   *
   * Being persisted means a graph stored before this shipped has no value and
   * folds nothing until re-parsed. That is a real cost, and the reason the
   * attribute walk stays the primary mechanism rather than being replaced by
   * this: the walk reads data every parser has always written, so it fired
   * retroactively on existing CloudFormation and HCL graphs the day it landed.
   */
  viaProperty?: string;
  /**
   * Which networking join resource `foldNetworkGlue` folded away to mint this
   * edge. Display-time only, never persisted — the same contract as
   * `viaAuthorizer` and `viaPromotion`.
   *
   * It is what gives the edge's `label` precedence over every other verb
   * source in `classifyEdgeSemantics`: the fold KNOWS what the relationship is,
   * where the endpoint-type heuristics only guess. Without it a
   * RouteTable → EC2 instance edge reads "invokes", which a route table does
   * not do.
   */
  viaFold?: NetworkGlueKind;
  /** Set by `inferCrossEngineEdges` on an edge inferred from literal string
   * matching across two engines. Best-effort — the canvas renders these dashed
   * and the display filter can hide them. Persisted. */
  inferredCrossEngine?: true;
  /** An authored edge's metadata other than its `kind`. Never set by a parser. */
  attributes?: Record<string, unknown>;
}

/**
 * The networking join resources `foldNetworkGlue` folds. Lives here rather than
 * in that pass because `ResourceEdge` carries one, and an edge type importing
 * from a display pass would invert the dependency every other marker respects.
 *
 * `instanceProfile` is deliberately absent: a profile folds to a RAIL only and
 * mints no edge, so no edge can carry it.
 */
export type NetworkGlueKind = "routeTableAssociation" | "route" | "gatewayAttachment";

export interface GraphMetadata {
  source: ProjectType;
  generatedAt: string;
  sourceFiles?: string[];
  /**
   * The exact id prefixes `mergePrefixedGraphs` used to merge multiple source
   * documents into this graph (one per document, e.g. a CloudFormation stack
   * name or an ARM template's filename stem). `groupByStack` treats a prefix
   * in this list as a real container regardless of what it looks like — the
   * source of truth for "this is a document boundary," not a shape guess.
   * Unset for a graph built from a single document.
   */
  stackPrefixes?: string[];
  /**
   * The author's top-level layout direction, for a hand-authored graph (a
   * Mermaid `direction`). `layoutGraph` uses it when the caller passes no
   * `rankdir`, and `renderMermaid` emits it. Parsers never set it, so an IaC
   * graph keeps the engine's TB default.
   */
  rankdir?: GraphRankdir;
  /** Set on a graph built from ArcSync diagram syntax rather than parsed IaC. */
  authored?: true;
}

export const GRAPH_RANKDIRS = ["TB", "LR"] as const;
export type GraphRankdir = (typeof GRAPH_RANKDIRS)[number];

export interface ArchGraph {
  nodes: ResourceNode[];
  edges: ResourceEdge[];
  metadata: GraphMetadata;
}

/** Repository metadata served alongside a graph, built from its CANON row. */
export interface RepoInfo {
  description?: string;
  topics?: string[];
  license?: string;
  primaryLanguage?: string;
  homepage?: string;
  pushedAt?: string;
  starsCount?: number;
  ownerAvatarUrl?: string;
  displayOwner?: string;
  displayRepo?: string;
  branch?: string;
}

export interface LayoutOptions {
  /** Defaults to the graph's `metadata.rankdir`, then TB. */
  rankdir?: GraphRankdir;
  nodesep?: number;
  ranksep?: number;
  marginx?: number;
  marginy?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  /** Pre-set positions for specific nodes (used for edge-only re-routing). */
  pinnedPositions?: Record<string, { x: number; y: number }>;
  /**
   * Ids withheld from the layout engine: they are given no position here, and
   * every edge incident to one is withheld too. Only the layout INPUT is
   * affected — the returned graph still carries every node and edge it was
   * given.
   *
   * The caller MUST position these nodes itself afterwards (the canvas and the
   * thumbnail both hand this the `routeTargetIds` set that `placeRouteTargets`
   * re-derives). Nothing here is computed for a withheld id, so it comes back
   * carrying whatever `position` it was HANDED IN: none for a node laid out
   * from scratch, but a stale INPUT coordinate for one that already had a
   * position (`positionMap.get(node.id) ?? node.position`). Either way it is a
   * caller bug — deliberately not papered over with an invented coordinate,
   * which would be silently wrong geometry — and the stale-coordinate case is
   * the more misleading of the two, because it is visibly *somewhere* rather
   * than visibly missing.
   *
   * A labelled edge touching a withheld node has no `labelRect` COMPUTED for
   * it, same as its `points` — so a renderer that draws model labels needs a
   * fallback anchor for it, and the canvas has one (a chord-midpoint
   * `FabricText`, the same idiom and anchor its "N routes" count already
   * uses); see the design doc's §2 correction. Same caveat as the node case
   * above: nothing is cleared, only left uncomputed (`...edge` then
   * `...(labelRect ? ... : {})`), so an edge handed in with a `labelRect` from
   * a PREVIOUS layout keeps that stale box. Neither production caller
   * re-lays-out its own output, so this is a contract note, not a live path.
   *
   * `pinnedPositions` wins when an id appears in both: a pin is the caller's
   * own positioning, just applied here rather than after layout, and the
   * containers it sits in are grown around it as usual. Production callers no
   * longer produce that combination — `routeTargetIds`' own `pinned` parameter
   * takes a manually-positioned λ out of the withheld set — but the precedence
   * is defined rather than left to chance for any other caller.
   *
   * A pin is applied AFTER the engine ran, so anything the engine computed for
   * that node describes a coordinate it no longer occupies. Routed `points`
   * stay attached (`resolveEdgeWaypoints` refuses a polyline whose endpoints
   * left their borders; one slid along a border keeps its pre-pin route), but
   * an edge's `labelRect` has no consumer-side
   * validation at all, so `layoutGraph` withholds it from every edge incident
   * to a pinned node — same outcome as an unranked one, and the same renderer
   * fallback catches it.
   *
   * Intended for leaf ids. Withholding a container leaves its children
   * unparented for layout and is not supported. Withholding a container's
   * ONLY child also leaves the container itself with no computed `size` at
   * all (nothing left to size it around), so callers fall back to
   * `NODE_WIDTH`/`NODE_HEIGHT` for it same as any other sizeless node.
   */
  unranked?: ReadonlySet<string>;
}

export type InkColor = "amber" | "red" | "green" | "blue" | "neutral";
export type InkCorners = "sharp" | "rounded";

/**
 * A freehand pen annotation. Geometry is stored as strings, not number
 * arrays: overrides travel as jsondiffpatch deltas, and an array diffs as a
 * splice delta that throws on a receiver whose copy is stale, while a string
 * replaces as one `[old, new]` pair. Encode/decode in `inkStroke.ts`.
 */
export interface InkStroke {
  id: string;
  /** Scene-space centreline, "x y x y …" at one decimal. */
  points: string;
  /** Per-point ribbon width, "w w …", one per point. Absent = uniform `width`. */
  widths?: string;
  width: number;
  color: InkColor;
  corners: InkCorners;
  /** Set when the stroke was drawn over a node — it then follows the node. */
  nodeId?: string;
  author: string;
  createdAt: string;
}

export interface DiagramOverrides {
  positions: Record<string, { x: number; y: number }>;
  labels: Record<string, string>;
  hiddenGroups: string[];
  stickies?: Record<string, StickyNote>;
  strokes?: Record<string, InkStroke>;
  /**
   * Node ids the user removed from this diagram's view. Stored UNEXPANDED —
   * the ids actually deleted, not the CONTAINS cascade they imply, which
   * `resolveDeletedIds` computes at read time so the deletion tracks a
   * container whose membership changed on re-parse.
   *
   * Optional, like `stickies`: absence round-trips as absence rather than
   * materializing `[]`, and every existing empty-overrides literal in the
   * codebase keeps compiling.
   */
  deletedNodes?: string[];
}

/**
 * Whether a graph carries both arrays a pass walks. The passes that run on
 * stored or client-supplied graphs return anything else untouched rather than
 * throwing on a payload that predates a field.
 */
export function hasGraphArrays(graph: ArchGraph | null | undefined): boolean {
  return Array.isArray(graph?.nodes) && Array.isArray(graph?.edges);
}
