# Orders data model

```arcsync
flowchart LR
  %% diagram: orders-data-model
  %% title: Orders service with data model
  shopper[Shopper]@{ icon: "user" }
  subgraph api[Orders API]@{ kind: "service" }
    gw[API Gateway]@{ icon: "aws:api-gateway" }
    fn[Orders handler]@{ icon: "aws:lambda" }
    orders[(Orders DB)]@{ icon: "aws:rds", expands: "orders-schema", description: "Aurora Postgres" }
  end
  shopper --> gw --> fn --> orders
```

```arcsync
erDiagram
  %% diagram: orders-schema
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  PRODUCT ||--o{ LINE_ITEM : "ordered as"
  CUSTOMER |o--o{ CUSTOMER : "referred"
  CUSTOMER {
    uuid id PK
    string email UK
    string name
  }
  ORDER {
    uuid id PK
    uuid customer_id FK
    timestamp placed_at
    string status
  }
  LINE_ITEM {
    uuid order_id PK, FK
    uuid product_id PK, FK
    int quantity
    numeric unit_price
  }
  PRODUCT {
    uuid id PK
    string sku UK
    string title
  }
```
