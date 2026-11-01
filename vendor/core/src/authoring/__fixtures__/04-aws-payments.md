# AWS payments platform

```arcsync
flowchart LR
  %% diagram: ex04-payments
  %% title: Payments platform on AWS
  merchant[Merchant backend]@{ icon: "external", kind: "client", description: "Merchant servers calling the payments API with secret keys" }
  endpoint[Merchant webhook endpoint]@{ icon: "external", kind: "client", description: "HTTPS endpoint registered by the merchant to receive signed events" }
  cardnet{{Card networks}}@{ icon: "external", kind: "external", description: "Visa / Mastercard authorization and clearing via acquirer processor", props: { protocol: "ISO 8583 over mTLS", sla: "p99 < 1.5s" } }
  bank{{Bank / ACH rails}}@{ icon: "external", kind: "external", description: "Sponsor bank for ACH debits and settlement payouts", props: { protocol: "SFTP + REST", cutoff: "17:00 ET" } }

  subgraph aws[AWS account: payments-prod]@{ kind: "account", owner: "payments-platform" }
    subgraph edge[API edge]@{ kind: "zone" }
      waf[WAF]@{ icon: "aws:waf", description: "Rate limits per API key and blocks known bad IPs", props: { rateLimit: "2000 req / 5 min / IP" } }
      apigw[Merchant API]@{ icon: "aws:api-gateway", description: "REST API for charges, refunds and customers; authorizes with a Lambda authorizer on the API key", props: { type: "REST regional", throttle: "10000 rps" } }
    end

    subgraph app[Payment services]@{ kind: "service", owner: "payments-core" }
      charge[Charge handler]@{ icon: "aws:lambda", description: "Validates the request, enforces idempotency and starts the payment saga", props: { runtime: "nodejs22.x", memory: "1024MB", timeout: "29s" } }
      idem[(Idempotency keys)]@{ icon: "aws:dynamodb", description: "Stores request fingerprint and response by merchant and Idempotency-Key", props: { ttl: "24h", billing: "on-demand", pitr: "enabled" } }
      saga[Payment saga]@{ icon: "aws:step-functions", expands: "payment-saga", description: "Express-less standard workflow orchestrating authorize, risk, capture and ledger with compensations", props: { type: "STANDARD", timeout: "5m" } }
      risk([Risk scoring])@{ icon: "aws:lambda", description: "Rules plus ML model score; declines or flags for 3DS above threshold", props: { runtime: "python3.12", model: "xgboost via SageMaker endpoint" } }
      authorizer[Authorize and capture]@{ icon: "aws:lambda", description: "Calls the card network through the PCI gateway; handles auth, capture, void and refund", props: { runtime: "java21", memory: "2048MB", reservedConcurrency: "500" } }
      ledgerfn[Ledger writer]@{ icon: "aws:lambda", description: "Posts balanced debit and credit entries in a single serializable transaction", props: { runtime: "java21", memory: "1024MB" } }
    end

    ledger[(Double-entry ledger)]@{ icon: "aws:aurora", kind: "database", description: "Append-only journal and account balances; entries must sum to zero per transaction", props: { engine: "Aurora PostgreSQL 16", multiAz: "true", isolation: "SERIALIZABLE", backup: "35 days" } }

    subgraph events[Event delivery]@{ kind: "service", owner: "platform-events" }
      bus[Payments event bus]@{ icon: "aws:eventbridge", description: "Receives payment.succeeded, refund.created and other domain events; rules fan out per merchant subscription", props: { archive: "30 days" } }
      whq[Webhook queue]@{ icon: "aws:sqs", description: "Standard queue buffering outbound deliveries", props: { visibilityTimeout: "60s", maxReceiveCount: "1" } }
      dispatcher[Webhook dispatcher]@{ icon: "aws:lambda", expands: "webhook-delivery", description: "Signs the payload (HMAC-SHA256), POSTs to the merchant endpoint and schedules retries with backoff", props: { runtime: "nodejs22.x", timeout: "30s", maxAttempts: "8" } }
      retryq[Retry queue]@{ icon: "aws:sqs", description: "Delay queue used for exponential backoff, redelivering to the dispatcher", props: { delaySeconds: "up to 900" } }
      dlq>Webhook DLQ]@{ icon: "aws:sqs", kind: "dlq", description: "Deliveries that exhausted all attempts, kept for replay from the dashboard", props: { retention: "14 days", alarm: "ApproximateNumberOfMessagesVisible > 0" } }
    end

    subgraph pci[PCI VPC 10.20.0.0/16]@{ icon: "aws:vpc", kind: "zone", description: "Isolated cardholder data environment; no internet gateway, egress only through the proxy", props: { scope: "PCI DSS L1", flowLogs: "enabled" } }
      subgraph subA[Private subnet 10.20.1.0/24 AZ-a]@{ icon: "aws:subnet", kind: "subnet" }
        vault[Tokenization service]@{ icon: "aws:ecs", description: "Fargate service that receives PANs, encrypts them and returns opaque tokens; the only component that sees raw card data", props: { launchType: "Fargate", tasks: "6", cpu: "2 vCPU" } }
      end
      subgraph subB[Private subnet 10.20.2.0/24 AZ-b]@{ icon: "aws:subnet", kind: "subnet" }
        gateway[Network gateway]@{ icon: "aws:ecs", description: "Fargate service holding mTLS connections to card networks and the sponsor bank", props: { launchType: "Fargate", tasks: "4" } }
      end
      kms[Card data key]@{ icon: "aws:kms", description: "Customer managed key used for envelope encryption of PANs; rotated yearly", props: { spec: "SYMMETRIC_DEFAULT", rotation: "365d", policy: "vault task role only" } }
    end
  end

  merchant --> waf
  waf --> apigw
  apigw -- "POST /v1/charges"@{ kind: "sync" } --> charge
  charge -- "conditional put"@{ kind: "data" } --> idem
  charge -- "StartExecution"@{ kind: "async" } --> saga
  saga -- "authorize / capture / void / refund"@{ kind: "sync" } --> authorizer
  saga -- "score"@{ kind: "sync" } --> risk
  saga -- "post entries"@{ kind: "sync" } --> ledgerfn
  ledgerfn -- "INSERT journal"@{ kind: "data" } --> ledger
  authorizer -- "PrivateLink"@{ kind: "network" } --> vault
  vault -- "GenerateDataKey / Decrypt"@{ kind: "iam" } --> kms
  authorizer -- "PrivateLink"@{ kind: "network" } --> gateway
  gateway -- "mTLS"@{ kind: "network" } --> cardnet
  gateway -- "SFTP"@{ kind: "network" } --> bank
  saga -.->|PutEvents| bus
  bus -- "rule per subscription"@{ kind: "async" } --> whq
  whq --> dispatcher
  dispatcher -- "HTTPS POST"@{ kind: "sync" } --> endpoint
  dispatcher -.->|on failure| retryq
  retryq -.-> dispatcher
  dispatcher -.->|after 8 attempts| dlq
```

```arcsync
stateDiagram-v2
  %% diagram: payment-saga
  state "Authorize card with network" as Authorize
  state "Risk check (rules + ML)" as Risk
  state "Capture funds" as Capture
  state "Write ledger entries" as Ledger
  state "Void authorization" as Void
  state "Refund captured funds" as Refund
  [*] --> Authorize
  Authorize --> Risk: approved
  Authorize --> Failed: declined
  Risk --> Capture: low risk
  Risk --> Void: high risk
  Capture --> Ledger: captured
  Capture --> Void: capture failed
  Ledger --> Succeeded: committed
  Ledger --> Refund: ledger write failed
  Void --> Failed: voided
  Refund --> Failed: refunded
  Succeeded --> [*]
  Failed --> [*]
  Authorize: Sends 0100 auth request via the PCI gateway, 10s timeout, retried once
  Risk: Velocity, BIN and device checks; may require 3DS challenge
  Capture: Submits clearing record; idempotent on the network reference
  Ledger: Debit merchant receivable, credit platform clearing, in one transaction
  Void: Compensating step; reverses the hold on the cardholder
  Refund: Compensating step; issues a full refund after a ledger failure
```

```arcsync
stateDiagram-v2
  %% diagram: webhook-delivery
  state "Waiting for backoff" as Retrying
  state "Dead-lettered" as Dead
  state attempt <<choice>>
  [*] --> Pending
  Pending --> Delivering: dequeued
  Delivering --> attempt: response or timeout
  attempt --> Delivered: 2xx
  attempt --> Retrying: non-2xx, timeout, attempts < 8
  attempt --> Dead: attempts exhausted
  Retrying --> Delivering: delay elapsed
  Delivered --> [*]
  Dead --> [*]
  Pending: Event matched a subscription and is queued
  Delivering: Signed POST with 30s timeout
  Retrying: Backoff 30s, 2m, 10m, 1h, 3h and so on with jitter
  Dead: Moved to DLQ; replayable by the merchant
```
