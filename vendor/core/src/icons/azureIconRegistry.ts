import { ResourceType } from "../graph/types.js";

export const AZURE_ICON_FILENAMES: Partial<Record<ResourceType, string>> = {
  // Compute
  [ResourceType.AZURE_VIRTUAL_MACHINE]: "virtual-machine.svg",
  [ResourceType.AZURE_LINUX_VM]: "virtual-machine.svg",
  [ResourceType.AZURE_WINDOWS_VM]: "virtual-machine.svg",
  [ResourceType.AZURE_FUNCTION_APP]: "function-apps.svg",
  [ResourceType.AZURE_KUBERNETES_CLUSTER]: "kubernetes.svg",
  [ResourceType.AZURE_CONTAINER_GROUP]: "container-instances.svg",
  [ResourceType.AZURE_APP_SERVICE]: "app-services.svg",
  [ResourceType.AZURE_APP_SERVICE_PLAN]: "app-service-plan.svg",
  [ResourceType.AZURE_AVAILABILITY_SET]: "availability-set.svg",
  [ResourceType.AZURE_CONTAINER_REGISTRY]: "container-registry.svg",

  // Storage & Databases
  [ResourceType.AZURE_STORAGE_ACCOUNT]: "storage.svg",
  [ResourceType.AZURE_COSMOSDB_ACCOUNT]: "cosmos-db.svg",
  [ResourceType.AZURE_SQL_DATABASE]: "sql-database.svg",
  [ResourceType.AZURE_SQL_SERVER]: "azure-sql.svg",
  [ResourceType.AZURE_REDIS_CACHE]: "redis-cache.svg",
  [ResourceType.AZURE_STORAGE_CONTAINER]: "storage-container.svg",
  [ResourceType.AZURE_POSTGRESQL_FLEXIBLE_SERVER]: "postgresql.svg",

  // Networking
  [ResourceType.AZURE_VIRTUAL_NETWORK]: "virtual-network.svg",
  [ResourceType.AZURE_SUBNET]: "virtual-network.svg",
  [ResourceType.AZURE_LOAD_BALANCER]: "load-balancer.svg",
  [ResourceType.AZURE_APP_GATEWAY]: "application-gateway.svg",
  [ResourceType.AZURE_DNS_ZONE]: "dns.svg",
  [ResourceType.AZURE_FRONTDOOR]: "front-door.svg",
  [ResourceType.AZURE_NSG]: "nsg.svg",
  [ResourceType.AZURE_PUBLIC_IP]: "public-ip.svg",
  [ResourceType.AZURE_NETWORK_INTERFACE]: "network-interface.svg",
  [ResourceType.AZURE_PRIVATE_ENDPOINT]: "private-endpoint.svg",
  [ResourceType.AZURE_PRIVATE_DNS_ZONE]: "dns.svg",
  [ResourceType.AZURE_ROUTE_TABLE]: "route-table.svg",
  [ResourceType.AZURE_NAT_GATEWAY]: "nat.svg",
  [ResourceType.AZURE_BASTION_HOST]: "bastion.svg",
  [ResourceType.AZURE_VNET_GATEWAY]: "virtual-network-gateway.svg",

  // Security
  [ResourceType.AZURE_KEY_VAULT]: "key-vault.svg",
  [ResourceType.AZURE_ROLE_ASSIGNMENT]: "role-assignment.svg",
  [ResourceType.AZURE_USER_IDENTITY]: "managed-identity.svg",

  // Messaging
  [ResourceType.AZURE_SERVICEBUS_NAMESPACE]: "service-bus.svg",
  [ResourceType.AZURE_SERVICEBUS_QUEUE]: "service-bus.svg",
  [ResourceType.AZURE_SERVICEBUS_TOPIC]: "service-bus.svg",
  [ResourceType.AZURE_EVENTGRID_TOPIC]: "event-grid.svg",
  [ResourceType.AZURE_EVENTHUB_NAMESPACE]: "event-hub.svg",
  [ResourceType.AZURE_EVENTGRID_SYSTEM_TOPIC]: "event-grid-system-topic.svg",

  // Monitoring
  [ResourceType.AZURE_LOG_ANALYTICS_WORKSPACE]: "log-analytics.svg",
  [ResourceType.AZURE_APPLICATION_INSIGHTS]: "application-insights.svg",
  [ResourceType.AZURE_MONITOR_ACTION_GROUP]: "monitor.svg",
  [ResourceType.AZURE_MONITOR_ALERT]: "alerts.svg",

  // API
  [ResourceType.AZURE_API_MANAGEMENT]: "api-management.svg",

  // Grouping
  [ResourceType.AZURE_RESOURCE_GROUP]: "resource-group.svg",
  [ResourceType.AZURE_DEPLOYMENT]: "templates.svg",
};
