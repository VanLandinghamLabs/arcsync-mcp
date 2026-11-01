import { createEdgeIdMinter } from "./edgeIds.js";
import { classifyIamAccess, combinedIamAccess, type IamAccess } from "./iamActionClassifier.js";
import type { ArchGraph, EdgeDirection } from "./types.js";
import { EdgeType, ResourceType } from "./types.js";

export const DATA_STORE_TYPES = new Set<ResourceType>([
  ResourceType.DYNAMODB_TABLE,
  ResourceType.RDS_INSTANCE,
  ResourceType.RDS_CLUSTER,
  ResourceType.S3_BUCKET,
  ResourceType.ELASTICACHE_CLUSTER,
  ResourceType.OPENSEARCH_DOMAIN,
  ResourceType.EFS_FILE_SYSTEM,
  ResourceType.REDSHIFT_CLUSTER,
]);

export const MESSAGING_TYPES = new Set<ResourceType>([
  ResourceType.SQS_QUEUE,
  ResourceType.SNS_TOPIC,
  ResourceType.EVENTBRIDGE_RULE,
  ResourceType.EVENTBRIDGE_BUS,
  ResourceType.KINESIS_STREAM,
  ResourceType.KINESIS_FIREHOSE,
  ResourceType.MSK_CLUSTER,
]);

export type AccessClassification = IamAccess;

export function classifyLabel(label: string): AccessClassification | null {
  const normalized = label.trim().toLowerCase();
  if (normalized === "reads/writes" || normalized === "read/write" || normalized === "read_write")
    return "read_write";
  if (normalized === "reads" || normalized === "read") return "read";
  if (normalized === "writes" || normalized === "write") return "write";
  return null;
}

export function classifyIamActions(actions: string[]): AccessClassification | null {
  if (actions.some((action) => action === "*" || action.endsWith(":*"))) return "read_write";
  return combinedIamAccess(classifyIamAccess(actions));
}

const READ_COMMANDS = new Set([
  "GetItemCommand",
  "QueryCommand",
  "ScanCommand",
  "BatchGetItemCommand",
  "GetCommand",
  "GetObjectCommand",
  "HeadObjectCommand",
  "ListObjectsV2Command",
  "ReceiveMessageCommand",
  "GetRecordsCommand",
]);

const WRITE_COMMANDS = new Set([
  "PutItemCommand",
  "UpdateItemCommand",
  "DeleteItemCommand",
  "BatchWriteItemCommand",
  "PutCommand",
  "UpdateCommand",
  "DeleteCommand",
  "PutObjectCommand",
  "DeleteObjectCommand",
  "SendMessageCommand",
  "SendMessageBatchCommand",
  "PublishCommand",
  "PutRecordCommand",
  "PutRecordsCommand",
  "PutRecordBatchCommand",
  "PutEventsCommand",
]);

const READ_COMMAND_PATTERN = new RegExp(`\\b(?:${[...READ_COMMANDS].join("|")})\\b`);
const WRITE_COMMAND_PATTERN = new RegExp(`\\b(?:${[...WRITE_COMMANDS].join("|")})\\b`);

export function classifyLambdaSource(source: string): AccessClassification | null {
  if (!source) return null;

  const hasRead = READ_COMMAND_PATTERN.test(source);
  const hasWrite = WRITE_COMMAND_PATTERN.test(source);

  if (hasRead && hasWrite) return "read_write";
  if (hasRead) return "read";
  if (hasWrite) return "write";
  return null;
}

function classificationToDirection(
  classification: AccessClassification,
  isDataStore: boolean,
): EdgeDirection {
  if (isDataStore) {
    if (classification === "read") return "reverse";
    if (classification === "write") return "forward";
    return "bidirectional";
  }
  if (classification === "write") return "forward";
  if (classification === "read") return "reverse";
  return "bidirectional";
}

/**
 * Detect GCP and Azure containment/reference relationships by scanning node attributes.
 * Returns additional edges to be merged into the graph.
 */
function detectCloudRelationships(graph: ArchGraph): ArchGraph {
  const existingEdgeKeys = new Set(graph.edges.map((e) => `${e.source}->${e.target}`));
  const newEdges = [...graph.edges];
  const nextEdgeId = createEdgeIdMinter(graph.edges);

  function addEdgeIfNew(source: string, target: string, type: EdgeType, label?: string): void {
    const key = `${source}->${target}`;
    if (!existingEdgeKeys.has(key)) {
      newEdges.push({ id: nextEdgeId(), source, target, type, label });
      existingEdgeKeys.add(key);
    }
  }

  // Build lookup maps for GCP networks, Azure VNets, Azure SQL servers, and resource groups
  const gcpNetworks = new Map<string, string>(); // network name -> node id
  const azureVnets = new Map<string, string>(); // vnet name -> node id
  const azureSqlServers = new Map<string, string>(); // server name -> node id
  const azureResourceGroups = new Map<string, string>(); // rg name -> node id
  const gcpPubsubTopics = new Map<string, string>(); // topic name/id -> node id

  for (const node of graph.nodes) {
    if (node.type === ResourceType.GCP_COMPUTE_NETWORK) {
      gcpNetworks.set(node.name, node.id);
    } else if (node.type === ResourceType.AZURE_VIRTUAL_NETWORK) {
      azureVnets.set(node.name, node.id);
    } else if (node.type === ResourceType.AZURE_SQL_SERVER) {
      azureSqlServers.set(node.name, node.id);
    } else if (node.type === ResourceType.AZURE_RESOURCE_GROUP) {
      azureResourceGroups.set(node.name, node.id);
    } else if (node.type === ResourceType.GCP_PUBSUB_TOPIC) {
      gcpPubsubTopics.set(node.name, node.id);
      // Also index by ID for reference matching
      gcpPubsubTopics.set(node.id, node.id);
    }
  }

  for (const node of graph.nodes) {
    // GCP subnet -> network containment
    if (node.type === ResourceType.GCP_COMPUTE_SUBNETWORK) {
      const network = node.attributes.network as string | undefined;
      if (network) {
        // Network attribute can be a name or a self_link; try matching by name
        const networkId = gcpNetworks.get(network);
        if (networkId) {
          addEdgeIfNew(networkId, node.id, EdgeType.CONTAINS);
        }
      }
    }

    // GCP pubsub subscription -> topic reference
    if (node.type === ResourceType.GCP_PUBSUB_SUBSCRIPTION) {
      const topic = node.attributes.topic as string | undefined;
      if (topic) {
        const topicId = gcpPubsubTopics.get(topic);
        if (topicId) {
          addEdgeIfNew(node.id, topicId, EdgeType.REFERENCE);
        }
      }
    }

    // Azure subnet -> virtual network containment
    if (node.type === ResourceType.AZURE_SUBNET) {
      const vnetName = node.attributes.virtual_network_name as string | undefined;
      if (vnetName) {
        const vnetId = azureVnets.get(vnetName);
        if (vnetId) {
          addEdgeIfNew(vnetId, node.id, EdgeType.CONTAINS);
        }
      }
    }

    // Azure database -> server containment
    if (node.type === ResourceType.AZURE_SQL_DATABASE) {
      const serverId = node.attributes.server_id as string | undefined;
      if (serverId) {
        // server_id may be a full ID or just a name
        const serverNodeId =
          azureSqlServers.get(serverId) ??
          [...azureSqlServers.values()].find((id) => serverId.includes(id)) ??
          [...azureSqlServers.entries()].find(([name]) => serverId.includes(name))?.[1];
        if (serverNodeId) {
          addEdgeIfNew(serverNodeId, node.id, EdgeType.CONTAINS);
        }
      }
    }

    // Azure resource group containment
    if (node.type !== ResourceType.AZURE_RESOURCE_GROUP) {
      const rgName = node.attributes.resource_group_name as string | undefined;
      if (rgName) {
        const rgId = azureResourceGroups.get(rgName);
        if (rgId) {
          addEdgeIfNew(rgId, node.id, EdgeType.CONTAINS);
        }
      }
    }
  }

  return { ...graph, edges: newEdges };
}

export function analyzeAccessPatterns(graph: ArchGraph): ArchGraph {
  // First detect cloud-specific relationships
  const enriched = detectCloudRelationships(graph);
  const nodeMap = new Map(enriched.nodes.map((n) => [n.id, n]));

  const edges = enriched.edges.map((edge) => {
    if (edge.type === EdgeType.CONTAINS) return edge;
    if (edge.direction) return edge;

    const targetNode = nodeMap.get(edge.target);
    if (!targetNode) return edge;

    const isDataStore = DATA_STORE_TYPES.has(targetNode.type);
    const isMessaging = MESSAGING_TYPES.has(targetNode.type);
    if (!isDataStore && !isMessaging) return edge;

    const sourceNode = nodeMap.get(edge.source);
    const lambdaSource = sourceNode?.attributes.sourceCode as string | undefined;
    if (lambdaSource) {
      const codeClassification = classifyLambdaSource(lambdaSource);
      if (codeClassification) {
        return { ...edge, direction: classificationToDirection(codeClassification, isDataStore) };
      }
    }

    if (edge.label) {
      const labelClassification = classifyLabel(edge.label);
      if (labelClassification) {
        return { ...edge, direction: classificationToDirection(labelClassification, isDataStore) };
      }
      const actions = edge.label.split(",").map((a) => a.trim());
      const iamClassification = classifyIamActions(actions);
      if (iamClassification) {
        return { ...edge, direction: classificationToDirection(iamClassification, isDataStore) };
      }
    }

    const defaultDirection: EdgeDirection = isDataStore ? "bidirectional" : "forward";
    return { ...edge, direction: defaultDirection };
  });

  return { ...enriched, edges };
}
