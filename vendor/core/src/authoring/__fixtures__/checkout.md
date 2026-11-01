# Checkout service

```arcsync
flowchart LR
  %% diagram: checkout-architecture
  %% title: Checkout architecture
  shopper[Shopper]@{ icon: "user" }
  subgraph edge[Edge]@{ kind: "zone" }
    cdn[CloudFront]@{ icon: "aws:cloudfront" }
  end
  subgraph api[Checkout API]@{ kind: "service", owner: "payments-team" }
    gw[API Gateway]@{ icon: "aws:api-gateway" }
    fn[Checkout handler]@{
      icon: "aws:lambda",
      description: "Validates the cart and starts the order workflow",
      props: { runtime: "nodejs22.x", timeout: "10s" }
    }
    sfn[Order workflow]@{ icon: "aws:step-functions", expands: "order-flow" }
    orders[(Orders)]@{ icon: "aws:dynamodb", description: "One item per order, keyed by orderId" }
  end
  stripe[Stripe]@{ icon: "external", kind: "saas" }
  shopper --> cdn --> gw --> fn
  fn -- "StartExecution"@{ kind: "async" } --> sfn
  sfn -->|charge| stripe
  sfn --> orders
```

```arcsync
stateDiagram-v2
  %% diagram: order-flow
  [*] --> Reserve
  Reserve --> Charge
  Charge --> Fulfil: paid
  Charge --> Refund: declined
  Fulfil --> [*]
  Refund --> [*]
```
