# Multi-cloud team chat

```arcsync
flowchart TB
  %% diagram: ex06-multicloud-chat
  %% title: Multi-cloud team chat architecture
  client[Web and mobile clients]@{ icon: "browser", description: "React SPA and native apps holding one WebSocket each", props: { protocol: "wss + HTTPS" } }
  admin[Workspace admin]@{ icon: "user", description: "Configures SSO, billing and installed apps" }

  subgraph aws[AWS - realtime messaging plane]@{ kind: "cloud", region: "us-east-1", owner: "messaging-team" }
    subgraph edge[Edge and uploads]@{ kind: "zone" }
      waf[WAF]@{ icon: "aws:waf", description: "Rate limits and bot rules in front of the API and CDN" }
      cf[CloudFront]@{ icon: "aws:cloudfront", description: "Serves file downloads with signed cookies", props: { priceClass: "PriceClass_All" } }
      files[File upload bucket]@{ icon: "aws:s3", description: "Attachments uploaded via presigned PUT URLs", props: { encryption: "SSE-KMS", lifecycle: "IA after 90d" } }
    end
    subgraph rt[Realtime core]@{ kind: "service" }
      wsapi[WebSocket API]@{ icon: "aws:api-gateway", description: "Holds client connections; routes $connect, $disconnect and sendMessage", props: { idleTimeout: "10m", type: "WEBSOCKET" } }
      rest[REST API]@{ icon: "aws:rest-api", description: "History, channels, upload-URL and admin endpoints" }
      authfn[Connect authorizer]@{ icon: "aws:lambda", description: "Validates the session JWT on $connect and attaches workspace id", props: { runtime: "nodejs22.x" } }
      msgfn[Message handler]@{ icon: "aws:lambda", description: "Validates, persists and publishes each inbound message", props: { runtime: "nodejs22.x", timeout: "5s" } }
      fanout[Fan-out workers]@{ icon: "aws:ecs", description: "Fargate service resolving channel members and pushing frames to connection ids", props: { launchType: "FARGATE", autoscaling: "target 60% CPU" } }
      bus[Message stream]@{ icon: "aws:kinesis", description: "Per-channel ordered stream feeding fan-out and the GCP bridge", props: { shards: "on-demand", retention: "24h" } }
    end
    subgraph data[Data stores]@{ kind: "zone" }
      msgs[(Messages table)]@{ icon: "aws:dynamodb", description: "PK channelId, SK ulid; TTL for retention policies", props: { billing: "on-demand", pitr: "enabled" } }
      conns[(Connections table)]@{ icon: "aws:dynamodb", description: "connectionId to user and channel subscriptions" }
      presence[(Presence cache)]@{ icon: "aws:elasticache", description: "Redis with TTL heartbeat keys and pub/sub for typing indicators", props: { engine: "Redis 7", mode: "cluster" } }
    end
    bridge[Stream to Pub/Sub forwarder]@{ icon: "aws:lambda", description: "Reads the Kinesis stream and publishes to GCP over HTTPS using workload identity federation", props: { batchSize: "100" } }
    hooks[Webhook dispatcher]@{ icon: "aws:sqs", description: "Queue of outbound app-platform deliveries with retry and DLQ", props: { visibilityTimeout: "60s" } }
    appfn[App platform worker]@{ icon: "aws:lambda", description: "Signs payloads with HMAC and POSTs to installed app URLs" }
  end

  subgraph gcp[GCP - analytics and search plane]@{ kind: "cloud", project: "chat-analytics-prod", owner: "data-team" }
    pubsub[Ingest topic]@{ icon: "gcp:pubsub", description: "Receives message events from AWS; one subscription per consumer", props: { retention: "7d" } }
    indexer[Search indexer]@{ icon: "gcp:cloud-run", description: "Pulls events and updates the search index", props: { minInstances: "1", concurrency: "80" } }
    search[Search service]@{ icon: "gcp:cloud-run", description: "Serves workspace-scoped full-text queries over private networking", props: { auth: "OIDC id token" } }
    searchdb[(Search index)]@{ icon: "gcp:bigtable", description: "Inverted-index shards keyed by workspace" }
    bq[(Analytics warehouse)]@{ icon: "gcp:bigquery", description: "Partitioned by day, clustered by workspace_id; feeds usage dashboards", props: { partitioning: "ingestion day", retention: "400d" } }
    sub[BigQuery subscription]@{ icon: "gcp:pubsub", description: "Pub/Sub BigQuery subscription writing raw events with no code in between" }
  end

  subgraph ext[External providers]@{ kind: "zone" }
    idp[Enterprise IdP]@{ icon: "external", kind: "saas", description: "Okta or Entra ID, SAML 2.0 and SCIM provisioning" }
    stripe[Stripe]@{ icon: "external", kind: "saas", description: "Subscriptions, seat-based metering and invoices", expands: "ex06-subscription" }
    twilio[Twilio]@{ icon: "external", kind: "saas", description: "SMS and push for mentions when a user is offline" }
    sendgrid[SendGrid]@{ icon: "external", kind: "saas", description: "Digest and invite emails" }
    apps[Installed apps]@{ icon: "external", kind: "saas", description: "Third-party bots and slash-command servers reached by webhook" }
  end

  client -->|HTTPS| waf
  client ==>|wss| wsapi
  waf --> rest
  client -->|download| cf
  cf --> files
  client -- "presigned PUT"@{ kind: "data" } --> files
  rest -- "presign URL"@{ kind: "iam" } --> files
  rest -->|history| msgs
  wsapi -->|"$connect"| authfn
  wsapi -->|sendMessage| msgfn
  authfn --> conns
  msgfn -->|put item| msgs
  msgfn -->|publish| bus
  msgfn -->|enqueue app events| hooks
  bus --> fanout
  fanout -->|lookup subscribers| conns
  fanout -->|post to connection| wsapi
  fanout -->|check online| presence
  fanout -.->|offline mention| twilio
  fanout -.->|digest| sendgrid
  bus --> bridge
  bridge -- "cross-cloud publish"@{ kind: "network" } --> pubsub
  pubsub --> indexer
  pubsub --> sub
  sub --> bq
  indexer --> searchdb
  search --> searchdb
  rest -- "search proxy"@{ kind: "network" } --> search
  hooks --> appfn
  appfn -- "signed webhook"@{ kind: "network" } --> apps
  apps -->|chat.postMessage| rest
  admin --> rest
  admin -- "SAML / OIDC login"@{ kind: "network" } --> idp
  idp -- "assertion"@{ kind: "network" } --> rest
  rest -- "usage and checkout"@{ kind: "network" } --> stripe
  stripe -.->|webhooks| rest
```

```arcsync
stateDiagram-v2
  %% diagram: ex06-subscription
  [*] --> Trialing
  Trialing --> Active: payment method added
  Trialing --> Canceled: trial expired
  Active --> PastDue: invoice payment failed
  PastDue --> Active: retry succeeded
  PastDue --> Unpaid: dunning exhausted
  Active --> Canceled: admin cancels
  Unpaid --> Canceled: grace period over
  Canceled --> [*]
  Trialing: Full features, seats capped at 10
  PastDue: Stripe Smart Retries running; workspace shows a banner
  Unpaid: Workspace becomes read-only
```
