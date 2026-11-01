# Remote patient monitoring platform (Azure)

```arcsync
flowchart LR
  %% diagram: telehealth-rpm
  %% title: Remote patient monitoring on Azure
  %% PHI boundary: everything inside the VNet subgraph handles ePHI under the Microsoft BAA

  %% ---- Patient home (outside the trust boundary) ----
  subgraph home[Patient home]@{ kind: "zone", trustLevel: "untrusted" }
    wearable[Wearable sensors]@{
      icon: "mobile",
      description: "BLE pulse oximeter, ECG patch, BP cuff and scale paired to the gateway",
      props: { protocol: "BLE 5 (encrypted bonding)", sampleRate: "1 Hz SpO2/HR, 250 Hz ECG batched" }
    }
    gateway[Home gateway]@{
      icon: "service",
      description: "Cellular hub that batches readings and forwards them over MQTT with a per-device X.509 cert",
      props: { uplink: "LTE-M + Wi-Fi fallback", auth: "X.509 per device", buffer: "72h offline store-and-forward" }
    }
  end

  %% ---- Azure ----
  subgraph azure[Azure subscription: rpm-prod]@{ kind: "cloud", region: "East US 2 (paired: Central US)", baa: "Microsoft BAA in force" }

    iot[IoT Hub ingest]@{
      icon: "azure:event-hubs",
      description: "Device ingress (IoT Hub shown with the Event Hubs icon); built-in Event Hubs endpoint feeds stream processing",
      props: { sku: "S2", partitions: "32", retention: "3 days", tls: "1.2 minimum", publicNetworkAccess: "Disabled for routes, device endpoint via DPS" }
    }

    subgraph vnet[VNet rpm-prod-vnet 10.20.0.0/16]@{ kind: "network", phiBoundary: "true", flowLogs: "NSG flow logs to Log Analytics, 365d" }

      subgraph snet_app[snet-app 10.20.1.0/24]@{ kind: "subnet", nsg: "nsg-app: allow 443 from AppGateway only" }
        nsg_app[nsg-app]@{ icon: "azure:nsg", description: "Deny-all inbound except HTTPS from the App Gateway subnet", props: { defaultDeny: "true" } }
        portal[Clinician portal]@{
          icon: "azure:app-service",
          description: "Web portal where nurses and physicians review vitals and work the alert queue",
          props: { plan: "P1v3 zone redundant", auth: "Entra ID SSO + MFA", sessionTimeout: "15 min idle", auditLogging: "every PHI read written to audit log", vnetIntegration: "true" }
        }
      end

      subgraph snet_proc[snet-proc 10.20.2.0/24]@{ kind: "subnet", nsg: "nsg-proc: outbound only to snet-pe and ServiceTag AzureMonitor" }
        nsg_proc[nsg-proc]@{ icon: "azure:nsg", description: "Blocks all inbound; outbound limited to private endpoints and the SMS provider egress IP", props: { defaultDeny: "true" } }
        stream[Vitals stream processor]@{
          icon: "azure:functions",
          description: "Event Hubs triggered function that validates, de-identifies for logs, persists readings and detects vital-sign anomalies",
          props: { runtime: "dotnet-isolated 8", plan: "Premium EP2", batch: "100 events", checkpoint: "blob storage", identity: "system-assigned managed identity" }
        }
        alerter[Alerting function]@{
          icon: "azure:functions",
          description: "Service Bus triggered function that owns the alert escalation state machine and calls the pager provider",
          props: { runtime: "dotnet-isolated 8", plan: "Premium EP1", escalationTimer: "Durable timers" },
          expands: "alert-escalation"
        }
      end

      subgraph snet_pe[snet-pe 10.20.3.0/24]@{ kind: "subnet", nsg: "nsg-pe: allow 443/1433 from snet-app and snet-proc" }
        nsg_pe[nsg-pe]@{ icon: "azure:nsg", description: "Only app and processing subnets may reach the private endpoints", props: { defaultDeny: "true" } }
        pe_cosmos[PE cosmos]@{ icon: "service", kind: "private-endpoint", description: "Private endpoint for the Cosmos DB SQL API", props: { groupId: "Sql", privateDns: "privatelink.documents.azure.com" } }
        pe_sql[PE sql]@{ icon: "service", kind: "private-endpoint", description: "Private endpoint for Azure SQL", props: { groupId: "sqlServer", privateDns: "privatelink.database.windows.net" } }
        pe_kv[PE keyvault]@{ icon: "service", kind: "private-endpoint", description: "Private endpoint for Key Vault", props: { groupId: "vault", privateDns: "privatelink.vaultcore.azure.net" } }
        pe_sb[PE servicebus]@{ icon: "service", kind: "private-endpoint", description: "Private endpoint for Service Bus", props: { groupId: "namespace", privateDns: "privatelink.servicebus.windows.net" } }
      end
    end

    cosmos[Readings store]@{
      icon: "azure:cosmos-db",
      description: "Time-series vitals keyed by patientId and day bucket; ePHI at rest",
      props: { api: "NoSQL", partitionKey: "/patientDayKey", ttl: "7 years (retention policy)", encryption: "CMK from Key Vault", backup: "Continuous 30d PITR", publicNetworkAccess: "Disabled", multiRegionWrites: "false" }
    }
    sql[Patient records]@{
      icon: "azure:sql",
      description: "Demographics, care plans, device assignments and alert audit trail",
      props: { tier: "Business Critical Gen5 4 vCore", encryption: "TDE with CMK + Always Encrypted for SSN/DOB", auditing: "SQL Audit to Log Analytics, 6 years", entraOnlyAuth: "true", ledger: "enabled for alert audit tables", geoReplica: "Central US" }
    }
    sb[Clinical alerts]@{
      icon: "azure:service-bus-queue",
      description: "Durable queue of anomaly alerts consumed by the alerting function",
      props: { sku: "Premium (1 MU)", sessions: "keyed by patientId", deadLetter: "enabled, 14d", ttl: "1h", encryption: "CMK", publicNetworkAccess: "Disabled" }
    }
    kv[Key Vault]@{
      icon: "azure:key-vault",
      description: "Holds CMKs for Cosmos, SQL, Service Bus and the pager API credential",
      props: { sku: "Premium (HSM-backed)", purgeProtection: "true", softDelete: "90d", rbac: "Azure RBAC", rotation: "CMK auto-rotate 12 months", publicNetworkAccess: "Disabled" }
    }
  end

  %% ---- Outside Azure ----
  sms[SMS / pager provider]@{
    icon: "external",
    kind: "saas",
    description: "Third-party secure messaging and paging vendor that reaches on-call staff and physicians",
    props: { baa: "Signed BAA required", phiInMessage: "None: patient initials and alert id only, link back to portal", transport: "HTTPS TLS 1.2, IP allowlisted" }
  }
  clinician[Clinician]@{ icon: "user", description: "Nurse, on-call nurse or physician using the portal and pager" }

  %% ---- Flows ----
  wearable -.->|BLE| gateway
  gateway -- "MQTT over TLS 8883, X.509"@{ kind: "network" } --> iot

  iot -- "Event Hubs-compatible endpoint, 32 partitions"@{ kind: "async" } --> stream

  stream -- "upsert reading via private endpoint"@{ kind: "data" } --> pe_cosmos
  pe_cosmos --> cosmos

  stream -- "patient thresholds and device lookup"@{ kind: "data" } --> pe_sql
  pe_sql --> sql

  stream -- "anomaly detected: publish alert"@{ kind: "async" } --> pe_sb
  pe_sb --> sb

  sb -- "peek-lock delivery"@{ kind: "async" } --> alerter

  alerter -- "alert state and audit rows"@{ kind: "data" } --> pe_sql
  alerter -- "HTTPS send page / SMS"@{ kind: "sync" } --> sms

  sms -.->|page| clinician
  clinician -- "HTTPS, Entra ID MFA"@{ kind: "network" } --> portal
  portal --> pe_cosmos
  portal --> pe_sql
  portal -- "ack / resolve via alert id"@{ kind: "sync" } --> alerter

  %% managed identity fetches CMKs and secrets; one edge per consumer would clutter, so fan in
  stream & alerter & portal -- "get secret / unwrap key"@{ kind: "iam" } --> pe_kv
  pe_kv --> kv
  nsg_app -.-> portal
  nsg_proc -.-> stream
```

```arcsync
stateDiagram-v2
  %% diagram: alert-escalation
  [*] --> Raised
  Raised --> Acknowledged: nurse acks within 5 min
  Raised --> EscalatedOnCall: no ack after 5 min
  EscalatedOnCall --> Acknowledged: on-call acks
  EscalatedOnCall --> EscalatedPhysician: no ack after 10 min
  EscalatedPhysician --> Acknowledged: physician acks
  Acknowledged --> Resolved: intervention documented
  Acknowledged --> FalseAlarm: clinician marks artifact
  Resolved --> [*]
  FalseAlarm --> [*]
  Raised: Alert enqueued by anomaly detector, primary nurse paged
  EscalatedOnCall: On-call nurse paged via pager provider
  EscalatedPhysician: Attending physician paged; also logged as missed-SLA event
  FalseAlarm: Feeds threshold tuning, retained in audit trail
```
