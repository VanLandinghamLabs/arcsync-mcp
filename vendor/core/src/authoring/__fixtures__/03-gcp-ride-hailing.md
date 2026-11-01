# Ride-hailing dispatch on GCP

```arcsync
flowchart LR
  %% diagram: ex03-ride-hailing
  %% title: Ride-hailing dispatch platform (GCP)
  rider[Rider app]@{ icon: "mobile", description: "iOS/Android app that requests trips and shows live driver position", props: { transport: "HTTPS + gRPC streaming" } }
  driver[Driver app]@{ icon: "mobile", description: "Sends GPS pings every 4s while online and receives trip offers over a stream", props: { pingInterval: "4s" } }

  subgraph edge[Edge]@{ kind: "zone" }
    lb[Global external ALB]@{ icon: "gcp:load-balancer", description: "Anycast HTTPS load balancer terminating TLS and routing to GKE NEGs", props: { type: "Global external Application LB", protocols: "HTTP/2, gRPC" } }
    armor[Cloud Armor]@{ icon: "gcp:cloud-armor", description: "WAF and per-IP rate limiting on the trip request and login paths", props: { rules: "OWASP CRS, rate-based ban, geo allowlist" } }
  end

  subgraph gke[GKE regional cluster]@{ kind: "cluster", owner: "platform-team" }
    trip[Trip service]@{ icon: "gcp:gke", description: "Owns the trip lifecycle and persists every state transition to Spanner", props: { language: "Go", scaling: "HPA on CPU and RPS" } }
    dispatch[Dispatch and matching]@{ icon: "gcp:gke", description: "Finds candidate drivers near the pickup and runs the offer round with timeouts", props: { language: "Go", offerTimeout: "15s", maxRounds: "3" } }
    pricing[Pricing service]@{ icon: "gcp:gke", description: "Computes fare estimates and surge multipliers per H3 cell", props: { language: "Java", surgeWindow: "60s per H3 res 8 cell" } }
    loc[Location ingest]@{ icon: "gcp:gke", description: "Validates and fans out driver pings to the geo-index and the Pub/Sub topic", props: { language: "Go", peak: "approx 250k pings/s" } }
    avail[Driver availability]@{ icon: "gcp:gke", description: "Tracks whether each driver can take offers", expands: "driver-availability" }
  end

  subgraph data[Data plane]@{ kind: "zone" }
    ps[driver-locations topic]@{ icon: "gcp:pubsub", description: "Durable buffer for driver pings so ingest bursts never block the hot path", props: { retention: "7d", ordering: "key = driver_id" } }
    sub[Location writer subscription]@{ icon: "gcp:pubsub", description: "Streaming pull subscription consumed by the Bigtable writer", props: { ackDeadline: "30s", deadLetter: "enabled" } }
    bt[Bigtable location history]@{ icon: "gcp:bigtable", description: "Time-series store of driver locations, row key driver_id#reversed_ts", props: { ttl: "30d", cluster: "3 nodes autoscaled" } }
    geo[Memorystore geo-index]@{ icon: "gcp:memorystore", description: "Redis geo index of online drivers keyed by H3 cell for nearby lookups", props: { engine: "Redis 7 cluster", entryTtl: "20s" } }
    spanner[Spanner trips and ledger]@{ icon: "gcp:spanner", description: "Globally consistent store for trips and the double-entry payments ledger", props: { config: "nam-eur-asia1", processingUnits: "autoscaled" } }
    bq[BigQuery analytics]@{ icon: "gcp:bigquery", description: "Warehouse for trip, pricing and supply/demand analytics", props: { ingestion: "Spanner change streams via Dataflow" } }
  end


  pay[Payment processor]@{ icon: "external", kind: "saas", description: "External card processor, for example Stripe or Adyen, that authorizes and captures fares" }
  maps[Maps provider]@{ icon: "external", kind: "saas", description: "External routing, ETA and geocoding provider, for example Google Maps Platform" }

  rider --> lb
  driver --> lb
  armor -.->|protects| lb
  lb -- "gRPC trip requests"@{ kind: "sync" } --> trip
  lb -- "location pings"@{ kind: "sync" } --> loc
  trip -- "price quote"@{ kind: "sync" } --> pricing
  trip -- "find driver"@{ kind: "sync" } --> dispatch
  dispatch -- "nearby drivers (GEOSEARCH)"@{ kind: "data" } --> geo
  dispatch -- "driver offer"@{ kind: "sync" } --> avail
  dispatch -- "ETA matrix"@{ kind: "sync" } --> maps
  pricing -- "route distance"@{ kind: "sync" } --> maps
  loc -- "update position"@{ kind: "data" } --> geo
  loc -- "publish ping"@{ kind: "async" } --> ps
  ps -.-> sub
  sub -- "batched writes"@{ kind: "data" } --> bt
  trip -- "transactions"@{ kind: "data" } --> spanner
  trip -- "authorize and capture"@{ kind: "sync" } --> pay
  pay -- "webhook: settled"@{ kind: "async" } --> trip
  spanner -- "change stream"@{ kind: "async" } --> bq
  bt -- "daily export"@{ kind: "data" } --> bq
```

```arcsync
stateDiagram-v2
  %% diagram: trip-lifecycle
  %% title: Trip lifecycle
  [*] --> Requested: rider requests
  Requested --> Matching: fare accepted
  Requested --> Cancelled: rider cancels
  Matching --> DriverAssigned: driver accepts offer
  Matching --> NoDriversFound: offer rounds exhausted
  Matching --> Cancelled: rider cancels
  DriverAssigned --> EnRoute: driver starts pickup
  DriverAssigned --> Matching: driver cancels, rematch
  DriverAssigned --> Cancelled: rider cancels
  EnRoute --> InProgress: rider picked up
  EnRoute --> Matching: driver cancels, rematch
  EnRoute --> Cancelled: rider cancels, fee may apply
  InProgress --> Completed: dropoff confirmed
  NoDriversFound --> [*]
  Cancelled --> [*]
  Completed --> [*]
  Requested: Trip row created in Spanner with quoted fare
  Matching: Dispatch runs offer rounds against nearby drivers
  DriverAssigned: Driver accepted and the offer is locked
  EnRoute: Driver heading to pickup, ETA streamed to rider
  InProgress: Trip underway, fare meter running
  Completed: Fare captured and ledger entries written
  Cancelled: Cancellation fee evaluated by pickup stage
  NoDriversFound: Rider notified, pre-authorization released
```

```arcsync
stateDiagram-v2
  %% diagram: driver-availability
  %% title: Driver availability
  [*] --> Offline
  Offline --> Available: goes online
  Available --> Offered: dispatch sends offer
  Offered --> Busy: accepts offer
  Offered --> Available: declines or times out
  Busy --> Available: trip completed
  Available --> Offline: goes offline
  Busy --> Offline: app lost heartbeat
  Offline: Not in the geo-index
  Available: In the geo-index and eligible for offers
  Offered: Held out of matching for the 15s offer window
  Busy: Assigned to a trip, removed from the geo-index
```
