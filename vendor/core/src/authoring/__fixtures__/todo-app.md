# To-do app

```arcsync
flowchart LR
  %% diagram: todo-app
  %% title: To-do app
  user[User]@{ icon: "browser", description: "Uses the SPA in a browser or as an installed PWA" }

  subgraph edge[Edge]@{ kind: "zone" }
    cdn[CloudFront]@{ icon: "aws:cloudfront", description: "Serves the SPA and routes /api to the API" }
    site[SPA bucket]@{ icon: "aws:s3", description: "Built static assets", props: { versioning: "on" } }
    auth[User pool]@{ icon: "aws:cognito", description: "Sign-up, sign-in and JWTs for the API" }
  end

  subgraph api[Todo API]@{ kind: "service", owner: "app-team" }
    gw[HTTP API]@{ icon: "aws:api-gateway", description: "JWT authorizer backed by the user pool" }
    todos[Todos handler]@{
      icon: "aws:lambda",
      description: "Create, update, complete and delete to-dos; enforces the lifecycle",
      props: { runtime: "nodejs22.x", memory: "256 MB" },
      expands: "todo-lifecycle"
    }
    search[Search handler]@{
      icon: "aws:lambda",
      description: "Loads the user's Orama index from S3, caches it in memory and answers queries",
      props: { runtime: "nodejs22.x", memory: "1024 MB", engine: "Orama BM25" }
    }
  end

  subgraph data[Data]@{ kind: "zone" }
    table[(Todos table)]@{
      icon: "aws:dynamodb",
      description: "One item per to-do, partitioned by user",
      props: { pk: "USER#id", sk: "TODO#id", billing: "on-demand", stream: "NEW_AND_OLD_IMAGES" }
    }
    subgraph indexing[Search indexing]@{ kind: "service" }
      indexer[Indexer]@{ icon: "aws:lambda", description: "Applies stream changes to the user's Orama index and writes it back", props: { batchSize: 100 } }
      dlq[Indexer DLQ]@{ icon: "aws:sqs", description: "Stream batches that failed after retries" }
      shards[Index shards]@{ icon: "aws:s3", description: "One gzipped Orama index per user", props: { key: "search/{userId}.json.gz" } }
    end
  end

  user --> cdn
  cdn --> site
  cdn -->|/api| gw
  user -.->|sign in| auth
  gw -.->|verify JWT| auth
  gw --> todos
  gw --> search
  todos -->|read / write| table
  table -- "stream"@{ kind: "data" } --> indexer
  indexer -->|put index| shards
  indexer -.->|on failure| dlq
  search -->|get index| shards
```

```arcsync
stateDiagram-v2
  %% diagram: todo-lifecycle
  [*] --> Open
  Open --> InProgress: start
  Open --> Done: complete
  Open --> Archived: archive
  InProgress --> Done: complete
  InProgress --> Open: pause
  Done --> Open: reopen
  Done --> Archived: archive
  Archived --> [*]
  Open: Created, with an optional due date
  Done: completedAt set; still searchable
  Archived: Hidden from lists and dropped from the search index
```
