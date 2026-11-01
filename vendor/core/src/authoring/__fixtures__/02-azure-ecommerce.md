# Azure e-commerce storefront

```arcsync
flowchart LR
  %% diagram: ex02-azure-ecommerce
  %% title: Azure e-commerce storefront
  shopper[Shopper]@{ icon: "browser", description: "Browser and mobile web traffic from storefront customers" }
  psp[Payment provider]@{ icon: "external", kind: "saas", description: "Stripe; calls back to the order service with payment webhooks", props: { api: "PaymentIntents v2024", webhook: "payment_intent.succeeded" } }

  subgraph sub[Subscription: shop-prod]@{ kind: "azure-subscription", region: "westeurope", owner: "platform-team" }
    subgraph rgedge[rg-shop-edge]@{ kind: "resource-group", description: "Global edge resources, deployed separately from regional stacks" }
      fd[Front Door Premium]@{
        icon: "azure:front-door",
        description: "Global anycast entry point with TLS termination, caching of static assets and routing to the storefront origin",
        props: { sku: "Premium_AzureFrontDoor", origin: "app-shop-web", healthProbe: "/healthz every 30s", waf: "waf-shop-prod" }
      }
      waf[WAF policy]@{
        icon: "azure:nsg",
        kind: "waf-policy",
        description: "Managed OWASP DRS 2.1 rules, bot protection and per-IP rate limiting on /api and /checkout",
        props: { mode: "Prevention", rateLimit: "300 req/min/IP", ruleSet: "Microsoft_DefaultRuleSet 2.1" }
      }
    end

    subgraph rgapp[rg-shop-app-weu]@{ kind: "resource-group", description: "Regional application tier, all resources tagged env=prod" }
      subgraph vnet[vnet-shop-weu]@{ icon: "azure:vnet", kind: "vnet", props: { addressSpace: "10.20.0.0/16", ddos: "DDoS Network Protection" } }
        subgraph snetweb[snet-web 10.20.1.0/24]@{ icon: "azure:subnet", kind: "subnet", description: "App Service regional VNet integration, delegated to Microsoft.Web/serverFarms" }
          nsgweb[nsg-web]@{ icon: "azure:nsg", description: "Allows 443 from AzureFrontDoor.Backend only; denies all other inbound", props: { inbound: "443 AzureFrontDoor.Backend", outbound: "443 to snet-aks, snet-data" } }
          web[App Service: storefront]@{
            icon: "azure:app-service",
            description: "Next.js storefront SSR on Linux App Service, slot swap for zero-downtime deploys",
            props: { plan: "P2v3 x3 (zone redundant)", runtime: "node 22", autoscale: "CPU > 65%, 3-12 instances", slots: "staging" }
          }
        end
        subgraph snetapim[snet-apim 10.20.2.0/27]@{ icon: "azure:subnet", kind: "subnet" }
          apim[API Management]@{
            icon: "azure:api-management",
            description: "Single public API surface: JWT validation, per-subscription rate limits and routing to AKS services",
            props: { sku: "Premium (internal VNet mode)", units: "2", policies: "validate-jwt, rate-limit-by-key 100/min" }
          }
        end
        subgraph snetaks[snet-aks 10.20.4.0/22]@{ icon: "azure:subnet", kind: "subnet", description: "AKS node pools with Azure CNI Overlay" }
          nsgaks[nsg-aks]@{ icon: "azure:nsg", description: "Allows 443 from snet-apim and snet-web only", props: { inbound: "443 from 10.20.2.0/27" } }
          subgraph aks[aks-shop-weu]@{ icon: "azure:aks", kind: "aks-cluster", props: { version: "1.31", nodePool: "Standard_D4ds_v5 x6, autoscale 6-24", cni: "Azure CNI Overlay", workloadIdentity: "enabled" } }
            orders[order-service]@{ icon: "service", description: "Creates orders, orchestrates payment and publishes order events", props: { replicas: "4", hpa: "CPU 70%", language: ".NET 9" } }
            catalog[catalog-service]@{ icon: "service", description: "Serves product, price and inventory-availability reads with a Redis-style read-through cache", props: { replicas: "6", language: "Go 1.23" } }
            cart[cart-service]@{ icon: "service", description: "Session carts keyed by shopper id with 30 day TTL", props: { replicas: "4", language: "Node 22" } }
          end
        end
        subgraph snetdata[snet-data 10.20.8.0/24]@{ icon: "azure:subnet", kind: "subnet", description: "Private endpoints for PaaS data services; no public network access" }
          nsgdata[nsg-data]@{ icon: "azure:nsg", description: "Allows 1433, 443 and 5671 from snet-aks and snet-func only", props: { inbound: "1433,443,5671 from app subnets" } }
          cosmos[Cosmos DB]@{
            icon: "azure:cosmos-db",
            description: "NoSQL API account holding the catalog and cart containers, multi-region reads",
            props: { api: "NoSQL", consistency: "Session", containers: "catalog (pk /categoryId), carts (pk /shopperId, TTL 30d)", throughput: "autoscale 4000-40000 RU/s" }
          }
          sql[Azure SQL]@{
            icon: "azure:sql",
            description: "System of record for orders, payments and refunds; ACID transactions needed for order state",
            props: { tier: "Business Critical Gen5 8 vCore", zoneRedundant: "true", pitrRetention: "35 days", failoverGroup: "ne-secondary" }
          }
        end
        subgraph snetfunc[snet-func 10.20.16.0/24]@{ icon: "azure:subnet", kind: "subnet", description: "Functions Premium plan VNet integration" }
          bus[Service Bus]@{
            icon: "azure:service-bus",
            description: "Premium namespace with private endpoint; carries order lifecycle events",
            props: { sku: "Premium 2 MU", topic: "order-events", maxDelivery: "10", dlq: "enabled per subscription" }
          }
          fninv[Fn: inventory-reserve]@{ icon: "azure:functions", description: "Decrements stock on order.placed and releases it on order.cancelled", props: { trigger: "Service Bus subscription sub-inventory", runtime: "dotnet-isolated 9", plan: "EP1" } }
          fnmail[Fn: order-email]@{ icon: "azure:functions", description: "Sends confirmation and shipping emails via Communication Services", props: { trigger: "Service Bus subscription sub-email", runtime: "node 22", plan: "EP1" } }
          fnship[Fn: fulfilment]@{ icon: "azure:functions", description: "Creates pick tickets at the 3PL warehouse and tracks carrier status", props: { trigger: "Service Bus subscription sub-fulfilment", runtime: "python 3.12", plan: "EP1" } }
        end
      end
    end

    subgraph rgsec[rg-shop-security]@{ kind: "resource-group", description: "Secrets and identities, locked with CanNotDelete" }
      kv[Key Vault]@{
        icon: "azure:key-vault",
        description: "Holds payment webhook secret, SQL connection fallback and Cosmos keys; RBAC authorization model",
        props: { sku: "Premium (HSM)", softDelete: "90 days", purgeProtection: "on", network: "private endpoint" }
      }
      mi[Managed identities]@{
        icon: "azure:managed-identity",
        description: "User-assigned identities for the web app, AKS workloads (workload identity) and Functions",
        props: { identities: "id-shop-web, id-order, id-catalog, id-cart, id-func", roles: "Key Vault Secrets User, Cosmos DB Data Contributor, SQL db_datareader/db_datawriter, Service Bus Data Sender/Receiver" }
      }
    end
  end

  shopper --> fd
  fd -- "attached policy"@{ kind: "iam" } --> waf
  fd -- "HTTPS origin, private link"@{ kind: "network" } --> web
  nsgweb -.->|filters inbound| web
  web -- "REST /api/*"@{ kind: "sync" } --> apim
  shopper -- "api.shop.example.com"@{ kind: "network" } --> fd
  apim -- "route /orders"@{ kind: "sync" } --> orders
  apim -- "route /catalog"@{ kind: "sync" } --> catalog
  apim -- "route /cart"@{ kind: "sync" } --> cart
  nsgaks -.->|filters inbound| aks
  catalog -- "point reads, queries"@{ kind: "data" } --> cosmos
  cart -- "upsert cart doc"@{ kind: "data" } --> cosmos
  orders -- "T-SQL transactions"@{ kind: "data" } --> sql
  orders -- "create PaymentIntent"@{ kind: "sync" } --> psp
  psp -- "webhook"@{ kind: "async" } --> apim
  orders -- "publish order.*"@{ kind: "async" } --> bus
  bus -- "sub-inventory"@{ kind: "async" } --> fninv
  bus -- "sub-email"@{ kind: "async" } --> fnmail
  bus -- "sub-fulfilment"@{ kind: "async" } --> fnship
  fninv -- "stock decrement"@{ kind: "data" } --> cosmos
  fnship -- "fulfilment status"@{ kind: "data" } --> sql
  web & orders & catalog & cart --> kv
  mi -- "RBAC token for"@{ kind: "iam" } --> web
  mi -- "workload identity"@{ kind: "iam" } --> aks
  mi -- "function identity"@{ kind: "iam" } --> fninv
  nsgdata -.->|filters inbound| cosmos
  nsgdata -.->|filters inbound| sql
  kv -- "secrets via private endpoint"@{ kind: "network" } --> snetdata
  fninv & fnmail & fnship -- "dead-letter failures"@{ kind: "async" } --> bus
  orderstate[Order lifecycle]@{ icon: "service", kind: "state-machine", description: "Order states persisted in Azure SQL, owned by order-service", expands: "order-lifecycle" }
  orders --> orderstate
```

```arcsync
stateDiagram-v2
  %% diagram: order-lifecycle
  [*] --> Placed: checkout submitted
  Placed --> Paid: payment_intent.succeeded
  Placed --> Cancelled: shopper cancels or payment times out (30 min)
  Paid --> Fulfilled: warehouse confirms pick and pack
  Paid --> Refunding: cancelled before fulfilment
  Fulfilled --> Shipped: carrier scan received
  Fulfilled --> Refunding: out of stock at pick
  Shipped --> Delivered: carrier delivery confirmation
  Shipped --> Returned: shopper returns within 30 days
  Delivered --> Returned: return requested
  Returned --> Refunding: item received at warehouse
  Refunding --> Refunded: Stripe refund succeeded
  Cancelled --> [*]
  Delivered --> [*]
  Refunded --> [*]
  Placed: Order row inserted in Azure SQL, stock reserved by inventory function
  Paid: Payment captured, order.paid event published to Service Bus
  Fulfilled: Pick ticket created at the 3PL warehouse
  Shipped: Tracking number stored and shipping email sent
  Delivered: Terminal state, return window of 30 days still open
  Refunding: Refund requested through the payment provider, retried with backoff
```
