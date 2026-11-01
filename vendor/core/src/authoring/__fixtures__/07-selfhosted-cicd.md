# Self-hosted CI/CD and GitOps platform

```arcsync
flowchart LR
  %% diagram: ex07-cicd
  %% title: Self-hosted CI/CD and GitOps platform
  dev[Developer]@{ icon: "user", description: "Pushes branches and opens pull requests; approves production promotions", props: { auth: "GitHub SSO (SAML)" } }
  gh[GitHub]@{ icon: "external", kind: "saas", description: "Source of truth for application and config repos; emits push and pull_request webhooks", props: { repos: "app-*, platform-config", branchProtection: "required reviews + status checks" } }
  slack[Slack]@{ icon: "external", kind: "saas", description: "Receives build, approval and alert notifications", props: { channels: "#deploys, #alerts-platform" } }
  pd[PagerDuty]@{ icon: "external", kind: "saas", description: "Pages the on-call engineer for critical alerts", props: { escalation: "primary 5m, secondary 15m" } }

  subgraph onprem[On-prem datacentre]@{ kind: "zone", site: "dc1", network: "10.20.0.0/16" }
    ingress[Ingress and webhook gateway]@{ icon: "service", kind: "ingress", description: "Terminates TLS and forwards GitHub webhooks to the runner controller after HMAC check", props: { software: "ingress-nginx", allowlist: "GitHub hook CIDRs", tls: "cert-manager + Let's Encrypt" } }

    subgraph ci[CI cluster]@{ kind: "kubernetes", distro: "RKE2 1.30", nodes: "9 workers" }
      arc[Runner controller]@{ icon: "service", kind: "operator", description: "Scales ephemeral self-hosted runner pods per queued workflow job", props: { chart: "actions-runner-controller", minRunners: "2", maxRunners: "40" } }
      runner[Build runners]@{ icon: "service", kind: "runner", description: "One-shot pods that build with BuildKit rootless and push images", props: { image: "runner-ubuntu-22.04", cpu: "4", memory: "8Gi", builder: "buildkit rootless" } }
      cache[Build cache]@{ icon: "database", kind: "cache", description: "BuildKit layer cache and dependency mirror shared by runners", props: { software: "MinIO", capacity: "2TiB", retention: "14d" } }
    end

    subgraph registry[Artifact registry]@{ kind: "service" }
      harbor[Harbor]@{ icon: "service", kind: "oci-registry", description: "Stores images and Helm charts; blocks pulls of images failing the severity policy", props: { projects: "apps, base-images", replication: "to dc2 nightly", signing: "cosign" } }
      trivy[Trivy scanner]@{ icon: "service", kind: "scanner", description: "Scans on push and rescans daily; blocks images with CRITICAL CVEs", props: { blockSeverity: "CRITICAL", db: "trivy-db, updated 6h" } }
      harborDb[Harbor metadata DB]@{ icon: "database", kind: "postgres", description: "Metadata and scan results", props: { engine: "PostgreSQL 16", ha: "Patroni 3 nodes" } }
    end

    subgraph gitops[GitOps control plane]@{ kind: "kubernetes", distro: "RKE2 1.30" }
      confrepo[Config repo mirror]@{ icon: "database", kind: "git", description: "Read-only mirror of platform-config used for fast Argo CD fetches", props: { software: "Gitea", sync: "pull every 1m" } }
      argo[Argo CD]@{ icon: "service", kind: "gitops", description: "Reconciles Helm and Kustomize manifests into target clusters; ApplicationSets per environment", props: { version: "2.12", syncPolicy: "auto-sync staging, manual prod", selfHeal: "true" } }
      rollouts[Argo Rollouts]@{ icon: "service", kind: "progressive-delivery", description: "Runs canary analysis against Prometheus metrics and aborts on SLO breach", props: { strategy: "canary 10/50/100", analysis: "error rate, p99" } }
    end

    subgraph envs[Target clusters]@{ kind: "environment" }
      stg[Staging cluster]@{ icon: "service", kind: "kubernetes", description: "Pre-production cluster mirroring prod topology at reduced scale", props: { nodes: "6", namespaces: "per team" } }
      prod[Production cluster]@{ icon: "service", kind: "kubernetes", description: "Serves customer traffic; changes only via approved Argo CD syncs", props: { nodes: "24", zones: "3 racks", netpol: "default deny" } }
    end

    subgraph secrets[Secrets]@{ kind: "service" }
      vault[HashiCorp Vault]@{ icon: "service", kind: "secrets", description: "Issues short-lived secrets; runners authenticate with Kubernetes auth, apps via Vault Agent injector", props: { version: "1.17", storage: "Raft 5 nodes", unseal: "transit auto-unseal" } }
    end

    subgraph obs[Observability]@{ kind: "service" }
      prom[Prometheus]@{ icon: "database", kind: "metrics", description: "Scrapes all clusters; remote-writes to long-term storage", props: { retention: "15d local", scrape: "30s", ha: "2 replicas via Thanos sidecar" } }
      graf[Grafana]@{ icon: "browser", kind: "dashboards", description: "Pipeline, DORA and cluster dashboards", props: { auth: "OIDC" } }
      am[Alertmanager]@{ icon: "service", kind: "alerting", description: "Dedupes, groups and routes alerts by severity label", props: { ha: "3-node gossip cluster", routes: "critical -> PagerDuty, warning -> Slack" } }
    end
  end

  dev -- "git push / PR"@{ kind: "network" } --> gh
  dev -- "approve prod"@{ kind: "sync" } --> argo
  gh -- "webhook (workflow_job)"@{ kind: "network" } --> ingress
  ingress --> arc
  arc -- "spawns pods"@{ kind: "sync" } --> runner
  runner -- "clone" --> gh
  runner <-->|layers| cache
  runner -- "docker push"@{ kind: "data" } --> harbor
  runner -- "bump image tag"@{ kind: "sync" } --> gh
  harbor -- "scan on push"@{ kind: "async" } --> trivy
  harbor --> harborDb
  gh -.->|mirror| confrepo
  confrepo --> argo
  argo -- "sync"@{ kind: "sync" } --> stg
  argo -- "sync (manual gate)"@{ kind: "sync" } --> prod
  argo --> rollouts
  stg -- "pull image" --> harbor
  prod -- "pull image" --> harbor
  runner -- "k8s auth, fetch creds"@{ kind: "iam" } --> vault
  stg -- "inject secrets"@{ kind: "iam" } --> vault
  prod -- "inject secrets"@{ kind: "iam" } --> vault
  stg & prod & argo & runner -.->|metrics| prom
  prom --> graf
  prom -- "firing rules" --> am
  rollouts -- "analysis queries" --> prom
  am -- "critical"@{ kind: "async" } --> pd
  am -- "warning"@{ kind: "async" } --> slack
  argo -.->|deploy notifications| slack

  pipeline[Deployment pipeline]@{ icon: "service", kind: "state-machine", description: "Lifecycle of one change from commit to production", expands: "deploy-flow" }
  gh --> pipeline
```

```arcsync
stateDiagram-v2
  %% diagram: deploy-flow
  [*] --> Queued
  Queued --> Building: runner assigned
  Building --> Scanning: image pushed
  Building --> Failed: build error
  Scanning --> AwaitingApproval: no critical CVEs
  Scanning --> Failed: critical CVE found
  AwaitingApproval --> DeployingStaging: approved
  AwaitingApproval --> Cancelled: rejected or timed out
  DeployingStaging --> SmokeTests: Argo CD healthy
  DeployingStaging --> RollingBack: sync failed
  SmokeTests --> Promoting: tests passed
  SmokeTests --> RollingBack: tests failed
  Promoting --> Deployed: canary analysis passed
  Promoting --> RollingBack: SLO breach
  RollingBack --> RolledBack: previous revision restored
  Deployed --> [*]
  RolledBack --> [*]
  Failed --> [*]
  Cancelled --> [*]
  Queued: Waiting for a free ephemeral runner
  Building: BuildKit build and push to Harbor
  Scanning: Trivy scan with CRITICAL gate
  AwaitingApproval: Manual approval by a code owner
  DeployingStaging: Argo CD syncs the bumped tag into staging
  SmokeTests: Post-deploy HTTP and synthetic checks
  Promoting: Manual sync to production with canary rollout
  RollingBack: Argo CD reverts to the last healthy revision
```

Branching strategy (plain Mermaid, no metadata):

```arcsync
flowchart TD
  %% diagram: ex07-branching
  feature[feature branch] --> pr{Pull request}
  pr -->|checks pass and review| main[main]
  pr -->|checks fail| feature
  main --> tag[release tag vX.Y.Z]
  tag --> hotfix[hotfix branch]
  hotfix --> main
```
