/**
 * API Gateway stage raw provider types, the name extractor and the protocol
 * label, in their own module for the same reason `permissionTypes.ts` exists:
 * `displayFilter.ts` hides these nodes and stamps the stage name onto the
 * surviving API, and `routeTable.ts` resolves the same set itself when it
 * walks an *unfiltered* graph. `routeTable` ships in the browser's graph chunk
 * and `displayFilter` does not, so importing them from `displayFilter` would
 * drag its entire deny list into the frontend bundle.
 */
import { lookupByType } from "./typeLookup.js";
import { type ResourceNode, ResourceType } from "./types.js";

/** The API Gateway nodes a stage can belong to. Shared with the set above
 * because the two are only ever used as a pair — resolving a stage means
 * resolving which API it stages. */
export const API_TYPES: ReadonlySet<ResourceType> = new Set([
  ResourceType.APIGW_V2_API,
  ResourceType.APIGW_REST_API,
]);

export const STAGE_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  // CloudFormation
  "AWS::ApiGatewayV2::Stage",
  "AWS::ApiGateway::Stage",
  // Terraform
  "aws_apigatewayv2_stage",
  "aws_api_gateway_stage",
  // Pulumi (classic AWS)
  "aws:apigatewayv2/stage:Stage",
  "aws:apigateway/stage:Stage",
  // Pulumi (aws-native)
  "aws-native:apigatewayv2:Stage",
  "aws-native:apigateway:Stage",
]);

/** A stage's display name, checked across every provider's casing (Pulumi
 * classic and aws-native both use the same camelCase `stageName` — see
 * resourceTypeMap.ts' aws-native doc comment on why that's keyed directly
 * rather than derived from the CFN-mirroring type-token pattern). Falls back to
 * the node's own name so a stage with no name attribute still contributes a
 * chip rather than an empty one. */
export function stageNameOf(node: ResourceNode): string {
  const raw =
    node.attributes.StageName ?? // CloudFormation
    node.attributes.stage_name ?? // Terraform
    node.attributes.stageName; // Pulumi (classic AWS + aws-native)
  return typeof raw === "string" && raw !== "" ? raw : node.name;
}

const PROTOCOL_LABELS: Record<string, string> = {
  HTTP: "V2 HTTP",
  WEBSOCKET: "V2 WebSocket",
};

/** "REST" for a REST API, else the V2 protocol's label — for a node already
 * known to be an API Gateway (the route table's header). */
export function protocolLabelFor(node: ResourceNode): string {
  if (node.type === ResourceType.APIGW_REST_API) return "REST";
  const protocol = node.attributes.ProtocolType;
  // `ProtocolType` is raw parsed provider output — see `lookupByType`.
  return lookupByType(PROTOCOL_LABELS, typeof protocol === "string" ? protocol : "") ?? "V2";
}

/** The same label for any node, empty when it is not an API Gateway — what a
 * container header or Mermaid subgraph label appends after the display name. */
export function apiGatewayTypeLabel(node: ResourceNode): string {
  return API_TYPES.has(node.type) ? protocolLabelFor(node) : "";
}
