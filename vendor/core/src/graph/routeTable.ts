import { resolveContainment } from "./containment.js";
import { NODE_WIDTH } from "./edgeGeometry.js";
import { createEdgeIdMinter } from "./edgeIds.js";
import { PERMISSION_RESOURCE_TYPES } from "./permissionTypes.js";
import { API_TYPES, protocolLabelFor, STAGE_RESOURCE_TYPES, stageNameOf } from "./stageTypes.js";
import type {
  ArchGraph,
  ResourceEdge,
  ResourceNode,
  RouteAuthorizer,
  RouteEdgeSummary,
  RouteGroup,
  RouteTable,
  RouteTableRow,
} from "./types.js";
import { EdgeType, hasGraphArrays, ResourceType } from "./types.js";

export const ROUTE_TABLE_WIDTH = 320;

/** Header-band typography, read by BOTH renderers — the canvas builders in
 * `packages/frontend/src/lib/routeTableNode.ts` and the thumbnail in
 * `packages/backend/src/lib/base/diagramImage.ts`. The two already shared
 * geometry through this module but each carried its own font sizes, which is
 * exactly where they drift; keeping the sizes here means they cannot. */
export const ROUTE_TABLE_HEADER_PAD_Y = 14;
export const ROUTE_TABLE_NAME_FONT = 17;
export const ROUTE_TABLE_HEADER_GAP = 7;
export const ROUTE_TABLE_CHIP_FONT = 12;
export const ROUTE_TABLE_PILL_FONT = 11;
export const ROUTE_TABLE_PILL_PAD_X = 6;
export const ROUTE_TABLE_ICON_SIZE = 28;
export const ROUTE_TABLE_HEADER_INSET = 14;
export const ROUTE_TABLE_ICON_GAP = 10;

/** Fixed slot the right-anchored group count is laid out in. The count is still
 * DRAWN measured and right-anchored at the header inset; this is the width the
 * name's truncation budget reserves for it. Fixed rather than measured because
 * `toggleAllBox` positions the expand-all caret immediately left of this slot
 * and lives in core, which has no font metrics — a caret placed relative to a
 * measured count could not be hit-tested here. 76px clears "999 groups" at
 * ROUTE_TABLE_CHIP_FONT in a monospace stack (~7.2px/char); real tables run to
 * two digits. */
export const ROUTE_TABLE_COUNT_SLOT_W = 76;

/** The header's expand/collapse-all caret: box width, and the gap between it
 * and the count slot to its right. */
export const ROUTE_TABLE_TOGGLE_ALL_W = 18;
export const ROUTE_TABLE_TOGGLE_ALL_GAP = 8;

/** Derived from the band's own contents rather than hardcoded, so a header
 * that no longer fits its text is a wrong constant here instead of a silent
 * clip at draw time. Everything else — `visibleEntries`, `entryAt`,
 * `expandedTableHeight`, edge anchors, the reserved `size.height` — derives
 * from THIS, so they all follow a change automatically. */
export const ROUTE_TABLE_HEADER_H =
  ROUTE_TABLE_HEADER_PAD_Y * 2 +
  ROUTE_TABLE_NAME_FONT +
  ROUTE_TABLE_HEADER_GAP +
  ROUTE_TABLE_CHIP_FONT;

export const ROUTE_TABLE_ROW_H = 34;
export const ROUTE_TABLE_TARGET_GAP = 120;
/** Horizontal room a table reserves for one λ in its post-layout column.
 * Derived, not restated: a column member is drawn as an ordinary NODE_WIDTH
 * card, so a hardcoded copy here means the reservation stops covering the
 * column the moment the card's width moves — which is exactly what left a
 * placed λ hanging 88px out of its own table's reserved band. */
export const ROUTE_TABLE_TARGET_WIDTH = NODE_WIDTH;
/** Height a route-target λ chip renders/reserves at, in a table's column.
 * Strictly less than ROUTE_TABLE_TARGET_PITCH (the column's slot pitch, which is
 * derived from this) so consecutive chips can never overlap, without needing a
 * dynamic de-overlap pass over the column itself. Still expressed relative to
 * ROUTE_TABLE_ROW_H so a chip keeps reading as row-sized beside the table.
 * See `routeTargetIds`. */
export const ROUTE_TABLE_TARGET_CHIP_H = ROUTE_TABLE_ROW_H - 2;

/** Vertical pitch of a table's post-layout λ column: one slot per DISTINCT
 * placed target (see `placeRouteTargets`), never one per row. The +2 is the
 * clearance that keeps consecutive `ROUTE_TABLE_TARGET_CHIP_H` chips from
 * touching.
 *
 * Pitching the column on the ROW index instead is what let a 42-row/3-λ API
 * draw a ~284px table whose λ column still spanned up to ~1,455px (the last
 * distinct λ pinned to whichever row first reaches it): the table's own
 * reserved height became `HEADER + groups * ROUTE_GROUP_ROW_H` while the column
 * kept its pre-collapse per-row pitch, and
 * `growAncestorBoxesForPlacedTargets` unions that column into the enclosing
 * container — so the container stayed ~1,400px tall and the gateway still could
 * not coexist on screen with its λs. Trunk routing is what makes a per-target
 * pitch safe: an edge leaves its row, runs to a shared vertical trunk and only
 * then turns into its λ, so a λ no longer has to sit level with the row that
 * reaches it. */
export const ROUTE_TABLE_TARGET_PITCH = ROUTE_TABLE_TARGET_CHIP_H + 2;

/** Height of a collapsed prefix-group row. From the mock's 30px group rows —
 * deliberately shorter than ROUTE_TABLE_ROW_H so a grouped table reads as a
 * denser summary than the flat row list it replaces. */
export const ROUTE_GROUP_ROW_H = 30;

// Authorizer resource types across all providers. Matched by exact
// resourceType rather than the REST_RESOURCE_TYPE_PATTERN prefix, because that
// pattern deliberately EXCLUDES authorizers from route-target resolution — an
// authorizer is never a route's invoked backend. Here we want the opposite:
// find it precisely, to fold it into the row as a guard.
const AUTHORIZER_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "AWS::ApiGatewayV2::Authorizer",
  "AWS::ApiGateway::Authorizer",
  "aws_apigatewayv2_authorizer",
  "aws_api_gateway_authorizer",
  "aws:apigatewayv2/authorizer:Authorizer",
  "aws:apigateway/authorizer:Authorizer",
  "aws-native:apigatewayv2:Authorizer",
  "aws-native:apigateway:Authorizer",
]);

function authTypeOf(node: ResourceNode): string | undefined {
  const raw =
    node.attributes.AuthorizationType ?? // CloudFormation
    node.attributes.authorization_type ?? // Terraform
    node.attributes.authorizationType; // Pulumi
  return typeof raw === "string" ? raw : undefined;
}

/** `extractAuthorizer`'s result: the row-facing `{ name, type }` plus —
 * only when resolved from a reference edge — the id of the authorizer NODE
 * itself, for the caller to fold into `consumedIds` the same way stage and
 * Route53 children already are (see `collapseRouteTables`). Absent for the
 * AuthorizationType-only fallback, which has no node to fold. Returned
 * alongside the row data rather than via a mutated out-parameter so the
 * function stays a pure resolver. */
interface ResolvedAuthorizer extends RouteAuthorizer {
  nodeId?: string;
}

/** The authorizer guarding a route (v2) or method (REST). Prefers the
 * referenced authorizer RESOURCE — the parsers already resolved
 * `AuthorizerId: {Ref}` / `${aws_..._authorizer.x.id}` into an edge, so
 * walking it is provider-agnostic — and falls back to the bare
 * AuthorizationType. "NONE" is not an authorizer.
 *
 * Only ever inspects the ROUTE's own outbound edges, never the resolved
 * authorizer's — so a Lambda-backed authorizer's backing function (a
 * separate node the authorizer itself references) is never returned here,
 * never folded into `consumedIds`, and stays on the canvas as real compute. */
function extractAuthorizer(
  routeId: string,
  routeNode: ResourceNode,
  nodeById: Map<string, ResourceNode>,
  outBySource: Map<string, ResourceEdge[]>,
): ResolvedAuthorizer | undefined {
  const type = authTypeOf(routeNode);
  for (const edge of outBySource.get(routeId) ?? []) {
    const node = nodeById.get(edge.target);
    if (node && AUTHORIZER_RESOURCE_TYPES.has(node.resourceType)) {
      return { name: node.name, type: type ?? "CUSTOM", nodeId: node.id };
    }
  }
  return type && type !== "NONE" ? { name: type, type } : undefined;
}

// REST (v1) per-status-code response plumbing — folded away like a
// permission, never a row (see buildRestRows' doc comment). Matched by raw
// resourceType, not a ResourceType member: CloudFormation has no standalone
// resource type for either (both nest under AWS::ApiGateway::Method), so
// there is nothing structural these types would ever need to participate in.
const METHOD_RESPONSE_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "aws_api_gateway_method_response", // Terraform
  "aws:apigateway/methodResponse:MethodResponse", // Pulumi
]);
const INTEGRATION_RESPONSE_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "aws_api_gateway_integration_response", // Terraform
  "aws:apigateway/integrationResponse:IntegrationResponse", // Pulumi
]);

export function parseRouteKey(routeKey: string): { method: string; path: string } {
  const trimmed = routeKey.trim();
  if (trimmed === "") return { method: "ANY", path: "/" };
  const gap = trimmed.indexOf(" ");
  // A key with no space is a WebSocket route key ($connect/$disconnect/$default
  // or a custom action) — it has no path, and inventing "/" here put a slash
  // that exists nowhere in the source on every WebSocket row of both renderers.
  // Callers must treat "" as "this route has no path", not as a missing value.
  if (gap === -1) return { method: trimmed, path: "" };
  return { method: trimmed.slice(0, gap), path: trimmed.slice(gap + 1).trim() };
}

/** What a row builder hands back: the rows themselves, every node id folded
 * into them (`consumedIds`, which the caller removes from the graph), and —
 * separately, as a subset of that — the ids of the authorizer NODES folded
 * away. The caller needs those on their own to re-point each authorizer's edge
 * to its backing Lambda at the API (see `collapseRouteTables`); a row only
 * carries the authorizer's `{ name, type }`, never its node id. */
interface RowBuild {
  rows: RouteTableRow[];
  consumedIds: Set<string>;
  authorizerNodeIds: Set<string>;
}

/** Builds rows for a v2 (HTTP/WebSocket) API from its CONTAINS'd routes —
 * the shape `collapseIntegrations` pre-wires (see `collapseRouteTables`'s doc
 * comment). Unchanged behavior, extracted verbatim so it can sit alongside
 * the REST path below. */
function buildV2Rows(
  apiNode: ResourceNode,
  routeIds: string[],
  nodeById: Map<string, ResourceNode>,
  outBySource: Map<string, ResourceEdge[]>,
): RowBuild {
  const rows: RouteTableRow[] = [];
  const consumedIds = new Set<string>();
  const authorizerNodeIds = new Set<string>();
  for (const routeId of routeIds) {
    const routeNode = nodeById.get(routeId);
    if (!routeNode) continue;
    // RouteKey is the CloudFormation spelling; hclParser/pulumiParser store
    // raw provider attributes verbatim, so Terraform and Pulumi need their
    // own casings checked too — see routeTable.test.ts's per-provider cases.
    const rawKey =
      routeNode.attributes.RouteKey ?? // CloudFormation
      routeNode.attributes.route_key ?? // Terraform (aws_apigatewayv2_route)
      routeNode.attributes.routeKey; // Pulumi (aws:apigatewayv2/route:Route)
    const routeKey = typeof rawKey === "string" ? rawKey : routeNode.name;
    const { method, path } = parseRouteKey(routeKey);
    // Excludes an authorizer target the same way findRestBackend/isRestPlumbing
    // already excludes one on the REST path: a route's AuthorizerId/
    // authorizer_id produces a REFERENCE edge exactly like its real
    // integration target, and without this exclusion a route whose authorizer
    // edge happens to sort first would wrongly become the row's targetId —
    // and since a resolved authorizer node is folded away below (see
    // extractAuthorizer), that targetId would dangle, pointing at a node no
    // longer in the graph.
    const targetEdge = (outBySource.get(routeId) ?? []).find((e) => {
      if (e.target === apiNode.id) return false;
      const candidate = nodeById.get(e.target);
      return candidate !== undefined && !AUTHORIZER_RESOURCE_TYPES.has(candidate.resourceType);
    });
    const authorizer = extractAuthorizer(routeId, routeNode, nodeById, outBySource);
    if (authorizer?.nodeId) {
      consumedIds.add(authorizer.nodeId);
      authorizerNodeIds.add(authorizer.nodeId);
    }
    rows.push({
      method,
      path,
      targetId: targetEdge?.target,
      integrationName: targetEdge?.label,
      hasInvokePermission: false,
      sourceRouteId: routeId,
      authorizer: authorizer ? { name: authorizer.name, type: authorizer.type } : undefined,
    });
    consumedIds.add(routeId);
  }
  return { rows, consumedIds, authorizerNodeIds };
}

/** A resource's leaf path segment, checked across every provider's casing. */
function restPathPart(node: ResourceNode): string {
  const raw =
    node.attributes.PathPart ?? // CloudFormation
    node.attributes.path_part ?? // Terraform (aws_api_gateway_resource)
    node.attributes.pathPart; // Pulumi (aws:apigateway/resource:Resource)
  return typeof raw === "string" ? raw : node.name;
}

/** A method's HTTP verb, checked across every provider's casing. Falls back
 * to "ANY" — API Gateway's own catch-all verb — when unreadable, mirroring
 * `parseRouteKey`'s fallback for an empty v2 route key. */
function restHttpMethod(node: ResourceNode): string {
  const raw =
    node.attributes.HttpMethod ?? // CloudFormation
    node.attributes.http_method ?? // Terraform (aws_api_gateway_method)
    node.attributes.httpMethod; // Pulumi (aws:apigateway/method:Method)
  return typeof raw === "string" && raw.trim() !== "" ? raw : "ANY";
}

function findNeighborOfType(
  nodeId: string,
  type: ResourceType,
  neighbors: Map<string, Set<string>>,
  nodeById: Map<string, ResourceNode>,
): ResourceNode | undefined {
  for (const id of neighbors.get(nodeId) ?? []) {
    const node = nodeById.get(id);
    if (node?.type === type) return node;
  }
  return undefined;
}

// Any API Gateway (v1 or v2) sub-resource, matched by raw resourceType prefix
// rather than enumerating every `ResourceType` member. Most REST sub-resources
// (deployment, authorizer, model, request validator, gateway response, VPC
// link, ...) have no dedicated `ResourceType` — `mapResourceType` falls them
// all back to `ResourceType.UNKNOWN` — so a type-enum check alone would
// under-exclude: e.g. a `aws_api_gateway_deployment`'s conventional
// `depends_on = [aws_api_gateway_integration.x]` produces a REFERENCE edge
// that makes the deployment an (undirected) neighbor of the integration, and
// an `AWS::ApiGateway::Method`'s `AuthorizerId: {Ref: ...}` does the same for
// a custom authorizer. Neither is ever a route's actual invoked backend.
// `aws-native:apigateway(v2)?:` is the aws-native spelling, same prefix shape
// as the classic `aws:` one.
const REST_RESOURCE_TYPE_PATTERN =
  /^(aws_api_gateway_|aws_apigatewayv2_|AWS::ApiGateway(?:V2)?::|aws:apigateway\/|aws:apigatewayv2\/|aws-native:apigateway(?:v2)?:)/;

// Any IAM resource, matched by the same raw-resourceType-prefix approach as
// `REST_RESOURCE_TYPE_PATTERN` and for the identical reason: `aws_iam_role`/
// `aws_iam_policy` have dedicated `ResourceType` members, but the sub-resources
// an "AWS"-type integration's `credentials` chain can otherwise drag in as a
// neighbor — `aws_iam_role_policy`, `aws_iam_role_policy_attachment`,
// `aws_iam_policy_attachment`, an inline `AWS::IAM::ManagedPolicy`, etc. — do
// not, and fall back to `ResourceType.UNKNOWN` just like the API Gateway case
// above. None of these is ever a route's invoked backend.
const IAM_RESOURCE_TYPE_PATTERN = /^(aws_iam_|AWS::IAM::|aws:iam\/|aws-native:iam:)/;

/** REST (v1) API Gateway "plumbing" — every node that can end up an
 * incidental neighbor of a method/integration without ever being a row's
 * backend: the API Gateway resource tree itself, any IAM role/policy/
 * attachment an "AWS"-type integration references via `credentials` (an
 * execution role, never the invoked service — see
 * `REST_RESOURCE_TYPE_PATTERN`/`IAM_RESOURCE_TYPE_PATTERN`), and Lambda-invoke
 * permissions (folded separately, see `collapseRouteTables`' permission
 * loop). Anything else IS the backend, whatever its resource type. */
function isRestPlumbing(node: ResourceNode): boolean {
  return (
    REST_RESOURCE_TYPE_PATTERN.test(node.resourceType) ||
    IAM_RESOURCE_TYPE_PATTERN.test(node.resourceType) ||
    PERMISSION_RESOURCE_TYPES.has(node.resourceType)
  );
}

/**
 * Resolves a REST integration's real backend: the node `nodeId` itself
 * references (a DIRECTED outbound edge, not undirected adjacency) that isn't
 * API Gateway plumbing (see `isRestPlumbing`). Directed on purpose — the
 * backend reference always originates FROM the method/integration (its own
 * `uri`/uri-equivalent points AT the backend), so restricting to outbound
 * edges excludes anything that merely references INTO this node instead
 * (e.g. a deployment's `depends_on`), without needing to enumerate every such
 * reverse-reference shape. An API Gateway integration can invoke Lambda,
 * Step Functions, SQS, SNS, DynamoDB, Kinesis, an HTTP endpoint, or nothing
 * at all (MOCK) — this makes no assumption about which. When more than one
 * non-plumbing outbound reference exists, the lowest node id wins: an
 * arbitrary but stable tiebreak so the same graph always resolves the same
 * row the same way.
 */
function findRestBackend(
  nodeId: string,
  outBySource: Map<string, ResourceEdge[]>,
  nodeById: Map<string, ResourceNode>,
): ResourceNode | undefined {
  let best: ResourceNode | undefined;
  for (const edge of outBySource.get(nodeId) ?? []) {
    const node = nodeById.get(edge.target);
    if (!node || isRestPlumbing(node)) continue;
    if (!best || node.id < best.id) best = node;
  }
  return best;
}

/**
 * Builds rows for a REST (v1) API. Unlike v2, whose routes and λs
 * `collapseIntegrations` pre-wires into CONTAINS children with a labeled
 * route→λ edge, REST gets no such pre-pass — `collapseIntegrations` only
 * ever looks at `APIGW_V2_INTEGRATION` nodes. Every `aws_api_gateway_*` child
 * is discovered here directly off the raw REFERENCE edges the parsers emit
 * for `rest_api_id`/`RestApiId`/`restApi` (every REST sub-resource carries
 * one, so a direct edge to `apiNode` is what makes a node "this API's").
 *
 * A REST resource's path is not carried on one node the way a v2 `route_key`
 * string is — resources form a tree via `parent_id`/`ParentId`/`parentId`
 * edges rooted at the API — so the path is reconstructed by walking that
 * tree to the root and joining `path_part` segments. A method with no
 * resource neighbor is attached directly to the root ("/").
 *
 * The integration is usually its own node (Terraform/Pulumi); CloudFormation
 * always inlines Integration as a nested property of Method, so there is
 * never a separate node there — the backend reference lands directly on the
 * method instead. Falling back to the method's own outbound references when
 * no integration node is found covers both shapes with one code path. The
 * backend itself can be Lambda, Step Functions, SQS, SNS, DynamoDB, Kinesis,
 * an HTTP endpoint, or nothing (MOCK) — `findRestBackend` resolves to
 * whatever non-plumbing reference is there, making no assumption about its
 * type. When an integration is MOCK/HTTP-proxy/etc. with no such reference,
 * the row keeps its `integrationName` but `targetId` stays undefined — the
 * same "row with no target" shape a v2 non-Lambda route already produces.
 *
 * Deliberately NOT disambiguated: two methods on the same resource whose
 * integrations don't cross-reference their method (e.g. both hardcode
 * `http_method = "POST"` as a literal instead of referencing
 * `aws_api_gateway_method.x.http_method`) produce no method↔integration edge
 * at all, so that row's target is conservatively left unset rather than
 * guessed. This never mis-wires a row to the wrong λ; it only omits one in
 * an already-unusual authoring pattern.
 */
function buildRestRows(
  apiNode: ResourceNode,
  orderedNodes: ResourceNode[],
  nodeById: Map<string, ResourceNode>,
  neighbors: Map<string, Set<string>>,
  outBySource: Map<string, ResourceEdge[]>,
): RowBuild {
  const apiNeighbors = neighbors.get(apiNode.id) ?? new Set<string>();
  const directedTargets = (id: string): string[] =>
    (outBySource.get(id) ?? []).map((e) => e.target);

  const resourceIds = new Set(
    [...apiNeighbors].filter((id) => nodeById.get(id)?.type === ResourceType.APIGW_REST_RESOURCE),
  );
  const consumedIds = new Set<string>(resourceIds);
  for (const id of apiNeighbors) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (
      node.type === ResourceType.APIGW_REST_METHOD ||
      node.type === ResourceType.APIGW_REST_INTEGRATION ||
      METHOD_RESPONSE_RESOURCE_TYPES.has(node.resourceType) ||
      INTEGRATION_RESPONSE_RESOURCE_TYPES.has(node.resourceType)
    ) {
      consumedIds.add(id);
    }
  }

  // Parent resource id for every discovered resource node; absent means the
  // resource hangs directly off the API root. Must walk the DIRECTED
  // child→parent edge, not `neighbors` — resource↔resource adjacency is
  // symmetric (a parent and its child are each other's undirected neighbor),
  // so an undirected lookup would let a resource "find" its own child as a
  // candidate parent just as readily as its real parent.
  const parentOf = new Map<string, string | undefined>();
  for (const id of resourceIds) {
    const parent = directedTargets(id).find((t) => t !== apiNode.id && resourceIds.has(t));
    parentOf.set(id, parent);
  }

  const pathCache = new Map<string, string>();
  function resolvePath(resourceId: string, visiting: Set<string>): string {
    const cached = pathCache.get(resourceId);
    if (cached !== undefined) return cached;
    if (visiting.has(resourceId)) return ""; // defensive cycle guard
    visiting.add(resourceId);
    const node = nodeById.get(resourceId);
    const segment = node ? restPathPart(node) : "";
    const parentId = parentOf.get(resourceId);
    const parentPath = parentId ? resolvePath(parentId, visiting) : "";
    const full = `${parentPath}/${segment}`;
    pathCache.set(resourceId, full);
    return full;
  }

  const rows: RouteTableRow[] = [];
  const authorizerNodeIds = new Set<string>();
  for (const node of orderedNodes) {
    if (node.type !== ResourceType.APIGW_REST_METHOD || !apiNeighbors.has(node.id)) continue;

    const resourceId = directedTargets(node.id).find((t) => resourceIds.has(t));
    const path = resourceId ? resolvePath(resourceId, new Set()) || "/" : "/";
    const method = restHttpMethod(node);

    const integration = findNeighborOfType(
      node.id,
      ResourceType.APIGW_REST_INTEGRATION,
      neighbors,
      nodeById,
    );
    const target = integration
      ? findRestBackend(integration.id, outBySource, nodeById)
      : findRestBackend(node.id, outBySource, nodeById);

    const authorizer = extractAuthorizer(node.id, node, nodeById, outBySource);
    if (authorizer?.nodeId) {
      consumedIds.add(authorizer.nodeId);
      authorizerNodeIds.add(authorizer.nodeId);
    }
    rows.push({
      method,
      path,
      targetId: target?.id,
      integrationName: integration?.name,
      hasInvokePermission: false,
      sourceRouteId: node.id,
      authorizer: authorizer ? { name: authorizer.name, type: authorizer.type } : undefined,
    });
  }

  return { rows, consumedIds, authorizerNodeIds };
}

// Cognito resource types across every provider spelling — what a
// COGNITO_USER_POOLS authorizer names in `ProviderARNs`/`provider_arns`, and
// what a v2 JWT authorizer's issuer/audience resolves to. Prefix-matched for
// the same reason REST_RESOURCE_TYPE_PATTERN is: most of these fall back to
// `ResourceType.UNKNOWN` and have no enum member to check.
const COGNITO_RESOURCE_TYPE_PATTERN =
  /^(aws_cognito_|AWS::Cognito::|aws:cognito\/|aws-native:cognito:)/;

/**
 * Every node a folded authorizer references, other than plumbing — paired with
 * the label the re-pointed edge should carry.
 *
 * ALL of them, not the single "best" one. Folding the authorizer drops every
 * edge leaving it, so any reference omitted here becomes an island; and picking
 * one by `findRestBackend`'s lowest-node-id tiebreak means an arbitrary id
 * ordering decides which reference survives the fold — a Cognito authorizer's
 * user pool and its backing Lambda are both things the API is guarded BY, and
 * there is no reason to keep one and strand the other. Transferring a folded
 * node's edges to the node it folded into is the normal meaning of a fold.
 *
 * The LABEL is where the discrimination belongs. `"authorizer"` is a claim, and
 * it is only warranted for the Lambda the authorizer invokes or the Cognito
 * pool it validates against. Everything else keeps whatever label the ORIGINAL
 * edge carried, because the parsers emit REFERENCE edges from more than the
 * authorizer's functional attributes: `hclParser` scans the whole resource
 * block (so a `depends_on = [aws_cloudwatch_log_group.x]` becomes an edge) and
 * `pulumiParser` reads `goal.dependencies` the same way. Re-labelling one of
 * those would upgrade an ordering constraint into "the API is guarded by a log
 * group" — a relationship the template never describes.
 *
 * `isRestPlumbing` still filters the edge set itself: the API Gateway resource
 * tree (including the authorizer's own edge back to the API, which is what
 * keeps this from ever emitting a self-edge), the IAM role an
 * `authorizer_credentials` chain drags in, and Lambda permissions. A JWT
 * authorizer references nothing at all and yields an empty list.
 */
// The attributes that actually name what an authorizer is backed BY, across
// every provider spelling: the invoked Lambda's URI, and a Cognito authorizer's
// user-pool ARNs. An edge is only "authorizer" if the target is named in one of
// these — see `namedInFunctionalAttribute`.
const AUTHORIZER_BACKING_ATTRIBUTES = [
  "AuthorizerUri", // CloudFormation
  "authorizer_uri", // Terraform
  "authorizerUri", // Pulumi
  "ProviderARNs", // CloudFormation, Cognito
  "provider_arns", // Terraform, Cognito
  "providerArns", // Pulumi, Cognito
] as const;

/** Whether `token` appears in `haystack` as a whole reference token rather than
 * as part of a longer identifier.
 *
 * A bare `includes` is not good enough here, and gets the SAME bug class wrong
 * that this check exists to fix: a Terraform `authorizer_uri` of
 * `${aws_lambda_function.auth_fn.invoke_arn}` contains the string "auth", so an
 * unrelated λ named `auth` — precisely the incidental `depends_on` reference
 * #653 is about — would match its own backing. Requiring the neighbours to be
 * non-identifier characters lets `auth_fn` match inside `.auth_fn.` while
 * rejecting `auth`, since the `_` that follows it is an identifier character.
 * Every reference syntax we care about delimits with `.`, `"`, `[`, `/`, `:`
 * or `$`, all of which qualify. */
export function containsReferenceToken(haystack: string, token: string): boolean {
  if (token === "") return false;
  const isIdentifierChar = (ch: string) => /[A-Za-z0-9_-]/.test(ch);
  let from = 0;
  while (true) {
    const at = haystack.indexOf(token, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + token.length] ?? "";
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) return true;
    from = at + 1;
  }
}

/**
 * Whether `target` is named inside one of the authorizer's backing attributes.
 *
 * Every parser preserves raw properties verbatim (`cfnParser` keeps
 * `resource.Properties`, `hclParser` the config block, `pulumiParser` the
 * goal's inputs), so an authorizer carries the URI that names its function —
 * but as an unresolved fragment: CloudFormation leaves a `Fn::Join` around an
 * `Fn::GetAtt` on the logical id, Terraform an `${aws_lambda_function.x.arn}`
 * interpolation. Rather than re-implement each provider's reference syntax, we
 * serialize the attribute and look for the target's own id or name as a whole
 * reference token — see `containsReferenceToken` for why a bare substring match
 * is not good enough.
 */
function namedInFunctionalAttribute(authorizer: ResourceNode, target: ResourceNode): boolean {
  for (const key of AUTHORIZER_BACKING_ATTRIBUTES) {
    const raw = authorizer.attributes[key];
    if (raw === undefined) continue;
    const serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (
      containsReferenceToken(serialized, target.id) ||
      containsReferenceToken(serialized, target.name)
    ) {
      return true;
    }
  }
  return false;
}

function authorizerBackings(
  authorizer: ResourceNode,
  outBySource: Map<string, ResourceEdge[]>,
  nodeById: Map<string, ResourceNode>,
): { node: ResourceNode; label?: string }[] {
  // Whether this authorizer declares its backing at all. When it does, the
  // attribute is authoritative and a reference NOT named in it is incidental
  // (the `depends_on` case, #653). When it does not — a hand-authored fixture,
  // or a provider spelling we have not enumerated — fall back to the resource
  // type, which is what shipped before and is right far more often than not.
  const declaresBacking = AUTHORIZER_BACKING_ATTRIBUTES.some(
    (key) => authorizer.attributes[key] !== undefined,
  );
  const backings: { node: ResourceNode; label?: string }[] = [];
  for (const edge of outBySource.get(authorizer.id) ?? []) {
    const node = nodeById.get(edge.target);
    if (!node || isRestPlumbing(node)) continue;
    const couldGuard =
      node.type === ResourceType.LAMBDA_FUNCTION ||
      COGNITO_RESOURCE_TYPE_PATTERN.test(node.resourceType);
    const guardsTheApi =
      couldGuard && (declaresBacking ? namedInFunctionalAttribute(authorizer, node) : true);
    backings.push({ node, label: guardsTheApi ? "authorizer" : edge.label });
  }
  return backings;
}

/**
 * Collapses each API Gateway container into a single sized leaf node carrying a
 * `routeTable`. Display-time only — never persisted. For v2 APIs this runs
 * after `collapseIntegrations`, whose output shape (API CONTAINS its routes
 * and λs; each route has a labeled REFERENCE edge to its λ) it consumes. REST
 * (v1) APIs get no such pre-pass — `collapseIntegrations` never touches them
 * — so their rows are built directly off raw REFERENCE edges; see
 * `buildRestRows`'s doc comment for that shape.
 */
export function collapseRouteTables(graph: ArchGraph): ArchGraph {
  if (!hasGraphArrays(graph)) return graph;
  const apiNodes = graph.nodes.filter((n) => API_TYPES.has(n.type));
  if (apiNodes.length === 0) return graph;

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const containsBySource = new Map<string, ResourceEdge[]>();
  const outBySource = new Map<string, ResourceEdge[]>();
  for (const edge of graph.edges) {
    if (edge.type === EdgeType.CONTAINS) {
      const list = containsBySource.get(edge.source);
      if (list) list.push(edge);
      else containsBySource.set(edge.source, [edge]);
      continue;
    }
    const outs = outBySource.get(edge.source);
    if (outs) outs.push(edge);
    else outBySource.set(edge.source, [edge]);
  }

  const neighbors = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = neighbors.get(a);
    if (set) set.add(b);
    else neighbors.set(a, new Set([b]));
  };
  for (const edge of graph.edges) {
    if (edge.type === EdgeType.CONTAINS) continue;
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }
  const noNeighbors: ReadonlySet<string> = new Set();
  const neighborsOf = (id: string): ReadonlySet<string> => neighbors.get(id) ?? noNeighbors;
  const permissionIds = graph.nodes
    .filter((n) => PERMISSION_RESOURCE_TYPES.has(n.resourceType))
    .map((n) => n.id);

  // A node's effective container is the source of the first CONTAINS edge
  // naming it, so that is the only one whose removal can leave it parentless.
  const containerOf = resolveContainment(graph).parentOf;

  const removedNodes = new Set<string>();
  const removedEdges = new Set<string>();
  const tableByApiId = new Map<string, RouteTable>();
  const newEdges: ResourceEdge[] = [];
  /** Children of a dissolved API container, queued for promotion to its parent. */
  const pendingPromotions: Array<{ parentId: string; childId: string }> = [];
  const nextEdgeId = createEdgeIdMinter(graph.edges);

  for (const apiNode of apiNodes) {
    const containsEdges = containsBySource.get(apiNode.id) ?? [];
    let rows: RouteTableRow[];
    let consumedIds: Set<string>;
    let authorizerNodeIds: Set<string>;

    if (apiNode.type === ResourceType.APIGW_REST_API) {
      ({ rows, consumedIds, authorizerNodeIds } = buildRestRows(
        apiNode,
        graph.nodes,
        nodeById,
        neighbors,
        outBySource,
      ));
      if (rows.length === 0) continue;
    } else {
      const routeIds = containsEdges
        .map((e) => e.target)
        .filter((id) => nodeById.get(id)?.type === ResourceType.APIGW_V2_ROUTE);
      if (routeIds.length === 0) continue;
      ({ rows, consumedIds, authorizerNodeIds } = buildV2Rows(
        apiNode,
        routeIds,
        nodeById,
        outBySource,
      ));
    }
    for (const id of consumedIds) removedNodes.add(id);

    // In the display pipeline the permission nodes are already gone —
    // `filterGraphForDisplay` hides them and stamps each surviving neighbour
    // with the other survivors of that same grant, so the API carries the ids
    // it was granted invoke on. Equivalent to the node-walking loop below by
    // construction (a stamped peer is a surviving neighbour of a permission
    // that also neighboured this API), and the two coexist so an unfiltered
    // graph — every other caller, and every route-table test that hand-builds
    // one — still resolves its shields the original way.
    const granted = new Set(apiNode.invokePermissionPeers ?? []);
    for (const row of rows) {
      if (row.targetId && granted.has(row.targetId)) row.hasInvokePermission = true;
    }

    // Folding the authorizer node would otherwise strand whatever it
    // references: the edge filter below drops every edge touching a removed
    // node, and `authorizer → authorizerFn` (or `→ userPool`) is one of them —
    // leaving that node on the canvas with nothing attached to it. Re-point
    // those edges at the API, so what guards it stays connected to it. A JWT
    // authorizer references nothing and contributes no edge. A node that is
    // ALSO one of this table's row targets already has its own row edge (with a
    // `rowIndex`, which drives trunk routing); a second, rowIndex-less edge
    // would draw a stray extra line into the same chip.
    const rowTargetIds = new Set(rows.flatMap((row) => (row.targetId ? [row.targetId] : [])));
    const authorizerBackingIds = new Set<string>();
    for (const authorizerId of authorizerNodeIds) {
      const authorizer = nodeById.get(authorizerId);
      if (!authorizer) continue;
      for (const { node, label } of authorizerBackings(authorizer, outBySource, nodeById)) {
        if (authorizerBackingIds.has(node.id) || rowTargetIds.has(node.id)) continue;
        authorizerBackingIds.add(node.id);
        newEdges.push({
          id: nextEdgeId(),
          source: apiNode.id,
          target: node.id,
          type: EdgeType.REFERENCE,
          label,
          viaAuthorizer: true,
        });
      }
    }

    // A permission folds into a row when it references both this API and the
    // row's λ. Permissions wired to a λ but not this API belong elsewhere and
    // are left as nodes. Attribution is per-(API, Lambda) pair: if two routes
    // share one target Lambda, a single permission to that Lambda flags both
    // rows, since the graph does not model SourceArn method/path scoping.
    for (const permissionId of permissionIds) {
      const nb = neighbors.get(permissionId);
      if (!nb?.has(apiNode.id)) continue;
      let folded = false;
      for (const row of rows) {
        if (row.targetId && nb.has(row.targetId)) {
          row.hasInvokePermission = true;
          folded = true;
        }
      }
      if (folded) removedNodes.add(permissionId);
    }

    // Domain chip first, then stage: "api.example.com · prod".
    const chips: string[] = [];
    for (const containsEdge of containsEdges) {
      const child = nodeById.get(containsEdge.target);
      if (child?.type !== ResourceType.ROUTE53_RECORD) continue;
      chips.push(child.name);
      removedNodes.add(child.id);
    }

    // Stages resolve two ways, and both have to exist (#673).
    //
    // Off the graph: no parser emits `api --contains--> stage`, so the walk
    // above never reached one and the stage chip was permanently absent. What
    // they DO emit is a reference the other way (`stage → api`, via
    // `ApiId`/`api_id`/`apiId`), which is what `neighbors` indexes.
    //
    // Off the stamp: in the display pipeline `filterGraphForDisplay` has
    // already hidden the stage node by the time this pass runs, so there is no
    // node left to walk to — it leaves `apiStageNames` behind instead, exactly
    // as it does for `invokePermissionPeers`. The two paths coexist rather than
    // one replacing the other, so an unfiltered graph (every other caller, and
    // every route-table test that hand-builds one) still resolves its stage the
    // structural way.
    const stageChips = new Set(apiNode.apiStageNames ?? []);
    for (const neighborId of neighborsOf(apiNode.id)) {
      const neighbor = nodeById.get(neighborId);
      if (!neighbor || !STAGE_RESOURCE_TYPES.has(neighbor.resourceType)) continue;
      stageChips.add(stageNameOf(neighbor));

      // Fold the NODE away only when the chip is all it carried. Removal drops
      // every edge incident to it, so a stage that also references something
      // else — an access-log group, a shared deployment — would strand that
      // node with nothing attached to it.
      //
      // Re-pointing those edges at the API (what the authorizer fold above
      // does) was the other option and it is worse here. An authorizer has one
      // backing and a meaningful label; stages are plural per API and routinely
      // share a target, so N stages on one log group mint N identical edges,
      // and a target already wired to the API gains a redundant anti-parallel
      // one. Worse, an unmarked re-point into a λ that is another table's row
      // target fails `routeTargetIds`' single-owner test and silently costs it
      // its λ-column slot — the regression `viaAuthorizer` exists to prevent.
      //
      // Keeping the node costs one box, and only on the UNFILTERED path: the
      // display filter hides stages outright, so that path is the canvas "show
      // hidden resources" reveal — where the user has explicitly asked to see
      // exactly this node, still attached to its API and its log group.
      //
      // The test below deliberately asks "does it reference anything else that
      // exists?" rather than "would folding strand anything?". The stricter
      // question is the one answerable from `nodeById`/`neighbors` alone, both
      // built before this loop opens and never written inside it — so the
      // answer cannot depend on which API is visited first. Consulting
      // `removedNodes` would fold a few more stages (one whose only other
      // neighbour is a permission this same iteration just folded) at the cost
      // of reintroducing exactly that order-dependence.
      const foldable = [...neighborsOf(neighbor.id)].every(
        (id) => id === apiNode.id || !nodeById.has(id),
      );
      if (foldable) removedNodes.add(neighbor.id);
    }
    chips.push(...[...stageChips].sort());

    tableByApiId.set(apiNode.id, {
      rows,
      chips,
      protocolLabel: protocolLabelFor(apiNode),
      groups: groupRoutesByPrefix(rows),
      authorizers: [...new Set(rows.flatMap((r) => (r.authorizer ? [r.authorizer.name] : [])))],
    });

    // Dissolving the API container must PROMOTE its surviving children to the
    // API's own parent, not orphan them. `groupByStack` skips every node that
    // is already contained (an integration λ is a CONTAINS child of its API
    // after `collapseIntegrations`), so those λs never got a stack edge of
    // their own — dropping the API's edges without this left them with no
    // container at all, laid out at the root outside their stack's box with
    // every edge back into the stack stretched across the diagram. In a CDK
    // or CloudFormation project every resource belongs to a stack, so a
    // surviving node must never come out of this pass parentless.
    const apiParentId = containerOf.get(apiNode.id);
    for (const containsEdge of containsEdges) {
      removedEdges.add(containsEdge.id);
      // Only the child whose EFFECTIVE parent is this API is losing its
      // container here; one that resolves to a different first parent keeps
      // that one and needs no promotion.
      if (apiParentId !== undefined && containerOf.get(containsEdge.target) === apiNode.id) {
        pendingPromotions.push({ parentId: apiParentId, childId: containsEdge.target });
      }
    }

    rows.forEach((row, rowIndex) => {
      if (!row.targetId) return;
      newEdges.push({
        id: nextEdgeId(),
        source: apiNode.id,
        target: row.targetId,
        type: EdgeType.REFERENCE,
        label: row.integrationName,
        rowIndex,
      });
    });
  }

  if (tableByApiId.size === 0) return graph;

  const nodes = graph.nodes
    .filter((n) => !removedNodes.has(n.id))
    .map((n) => {
      const table = tableByApiId.get(n.id);
      if (!table) return n;
      return {
        ...n,
        routeTable: table,
        // Reserved LAYOUT footprint, not the drawn size — Dagre must budget
        // room for the table plus its post-layout λ column (placeRouteTargets
        // moves those λs to `ROUTE_TABLE_WIDTH + ROUTE_TABLE_TARGET_GAP` past
        // the table, or FURTHER when it has to steer the column clear of
        // something — see `clearColumn`, the one thing in this pipeline that
        // can leave the footprint reserved here) or a neighboring stack's box lands on top of that
        // column. Every renderer/anchor must keep using ROUTE_TABLE_WIDTH,
        // the drawn width, not this.
        size: {
          width: ROUTE_TABLE_WIDTH + ROUTE_TABLE_TARGET_GAP + ROUTE_TABLE_TARGET_WIDTH,
          // The COLLAPSED height — one row per prefix group, every group shut.
          // Reserving the fully-expanded row height instead is what made this
          // node ~1,400px tall and unable to coexist on screen with the λs it
          // points at. Expanding a group re-runs layout (canvas-view.ts) rather
          // than being budgeted for here.
          height: ROUTE_TABLE_HEADER_H + table.groups.length * ROUTE_GROUP_ROW_H,
        },
      };
    });

  const edges = graph.edges.filter(
    (e) => !removedEdges.has(e.id) && !removedNodes.has(e.source) && !removedNodes.has(e.target),
  );

  const collapsed: ArchGraph = {
    nodes,
    edges: [...edges, ...newEdges],
    metadata: graph.metadata,
  };
  if (pendingPromotions.length === 0) return collapsed;

  // Deferred to here, and computed against the COLLAPSED graph, because the
  // filter below is a question only the finished graph can answer:
  // `stillContained` reads the surviving CONTAINS edges, which is not
  // decidable from inside the per-API loop.
  //
  // Promotion is now UNCONDITIONAL for a surviving child whose effective
  // parent was the dissolved API — including one `placeRouteTargets` will
  // relocate into its table's own λ column. That relocation no longer costs
  // it a rank: `LayoutOptions.unranked` (see layoutGraph.ts) withholds every
  // column-placed λ, and every edge touching it, from the layout engine
  // entirely, so giving it a CONTAINS edge here cannot make Dagre reserve
  // rank-space for it — both `growContainersToFitChildren` (success path) and
  // `computeContainerBounds` (the grid-fallback path this promoted edge now
  // also newly reaches) skip a child with no computed position, and the
  // success path's cluster rects are built from the withheld subgraph, never
  // the promoted edge. What promotion buys a column-placed λ is a container
  // in the OUTPUT graph — the same one its stack's box is grown around by
  // `growAncestorBoxesForPlacedTargets` below — so canvas grouping/collapse
  // never sees a λ with no parent at all.
  // A child two APIs both claimed (`collapseIntegrations` mints one CONTAINS
  // edge per api/child pair) keeps the surviving claim when only one of them
  // dissolves, and does not also gain a promoted one.
  //
  // This is HYGIENE. It has outlived two justifications already — geometry
  // stopped needing it at #771 (promotions are appended after
  // `collapsed.edges`, so a surviving authored claim wins under
  // first-parent-wins) and collapse at #773 — and deletion, the one
  // multi-parent consumer a duplicate could hurt, only ever resolves against a
  // pre-collapse graph. Keep it, but do not write a third mechanism down here
  // without checking that a test can turn red for it.
  const stillContained = new Set(
    collapsed.edges.filter((e) => e.type === EdgeType.CONTAINS).map((e) => e.target),
  );
  const promotions = pendingPromotions
    .filter(
      ({ parentId, childId }) =>
        !removedNodes.has(childId) &&
        // Symmetric to the child guard, and reachable only from a graph shape
        // no shipping parser produces: it needs some node this pass folds away
        // to be the CONTAINS SOURCE of an API. Kept because the failure it
        // prevents — a CONTAINS edge sourced from a node no longer in `nodes`
        // — is the same unattached-edge defect as the child side, not because
        // a test can reach it: no fixture here exercises its true branch.
        !removedNodes.has(parentId) &&
        !stillContained.has(childId),
    )
    .map(({ parentId, childId }) => ({
      id: nextEdgeId(),
      source: parentId,
      target: childId,
      type: EdgeType.CONTAINS,
      // Marked, because a promoted edge and an authored one mean different
      // things to `placeRouteTargets` — see `ResourceEdge.viaPromotion` and
      // that pass's `nestedIds`.
      viaPromotion: true,
    }));

  return { ...collapsed, edges: [...collapsed.edges, ...promotions] };
}

/** First static path segment, skipping path parameters (`{id}`, `{proxy+}`).
 * Paths with no static segment bucket under "/". */
function routePrefix(path: string): string {
  const segment = path
    .split("/")
    .filter(Boolean)
    .find((s) => !s.startsWith("{"));
  return segment ? `/${segment}` : "/";
}

/** Buckets rows by `routePrefix`. Every prefix becomes a group, including
 * single-route ones — uniform and predictable, at the cost of one expander row
 * on small APIs. Insertion-ordered, so groups appear in first-appearance order
 * and row order within a group is preserved. */
export function groupRoutesByPrefix(rows: RouteTableRow[]): RouteGroup[] {
  const byPrefix = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const prefix = routePrefix(row.path);
    const list = byPrefix.get(prefix);
    if (list) list.push(index);
    else byPrefix.set(prefix, [index]);
  });
  return [...byPrefix].map(([prefix, rowIndices]) => ({ prefix, rowIndices }));
}

/** Collapses a table's per-row edges into one weighted edge per λ target.
 * Insertion-ordered by first appearance, so edge order is stable across
 * renders. */
export function summarizeRouteEdges(table: RouteTable): RouteEdgeSummary[] {
  const counts = new Map<string, number>();
  for (const row of table.rows) {
    if (!row.targetId) continue;
    counts.set(row.targetId, (counts.get(row.targetId) ?? 0) + 1);
  }
  return [...counts].map(([targetId, routeCount]) => ({ targetId, routeCount }));
}
