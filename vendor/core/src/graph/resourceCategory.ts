import { lookupByType } from "./typeLookup.js";
import { ResourceType } from "./types.js";

/**
 * High-level resource families used for colour-coding and the canvas legend.
 * `generic` is the fallback for any resource type not explicitly mapped.
 */
export type ResourceCategory =
  | "compute"
  | "networking"
  | "storage"
  | "security"
  | "messaging"
  | "events"
  | "infra"
  | "generic";

/**
 * Authoritative resource-type → category map. The Mermaid renderer derives its
 * `classDef` styling from this, and the frontend canvas derives its legend
 * filter from it. The palette each category paints is `resourceColors.ts`.
 */
export const CATEGORY_BY_TYPE: Partial<Record<ResourceType, ResourceCategory>> = {
  // Networking (orange)
  [ResourceType.EC2_VPC]: "networking",
  [ResourceType.EC2_SUBNET]: "networking",
  [ResourceType.EC2_SECURITY_GROUP]: "networking",
  [ResourceType.ELB_LOAD_BALANCER]: "networking",
  [ResourceType.CLOUDFRONT_DISTRIBUTION]: "networking",
  [ResourceType.ROUTE53_ZONE]: "networking",
  [ResourceType.ROUTE53_RECORD]: "networking",
  [ResourceType.EC2_NAT_GATEWAY]: "networking",
  [ResourceType.EC2_INTERNET_GATEWAY]: "networking",
  [ResourceType.EC2_VPC_ENDPOINT]: "networking",
  [ResourceType.EC2_TRANSIT_GATEWAY]: "networking",
  [ResourceType.EC2_EIP]: "networking",
  [ResourceType.EC2_ROUTE_TABLE]: "networking",
  // The networking join resources. They are relationships, so they normally
  // fold away before a legend ever counts them (`foldNetworkGlue`) — but an
  // unfolded one is still networking, not `generic`.
  [ResourceType.EC2_ROUTE_TABLE_ASSOCIATION]: "networking",
  [ResourceType.EC2_ROUTE]: "networking",
  [ResourceType.EC2_INTERNET_GATEWAY_ATTACHMENT]: "networking",
  // API gateways are a stack's network entrance, not its compute. The
  // sub-resource types are here too: Mermaid never runs collapseRouteTables,
  // so they render as their own nodes rather than folding into the parent.
  [ResourceType.APIGW_REST_API]: "networking",
  [ResourceType.APIGW_V2_API]: "networking",
  [ResourceType.APIGW_V2_ROUTE]: "networking",
  [ResourceType.APIGW_V2_INTEGRATION]: "networking",
  [ResourceType.APIGW_REST_RESOURCE]: "networking",
  [ResourceType.APIGW_REST_METHOD]: "networking",
  [ResourceType.APIGW_REST_INTEGRATION]: "networking",

  // Compute (blue)
  [ResourceType.LAMBDA_FUNCTION]: "compute",
  [ResourceType.ECS_SERVICE]: "compute",
  [ResourceType.ECS_CLUSTER]: "compute",
  [ResourceType.ECS_TASK_DEFINITION]: "compute",
  [ResourceType.EKS_CLUSTER]: "compute",
  [ResourceType.EC2_INSTANCE]: "compute",
  [ResourceType.AUTOSCALING_GROUP]: "compute",
  [ResourceType.APPSYNC_API]: "compute",
  [ResourceType.SFN_STATE_MACHINE]: "compute",
  [ResourceType.SFN_STATE]: "compute",

  // Storage (green)
  [ResourceType.S3_BUCKET]: "storage",
  [ResourceType.DYNAMODB_TABLE]: "storage",
  [ResourceType.RDS_INSTANCE]: "storage",
  [ResourceType.RDS_CLUSTER]: "storage",
  [ResourceType.ELASTICACHE_CLUSTER]: "storage",
  [ResourceType.OPENSEARCH_DOMAIN]: "storage",
  [ResourceType.EFS_FILE_SYSTEM]: "storage",
  [ResourceType.REDSHIFT_CLUSTER]: "storage",

  // Security (purple)
  [ResourceType.IAM_ROLE]: "security",
  [ResourceType.IAM_POLICY]: "security",
  // Purple with the role it carries, not blue with the instance it folds onto.
  [ResourceType.IAM_INSTANCE_PROFILE]: "security",
  [ResourceType.ACM_CERTIFICATE]: "security",
  [ResourceType.COGNITO_USER_POOL]: "security",
  [ResourceType.WAF_WEB_ACL]: "security",
  [ResourceType.KMS_KEY]: "security",
  [ResourceType.SECRETSMANAGER_SECRET]: "security",

  // Messaging (amber)
  [ResourceType.SQS_QUEUE]: "messaging",

  // Events (pink)
  [ResourceType.EVENTBRIDGE_RULE]: "events",
  [ResourceType.EVENTBRIDGE_BUS]: "events",
  [ResourceType.SNS_TOPIC]: "events",
  [ResourceType.KINESIS_STREAM]: "events",
  [ResourceType.KINESIS_FIREHOSE]: "events",
  [ResourceType.MSK_CLUSTER]: "events",
  [ResourceType.EVENT_TYPE]: "events",

  // DevOps (slate)
  [ResourceType.CLOUDFORMATION_STACK]: "infra",
  [ResourceType.ECR_REPOSITORY]: "infra",
  [ResourceType.CODEPIPELINE_PIPELINE]: "infra",
  [ResourceType.CODEBUILD_PROJECT]: "infra",

  // GCP Compute (blue)
  [ResourceType.GCP_COMPUTE_INSTANCE]: "compute",
  [ResourceType.GCP_CONTAINER_CLUSTER]: "compute",
  [ResourceType.GCP_CLOUD_RUN_SERVICE]: "compute",
  [ResourceType.GCP_CLOUD_FUNCTION]: "compute",
  [ResourceType.GCP_APP_ENGINE]: "compute",

  // GCP Storage (green)
  [ResourceType.GCP_STORAGE_BUCKET]: "storage",
  [ResourceType.GCP_BIGQUERY_DATASET]: "storage",
  [ResourceType.GCP_SQL_INSTANCE]: "storage",
  [ResourceType.GCP_SPANNER_INSTANCE]: "storage",
  [ResourceType.GCP_FIRESTORE_DATABASE]: "storage",
  [ResourceType.GCP_REDIS_INSTANCE]: "storage",
  [ResourceType.GCP_BIGTABLE_INSTANCE]: "storage",

  // GCP Networking (orange)
  [ResourceType.GCP_COMPUTE_NETWORK]: "networking",
  [ResourceType.GCP_COMPUTE_SUBNETWORK]: "networking",
  [ResourceType.GCP_FORWARDING_RULE]: "networking",
  [ResourceType.GCP_DNS_ZONE]: "networking",
  [ResourceType.GCP_SECURITY_POLICY]: "networking",
  [ResourceType.GCP_COMPUTE_ROUTER]: "networking",
  [ResourceType.GCP_COMPUTE_FIREWALL]: "networking",
  [ResourceType.GCP_API_GATEWAY]: "networking",
  [ResourceType.GCP_ENDPOINTS_SERVICE]: "networking",

  // GCP Messaging (amber)
  [ResourceType.GCP_PUBSUB_TOPIC]: "messaging",
  [ResourceType.GCP_PUBSUB_SUBSCRIPTION]: "messaging",
  [ResourceType.GCP_EVENTARC_TRIGGER]: "messaging",

  // GCP Security (purple)
  [ResourceType.GCP_IAM_BINDING]: "security",
  [ResourceType.GCP_IAM_MEMBER]: "security",
  [ResourceType.GCP_SERVICE_ACCOUNT]: "security",
  [ResourceType.GCP_KMS_KEY]: "security",

  // Azure Compute (blue)
  [ResourceType.AZURE_VIRTUAL_MACHINE]: "compute",
  [ResourceType.AZURE_LINUX_VM]: "compute",
  [ResourceType.AZURE_WINDOWS_VM]: "compute",
  [ResourceType.AZURE_FUNCTION_APP]: "compute",
  [ResourceType.AZURE_KUBERNETES_CLUSTER]: "compute",
  [ResourceType.AZURE_CONTAINER_GROUP]: "compute",
  [ResourceType.AZURE_APP_SERVICE]: "compute",

  // Azure Storage (green)
  [ResourceType.AZURE_STORAGE_ACCOUNT]: "storage",
  [ResourceType.AZURE_COSMOSDB_ACCOUNT]: "storage",
  [ResourceType.AZURE_SQL_DATABASE]: "storage",
  [ResourceType.AZURE_SQL_SERVER]: "storage",
  [ResourceType.AZURE_REDIS_CACHE]: "storage",

  // Azure Networking (orange)
  [ResourceType.AZURE_VIRTUAL_NETWORK]: "networking",
  [ResourceType.AZURE_SUBNET]: "networking",
  [ResourceType.AZURE_LOAD_BALANCER]: "networking",
  [ResourceType.AZURE_APP_GATEWAY]: "networking",
  [ResourceType.AZURE_DNS_ZONE]: "networking",
  [ResourceType.AZURE_FRONTDOOR]: "networking",
  [ResourceType.AZURE_NSG]: "networking",
  [ResourceType.AZURE_API_MANAGEMENT]: "networking",

  // Azure Security (purple)
  [ResourceType.AZURE_KEY_VAULT]: "security",
  [ResourceType.AZURE_ROLE_ASSIGNMENT]: "security",
  [ResourceType.AZURE_USER_IDENTITY]: "security",

  // Azure Messaging (amber / events)
  [ResourceType.AZURE_SERVICEBUS_NAMESPACE]: "messaging",
  [ResourceType.AZURE_SERVICEBUS_QUEUE]: "messaging",
  [ResourceType.AZURE_SERVICEBUS_TOPIC]: "events",
  [ResourceType.AZURE_EVENTGRID_TOPIC]: "events",
  [ResourceType.AZURE_EVENTHUB_NAMESPACE]: "events",

  // Azure Grouping (slate)
  [ResourceType.AZURE_RESOURCE_GROUP]: "infra",
};

/**
 * Resolve a resource type to its category, falling back to `generic` for any
 * type not present in {@link CATEGORY_BY_TYPE}.
 */
export function categoryForType(type: ResourceType): ResourceCategory {
  return lookupByType(CATEGORY_BY_TYPE, type) ?? "generic";
}
