# ArcSync parse pipeline

```arcsync
flowchart LR
  %% diagram: arcsync-parse-pipeline
  %% title: ArcSync parse pipeline
  dev[Developer]@{ icon: "user", description: "Pushes IaC changes or uploads a folder" }
  gh[GitHub]@{ icon: "external", kind: "saas", description: "Sends push and installation webhooks to the GitHub App" }

  subgraph edge[Edge]@{ kind: "zone" }
    cf[arcsync.dev]@{ icon: "aws:cloudfront", description: "Serves the SPA and marketing site" }
    apigw[REST API]@{ icon: "aws:rest-api", description: "api.arcsync.dev, JWT and arc_ token authorizer" }
  end

  subgraph backend[ArcSyncBackend]@{ kind: "stack" }
    api[API handler]@{
      icon: "aws:lambda",
      description: "Routes requests, seeds the JOB# progress row, checks quota",
      props: { runtime: "nodejs22.x", owner: "platform" }
    }
    webhook[GitHub webhook]@{ icon: "aws:lambda", description: "Verifies the signature and starts an auto-refresh parse" }
    subgraph sandbox[Synth sandbox]@{ kind: "service", description: "Runs CDK and Pulumi programs server-side" }
      router[Sandbox router]@{ icon: "aws:lambda", description: "Picks the per-language builder", expands: "parse-job" }
      builders[Language builders]@{
        icon: "aws:lambda",
        description: "TypeScript, Python, Java, Go and C# synth images",
        props: { languages: 5, packaging: "container image" }
      }
    end
    parser[Parser]@{ icon: "aws:lambda", description: "Turns templates and HCL into the ArchGraph" }
    thumbs[Thumbnail renderer]@{ icon: "aws:lambda", description: "Renders 9 variants with Fabric.js", props: { formats: "avif, webp, png" } }
    subgraph storage[Storage]@{ kind: "zone" }
      table[(Graphs table)]@{ icon: "aws:dynamodb", description: "CANON, VERSION#, LIBRARY# and JOB# rows", props: { gsis: 6 } }
      bucket[Graphs bucket]@{ icon: "aws:s3", description: "graphData JSON and thumbnails" }
    end
    subgraph search[Search]@{ kind: "service" }
      delta[Search delta]@{ icon: "aws:lambda", description: "Appends index ops from the table stream" }
      shards[Search shards]@{ icon: "aws:s3", description: "Gzipped Orama shards per org plus the gallery" }
    end
  end

  dev --> cf --> apigw --> api
  dev --> gh
  gh -- "push webhook" --> webhook
  api & webhook -- "start parse"@{ kind: "async" } --> router
  router --> builders --> parser
  router --> parser
  parser -->|writes CANON| table
  parser -->|graphData| bucket
  parser -.->|render| thumbs
  thumbs --> bucket
  table -- "stream"@{ kind: "data" } --> delta --> shards
```

```arcsync
stateDiagram-v2
  %% diagram: parse-job
  [*] --> Pending
  Pending --> Synthesizing: CDK or Pulumi
  Pending --> Parsing: templates or HCL
  Synthesizing --> Parsing
  Synthesizing --> Failed: synth error
  Parsing --> Complete: graph stored
  Parsing --> Failed: parse error
  Parsing --> Cancelled: user cancelled
  Complete --> [*]
  Failed --> [*]
  Cancelled --> [*]
  Pending: JOB# row seeded, quota consumed
  Synthesizing: Per-language builder runs the program
  Complete: CANON converges, thumbnail render queued
```
