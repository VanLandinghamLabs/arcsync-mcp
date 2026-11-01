# Video streaming platform on AWS

```arcsync
flowchart LR
  %% diagram: ex01-video-streaming
  %% title: Video streaming platform on AWS
  studio[Studio partner]@{ icon: "external", kind: "partner", description: "Content partners delivering mezzanine masters (ProRes / IMF) over S3 pre-signed multipart upload" }
  viewer[Viewer app]@{ icon: "mobile", kind: "client", description: "TV, mobile and web players using HLS with adaptive bitrate", props: { protocols: "HLS (CMAF), DASH", drm: "Widevine, FairPlay, PlayReady" } }

  subgraph aws[AWS account: media-prod]@{ kind: "account", owner: "media-platform" }
    subgraph region[us-east-1]@{ kind: "region", description: "Primary region; playback is active-active with eu-west-1 via CloudFront origin failover" }

      subgraph ingest[Ingest and transcoding]@{ kind: "service", owner: "content-ops" }
        subgraph intake[Intake]@{ kind: "component-group" }
          mezz[Mezzanine bucket]@{
            icon: "aws:s3",
            description: "Landing zone for partner masters; object-created events start the ingest workflow",
            props: { storageClass: "S3 Standard to Glacier IR after 30d", versioning: "enabled", encryption: "SSE-KMS", eventNotifications: "EventBridge" }
          }
          bus[Ingest event bus]@{
            icon: "aws:eventbridge",
            description: "Routes S3 object-created events to the ingest orchestrator and archives them for replay",
            props: { archiveRetention: "14d" }
          }
        end
        subgraph pipeline[Transcode pipeline]@{ kind: "component-group" }
          orch[Ingest orchestrator]@{
            icon: "aws:step-functions",
            expands: "video-ingest-lifecycle",
            description: "Standard workflow driving one video from upload to publish; retries transcode with backoff",
            props: { type: "STANDARD", maxRetries: "3", backoff: "2x from 30s" }
          }
          validate[Validate media]@{
            icon: "aws:lambda",
            description: "Runs ffprobe checks on codec, frame rate, audio layout and checksum against the partner manifest",
            props: { runtime: "python3.13", memory: "3008 MB", timeout: "5m" }
          }
          transcode[Transcode workers]@{
            icon: "aws:ecs",
            description: "Closest icon to AWS Elemental MediaConvert: encodes the HLS ladder (240p to 4K HDR10) with per-title bitrates",
            props: { ladder: "9 renditions", codecs: "H.264, HEVC, AV1 (top rungs)", segment: "4s CMAF", capacity: "Fargate Spot with on-demand fallback" }
          }
          qc[Automated QC]@{
            icon: "aws:lambda",
            description: "Checks black frames, loudness (EBU R128) and rendition parity before publish",
            props: { runtime: "python3.13", timeout: "15m" }
          }
          jobq[Transcode job queue]@{
            icon: "aws:sqs",
            description: "Buffers transcode tasks so Fargate workers scale on queue depth",
            props: { visibilityTimeout: "2h", dlq: "after 3 receives" }
          }
        end
      end

      subgraph delivery[Delivery]@{ kind: "service", owner: "playback-eng" }
        subgraph origin[Origin tier]@{ kind: "component-group" }
          renditions[HLS rendition bucket]@{
            icon: "aws:s3",
            description: "Stores HLS playlists and CMAF segments; reachable only through CloudFront Origin Access Control",
            props: { objectCount: "~40M segments", lifecycle: "cold titles to Intelligent-Tiering after 90d" }
          }
          drm[DRM key service]@{
            icon: "aws:kms",
            description: "Wraps per-title content keys; license servers fetch them during playback authorisation",
            props: { keyType: "AES-256 CMK per title", rotation: "annual" }
          }
        end
        cdn[CloudFront distribution]@{
          icon: "aws:cloudfront",
          description: "Serves manifests and segments with origin shield in front of S3; signed cookies gate playback",
          props: { priceClass: "All", originShield: "us-east-1", cacheHitTarget: "above 97%", signing: "trusted key group" }
        }
        waf[Edge WAF]@{ icon: "aws:waf", description: "Rate limits and blocks scraping and hotlinking on the distribution" }
      end

      subgraph api[Catalogue and personalisation]@{ kind: "service", owner: "discovery-eng" }
        gw[Public API]@{
          icon: "aws:api-gateway",
          description: "Single entry point for apps; validates Cognito JWTs and throttles per profile",
          props: { type: "HTTP API", throttle: "1000 rps per account" }
        }
        subgraph catalogue[Catalogue service]@{ kind: "microservice" }
          catsvc[Catalogue API]@{
            icon: "aws:ecs",
            description: "Serves titles, seasons, artwork and availability windows by territory",
            props: { runtime: "Java 21 on Fargate", tasks: "12 to 80 autoscaled" }
          }
          catdb[Catalogue table]@{
            icon: "aws:dynamodb",
            description: "Title metadata keyed by titleId with a territory GSI",
            props: { mode: "on-demand", pitr: "enabled" }
          }
          catcache[Catalogue cache]@{ icon: "aws:elasticache", description: "Hot title and row metadata in Redis", props: { engine: "Valkey 8", ttl: "5m" } }
        end
        subgraph reco[Recommendation service]@{ kind: "microservice" }
          recosvc[Recommendation API]@{
            icon: "aws:ecs",
            description: "Returns ranked rows per profile from precomputed candidates re-ranked online",
            props: { runtime: "Python on Fargate", p99: "80 ms" }
          }
          features[Feature store]@{
            icon: "aws:dynamodb",
            description: "Per-profile embeddings and recent-watch features written by the analytics batch jobs",
            props: { ttl: "30d" }
          }
        end
        auth[Viewer identity]@{ icon: "aws:cognito", description: "User pool for accounts and profiles with device-bound refresh tokens" }
      end

      subgraph analytics[Viewing analytics]@{ kind: "service", owner: "data-platform" }
        stream[Viewing events stream]@{
          icon: "aws:kinesis",
          description: "Playback heartbeats, start, stop and QoE events from players",
          props: { mode: "on-demand", retention: "24h", partitionKey: "profileId" }
        }
        fh[Event delivery]@{
          icon: "aws:firehose",
          description: "Buffers and converts events to Parquet in the data lake",
          props: { buffer: "128 MB or 300s", format: "Parquet (Snappy)" }
        }
        lake[Data lake]@{ icon: "aws:s3", description: "Partitioned by date and territory; source for Athena and reco training", props: { retention: "13 months" } }
        dw[Analytics warehouse]@{
          icon: "aws:redshift",
          description: "Serverless warehouse for engagement, QoE and royalty reporting",
          props: { type: "Redshift Serverless", baseRPU: "64" }
        }
      end
    end
  end

  studio -- "multipart upload"@{ kind: "data" } --> mezz
  mezz -- "ObjectCreated"@{ kind: "async" } --> bus
  bus -- "start execution"@{ kind: "async" } --> orch
  orch --> validate
  orch -- "enqueue encode"@{ kind: "async" } --> jobq
  jobq -.-> transcode
  transcode -- "HLS segments"@{ kind: "data" } --> renditions
  orch --> qc
  qc -- "reads renditions"@{ kind: "data" } --> renditions
  orch -- "publish: mark available"@{ kind: "sync" } --> catdb
  transcode -- "content key"@{ kind: "iam" } --> drm

  viewer --> waf --> cdn
  cdn -- "origin fetch (OAC)"@{ kind: "iam" } --> renditions
  viewer -- "browse and play"@{ kind: "sync" } --> gw
  gw -- "JWT authorizer"@{ kind: "iam" } --> auth
  gw --> catsvc & recosvc
  catsvc --> catcache
  catsvc --> catdb
  recosvc --> features
  recosvc -- "title lookup"@{ kind: "sync" } --> catsvc

  viewer -- "playback events"@{ kind: "async" } --> stream
  stream --> fh --> lake
  lake -- "COPY / Spectrum"@{ kind: "data" } --> dw
  lake -- "nightly feature jobs"@{ kind: "data" } --> features
```

```arcsync
stateDiagram-v2
  %% diagram: video-ingest-lifecycle
  [*] --> Uploaded
  Uploaded --> Validating: ObjectCreated event
  Validating --> ValidationResult
  state ValidationResult <<choice>>
  ValidationResult --> Transcoding: media valid
  ValidationResult --> Rejected: invalid media
  Transcoding --> QC: all renditions written
  Transcoding --> RetryWait: encode failed
  RetryWait --> Transcoding: attempts below 3
  RetryWait --> Failed: attempts exhausted
  QC --> Published: QC passed
  QC --> Transcoding: QC failed, re-encode flagged rungs
  Published --> [*]
  Rejected --> [*]
  Failed --> [*]
  Uploaded: Master landed in the mezzanine bucket, checksum recorded
  Validating: ffprobe codec, frame-rate, audio and manifest checksum checks
  Transcoding: Fargate workers encode the 9-rung HLS ladder
  RetryWait: Exponential backoff starting at 30s, then re-queued
  QC: Black frame, loudness and rendition parity checks
  Published: Catalogue marks the title available per territory
  Rejected: Partner notified with validation report
  Failed: Parked for content-ops, SNS page raised
```
