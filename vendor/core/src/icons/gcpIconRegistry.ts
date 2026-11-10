import { ResourceType } from "../graph/types.js";

export const GCP_ICON_FILENAMES: Partial<Record<ResourceType, string>> = {
  // Compute
  [ResourceType.GCP_COMPUTE_INSTANCE]: "compute-engine.svg",
  [ResourceType.GCP_CONTAINER_CLUSTER]: "gke.svg",
  [ResourceType.GCP_CLOUD_RUN_SERVICE]: "cloud-run.svg",
  [ResourceType.GCP_CLOUD_FUNCTION]: "cloud-functions.svg",
  [ResourceType.GCP_APP_ENGINE]: "app-engine.svg",
  [ResourceType.GCP_CLOUD_RUN_JOB]: "cloud-run.svg",
  [ResourceType.GCP_WORKFLOW]: "workflows.svg",

  // Storage & Databases
  [ResourceType.GCP_STORAGE_BUCKET]: "cloud-storage.svg",
  [ResourceType.GCP_BIGQUERY_DATASET]: "bigquery.svg",
  [ResourceType.GCP_SQL_INSTANCE]: "cloud-sql.svg",
  [ResourceType.GCP_SPANNER_INSTANCE]: "cloud-spanner.svg",
  [ResourceType.GCP_FIRESTORE_DATABASE]: "firestore.svg",
  [ResourceType.GCP_REDIS_INSTANCE]: "memorystore.svg",
  [ResourceType.GCP_BIGTABLE_INSTANCE]: "bigtable.svg",
  [ResourceType.GCP_BIGQUERY_TABLE]: "bigquery.svg",

  // Networking
  [ResourceType.GCP_COMPUTE_NETWORK]: "vpc.svg",
  [ResourceType.GCP_COMPUTE_SUBNETWORK]: "vpc.svg",
  [ResourceType.GCP_FORWARDING_RULE]: "cloud-load-balancing.svg",
  [ResourceType.GCP_DNS_ZONE]: "cloud-dns.svg",
  [ResourceType.GCP_SECURITY_POLICY]: "cloud-armor.svg",
  [ResourceType.GCP_COMPUTE_ROUTER]: "cloud-router.svg",
  [ResourceType.GCP_COMPUTE_FIREWALL]: "firewall-rules.svg",
  [ResourceType.GCP_COMPUTE_ADDRESS]: "external-ip-address.svg",
  [ResourceType.GCP_DNS_RECORD_SET]: "cloud-dns.svg",
  [ResourceType.GCP_ROUTER_NAT]: "cloud-nat.svg",
  // Serverless VPC Access has no glyph of its own in this vintage; it is a VPC
  // feature, so it takes the VPC icon rather than another product's.
  [ResourceType.GCP_VPC_ACCESS_CONNECTOR]: "vpc.svg",
  [ResourceType.GCP_BACKEND_SERVICE]: "cloud-load-balancing.svg",

  // Messaging
  [ResourceType.GCP_PUBSUB_TOPIC]: "pubsub.svg",
  [ResourceType.GCP_PUBSUB_SUBSCRIPTION]: "pubsub.svg",
  [ResourceType.GCP_EVENTARC_TRIGGER]: "pubsub.svg",
  [ResourceType.GCP_CLOUD_SCHEDULER_JOB]: "cloud-scheduler.svg",
  [ResourceType.GCP_CLOUD_TASKS_QUEUE]: "cloud-tasks.svg",

  // Security. Google's icon set ships no service-account glyph in this
  // vintage (`Icon_24px_*_Color`), so a service account shares the IAM shield
  // with the two binding types rather than borrowing an unrelated product's
  // icon — which is what all four did before (`cloud-armor.svg`, a WAF).
  [ResourceType.GCP_IAM_BINDING]: "iam.svg",
  [ResourceType.GCP_IAM_MEMBER]: "iam.svg",
  [ResourceType.GCP_SERVICE_ACCOUNT]: "iam.svg",
  [ResourceType.GCP_KMS_KEY]: "kms.svg",
  [ResourceType.GCP_SECRET_MANAGER_SECRET]: "secret-manager.svg",

  // API
  [ResourceType.GCP_API_GATEWAY]: "api-gateway.svg",
  [ResourceType.GCP_ENDPOINTS_SERVICE]: "endpoints.svg",

  // GCP DevOps & operations
  [ResourceType.GCP_ARTIFACT_REGISTRY_REPOSITORY]: "artifact-registry.svg",
  [ResourceType.GCP_CLOUD_BUILD_TRIGGER]: "cloud-build.svg",
  [ResourceType.GCP_LOGGING_SINK]: "cloud-logging.svg",
};
