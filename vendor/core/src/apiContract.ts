/**
 * Wire shapes the API returns and the SPA reads, declared once so the backend
 * handler and the frontend client cannot drift apart. Types only:
 * `apiContract.guard.test.ts` fails on any runtime statement here, because
 * this module is imported by every Lambda and by the SPA's eager api chunk.
 */
import type {
  ChangedNodeDetail,
  DeltaCounts,
  DeltaEdge,
  DeltaEnvelope,
  DeltaNode,
} from "./graph/graphDelta.js";
import type { DiagramOverrides, RepoInfo } from "./graph/types.js";
import type { LibrarySummary } from "./library.js";
import type { QuotaErrorCode } from "./quotaErrorCodes.js";
import type { Tier, TierLimits } from "./quotaLimits.js";
import type { JobStatus, Source } from "./status.js";
import type { SynthInputs } from "./synthInputs.js";

export type OrgRole = "owner" | "admin" | "editor" | "viewer";

/** `PUT /orgs/current` and `POST /invites/accept`. */
export interface OrgMembership {
  orgId: string;
  role: OrgRole;
}

/**
 * One entry of `GET /orgs`. `name` is null when the org's META row is gone.
 * `tier` is the org's billing row's tier (`free` without one), not counting a
 * comp: the SPA reads it to tell an owner a Team checkout ends their Pro plan.
 */
export interface OrgSummary {
  orgId: string;
  name: string | null;
  role: OrgRole;
  joinedAt: string;
  tier: Tier;
  /**
   * The billing row holds a Stripe subscription id. A past-due Pro the grace
   * sweep flipped to free still has one, and Team checkout still replaces it.
   */
  subscribed: boolean;
}

/** `GET /orgs`. */
export interface OrgList {
  orgs: OrgSummary[];
  currentOrgId: string;
}

/** `POST /orgs`. `created` is false when a retry found the org its request already made. */
export interface CreatedOrg {
  orgId: string;
  name: string;
  role: "owner";
  created: boolean;
}

/** `GET /invites/preview`: the invite as the signed-in caller sees it. */
export interface InvitePreview {
  orgName: string;
  role: Exclude<OrgRole, "owner">;
  inviterName: string | null;
  expiresAt: string;
  emailMatches: boolean;
  emailVerified: boolean;
}

export interface SeatUsage {
  seatsPurchased: number;
  members: number;
  pendingInvites: number;
  used: number;
}

/** What adding one more member costs the org. */
export interface SeatPreview extends SeatUsage {
  willAddSeat: boolean;
  nextSeatsPurchased: number;
  currency: string;
  proratedAmountCents: number | null;
}

/** `GET /api/github/pat`: the stored PAT's metadata, never the token. */
export interface PatMeta {
  tokenPrefix: string;
  lastFour: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  validatedScopeCount: number;
}

/** `ingest` is the GitHub Action credential; `mcp` is for coding agents
 * through the ArcSync MCP server. Pre-#1857 rows are `ingest`. */
export type CiCredentialScope = "ingest" | "mcp";

/** A row of `GET /account/ci-credentials`. */
export interface CiCredentialMeta {
  clientId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  scope?: CiCredentialScope;
}

/** `POST /account/ci-credentials`: the only response that carries `secret`. */
export interface NewCiCredential {
  clientId: string;
  secret: string;
  label: string;
  createdAt: string;
  scope?: CiCredentialScope;
}

/** `GET /account/export.json`: a presigned link to the staged export. */
export interface AccountExportLink {
  downloadUrl: string;
  diagramCount: number;
  expiresInSeconds: number;
}

export type HistoryTrigger = "auto-refresh" | "local-watch" | "manual";

export interface HistoryListEntry {
  timestamp: string;
  parsedAt: string;
  commitSha?: string;
  /** Diff against the true previous snapshot. Absent on rows not yet backfilled. */
  changeSummary?: DeltaCounts;
  /** Resource names for the change headline from `added`, `removed` and
   * `changed` only (a code-only resource is never in `changed`), at most 3
   * per group: the first 3 by display name (`localeCompare`). The full
   * counts are in `changeSummary`. Absent whenever `changeSummary` is absent. */
  changeNames?: HistoryChangeNames;
  /** Absent on rows written before the attribute existed; treat as "manual". */
  triggeredBy?: HistoryTrigger;
}

export interface HistoryChangeNames {
  added: string[];
  removed: string[];
  changed: string[];
}

/** `GET /graphs/{id}/history`. With `?sample=1`, `entries` is a sample of at
 * most 50 snapshots spanning the whole history, newest first, that
 * always holds the oldest and newest snapshot. Snapshots with an architecture
 * change are kept ahead of code-only ones, and rows with no `changeSummary`
 * rank with code-only; the remaining slots are spread evenly across time.
 * A history of at most 50 snapshots returns all of them.
 * `total` is present only with `?sample=1`: the number of snapshots sampled
 * from (`entries.length` when nothing was left out). `nextCursor` is then
 * absent. */
export interface HistoryListResponse {
  entries: HistoryListEntry[];
  nextCursor?: string;
  total?: number;
}

/** `GET /graphs/{id}/history/{timestamp}`. No layout of its own: a snapshot
 * is drawn with the live overrides (#2150). */
export interface HistorySnapshot {
  graphData: Record<string, unknown>;
  commitSha?: string;
  parsedAt: string;
}

export interface HistoryDiffSide {
  timestamp: string;
  commitSha?: string;
}

/**
 * `GET /graphs/{id}/history/{timestamp}/diff`. `base` names the OLDER side and
 * `head` the NEWER side on both `against` modes, so `added`/`removed` are
 * always relative to base -> head. `base` is `null` only when `isInitial` is
 * true; it stays populated when `isLiveUnavailable` is true.
 */
export interface HistoryDiff {
  base: HistoryDiffSide | null;
  head: HistoryDiffSide;
  isInitial: boolean;
  isLiveUnavailable: boolean;
  counts: DeltaCounts;
  nodes: {
    added: DeltaNode[];
    removed: DeltaNode[];
    changed: ChangedNodeDetail[];
    /** Changed only in deploy-artifact pointers; not in `changed`. Absent
     * from servers that predate the classification. */
    codeOnly?: ChangedNodeDetail[];
  };
  edges: { added: DeltaEdge[]; removed: DeltaEdge[] };
}

/** `GET /billing/usage`. The counters and their caps are separate objects:
 * `usage.parsesThisMonth` is compared against `limits.parsesPerMonth`. */
export interface BillingUsage {
  tier: Tier;
  /** True when the tier is granted by an operator comp rather than by Stripe. */
  comped?: boolean;
  usage: { parsesThisMonth: number; storedDiagrams: number; serverSynths: number };
  limits: TierLimits;
  resetAt: { month: string };
  costFreezeAt?: string;
  /** When a Free-cap freeze on a trialing org lifts: the trial's end, on the first payment (#2808). Absent for any other freeze, which checkout or an operator lifts. */
  freezeLiftsAt?: string;
  /** False once the org has completed a checkout, or while any org the caller owns is frozen: Stripe charges at once, no trial (#1802, #2734). */
  trialEligible: boolean;
  /** As on a quota refusal: a Free org whose subscription checkout would refuse, sent to the billing portal instead (#2839). */
  manageBilling?: true;
  /** Present while the org's subscription carries a Stripe trial end. */
  trialEndsAt?: string;
  /** Team tier only. `used` is members plus live invites. */
  seats?: SeatUsage;
  /** The caller's role in the acting org. Only an owner may open the billing portal. */
  role: OrgRole;
}

export interface InvoiceSummary {
  id: string;
  number: string | null;
  created: string;
  description: string | null;
  /** Minor units of `currency`, as Stripe reports them. */
  total: number;
  currency: string;
  status: string;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

/** `GET /billing/invoices`. */
export interface InvoiceList {
  invoices: InvoiceSummary[];
  /** Stripe holds older invoices than this page; the billing portal lists them. */
  hasMore: boolean;
}

/** The body of a quota refusal: a 429 whose `errorCode` is a `QuotaErrorCode`. */
export interface QuotaErrorBody {
  errorCode: QuotaErrorCode;
  /** Human-readable summary for clients that show the body as-is. */
  error: string;
  tier: Tier;
  limit: number;
  used: number;
  resetAt: string;
  /** Empty when `manageBilling` is set: checkout would refuse the org. */
  upgradeUrl: string;
  /** A Free org still holding a subscription Stripe may bill. Checkout refuses it, so its way back is the billing portal (#2839). */
  manageBilling?: true;
}

/** `GET /graphs/{id}/status`. A JOB# row answers with the whole row, so the
 * index signature carries the rest. */
export interface GraphStatusResult {
  graphId: string;
  status: JobStatus;
  error?: string;
  [key: string]: unknown;
}

/** One rendered thumbnail per theme, for the canvas loading overlay (#2392).
 * Presigned for 1 h on `GET /graphs/{id}`; thumbs-CDN URLs on
 * `GET /gallery/{id}` in prod. `renderedAt` is the epoch-ms stamp in the
 * thumbnail keys: older than `lastParsedAt` means the image predates the
 * current graph. `dark` is absent on rows rendered before the dark set. */
export interface ThumbnailPreview {
  renderedAt: number;
  light?: string;
  dark?: string;
  /** The scene extent these images frame, in the units of canvas-view's
   * `scene-extent`, for the canonical layout. Absent on renders older than
   * the field. */
  extent?: { width: number; height: number };
}

/** The CANON fields an invited outsider gets under `canonical`: an allowlist,
 * so storage keys, SHAs and facets stay member-only. */
export interface OutsiderCanonicalFields {
  graphId: string;
  branch: string;
  sourceVisibility: "public" | "private";
  isPublic: boolean;
  nodeCount: number;
  edgeCount: number;
  lastParsedAt: string;
  driftDetectedAt?: string;
}

/** A signed-in caller with no holding org, on a public CANON: the outsider
 * set plus the descriptive fields the gallery serves anonymously. */
export interface PublicCanonicalFields extends OutsiderCanonicalFields {
  displayOwner: string;
  displayRepo: string;
  subpath: string;
  projectType: string;
  /** Present only for a genuinely multi-engine (`projectType: "mixed"`) parse. */
  engines?: string[];
  provider: string;
  commitSha?: string;
}

/** A holding member: the whole CANON except its raw delta stamp and its
 * thumbnail keys. `getGraphWire.types.test.ts` holds these keys equal to the
 * backend's `Canonical` minus those three. */
export interface MemberCanonicalFields extends PublicCanonicalFields {
  repoKey: string;
  contentHash: string;
  latestVersionId: string;
  graphDataKey: string;
  observedVisibility: "public" | null;
  privatizedAt?: string;
  thumbnailKey: string | null;
  nodeTypes: string[];
  nodeNames: string[];
  createdAt: string;
  parseCount: number;
  driftSha?: string;
  sourceObservedAt?: string;
  deletedAt?: string;
  delistedAt?: string;
  description?: string;
  topics?: string[];
  primaryLanguage?: string;
  license?: string;
  starsCount?: number;
  homepage?: string;
  pushedAt?: string;
  ownerAvatarUrl?: string;
  readmeExcerpt?: string;
  synthInputs?: SynthInputs;
  synthInputsFromRepo?: SynthInputs;
}

/** The diagram-settings inputs. `repoKey` and `autoReparse` are null when no
 * org of the caller's holds the repo. */
export interface DiagramSettingsFields {
  repoKey: string | null;
  autoReparse: boolean | null;
  autoReparseSupported: boolean;
}

export interface CanonGraphReadBase extends DiagramSettingsFields {
  graphId: string;
  graphData?: Record<string, unknown>;
  /** How many nodes the display filter removes — reported whether or not the
   * caller asked for them, so the canvas chip keeps its count while revealed. */
  hiddenNodeCount: number;
  /** The stored layout JSON. Only the validated overrides PUT writes it, but
   * nothing checks it on the way out, so it is not typed as `DiagramOverrides`. */
  overrides: Record<string, unknown> | null;
  /** The version of the layout in `overrides`, which the next write names. */
  layoutVersion: number;
  /** "personal" when the team layout could not be seeded and `overrides` is
   * the caller's own row; `layoutVersion` is then 0, the absent team row's. */
  layoutSource: "team" | "personal";
  repoInfo: RepoInfo;
  /** Absent when no thumbnail has rendered yet. */
  thumbnailPreview?: ThumbnailPreview;
}

/** A CANON read by a member of an org that holds the repo. */
export interface MemberCanonGraphRead extends CanonGraphReadBase {
  access: "member";
  role: OrgRole;
  /** True when the holding org is a team (or someone else's workspace), so
   * the layout is shared; false in the caller's own personal workspace. */
  sharedLayout: boolean;
  canonical: MemberCanonicalFields;
  /** Infra delta for a PR-branch diagram, shaped for the holding org's tier.
   * Absent when the CANON carries none. */
  delta?: DeltaEnvelope;
}

/** A CANON read by an invited outsider: redacted graph, team layout read-only.
 * A gallery-listed CANON (`isPublic`) carries the public set, which the
 * gallery already serves anonymously; any other carries the outsider set. */
export interface ViewerCanonGraphRead extends CanonGraphReadBase {
  access: "viewer";
  role: null;
  sharedLayout: false;
  canonical: OutsiderCanonicalFields | PublicCanonicalFields;
}

/** A public CANON read by a caller who neither holds the repo nor was invited. */
export interface PublicCanonGraphRead extends CanonGraphReadBase {
  access: null;
  role: null;
  sharedLayout: false;
  canonical: PublicCanonicalFields;
}

/** `GET /graphs/{id}` resolved to a CANON by its own id. `access` tells the
 * three apart, and decides which allowlist `canonical` is. */
export type CanonGraphRead = MemberCanonGraphRead | ViewerCanonGraphRead | PublicCanonGraphRead;

export interface SeedGraphReadBase extends DiagramSettingsFields {
  /** The JOB# id the caller asked for, not the CANON's. */
  graphId: string;
  canonicalGraphId: string;
  /** The CANON's cached repoUrl, else the seed row's, else "". */
  repoUrl: string;
  graphData?: Record<string, unknown>;
  hiddenNodeCount?: number;
  repoInfo: RepoInfo;
  /** No layout here: the JOB# id's WS room is the caller's own and syncs none. */
  layoutVersion: 0;
  thumbnailPreview?: ThumbnailPreview;
}

/** A seed-follow read by a member of an org that holds the repo: the
 * {@link MemberCanonicalFields} at the top level. */
export interface MemberSeedGraphRead
  extends Omit<MemberCanonicalFields, "graphId" | "repoKey">,
    SeedGraphReadBase {
  access: "member";
  role: OrgRole;
}

/** A seed-follow read of a public CANON by a caller whose orgs no longer hold
 * it: the {@link PublicCanonicalFields} at the top level. */
export interface PublicSeedGraphRead
  extends Omit<PublicCanonicalFields, "graphId">,
    SeedGraphReadBase {
  access: null;
  role: null;
}

/**
 * `GET /graphs/{id}` for a JOB# id whose parse landed on a CANON: the CANON's
 * fields spread at the top level, under the JOB# id, chosen by the same
 * allowlists as {@link CanonGraphRead}'s `canonical`. The client redirects to
 * `canonicalGraphId`. Only the row's owner reaches it, and the gate admits no
 * viewer, so `access` is never "viewer".
 */
export type SeedGraphRead = MemberSeedGraphRead | PublicSeedGraphRead;

/**
 * `GET /graphs/{id}` for the caller's own JOB# row, passed through whole
 * (less `logKey`): an unfinished parse, or one whose CANON is gone. The row is
 * untyped in the store, so `satisfies` checks only `graphId`, `graphData` and
 * `hiddenNodeCount`; the rest documents what the writers put there.
 */
export interface JobGraphRead {
  PK?: string;
  SK?: string;
  graphId: string;
  /** DynamoDB TTL, epoch seconds. */
  ttl?: number;
  status?: JobStatus;
  error?: string;
  errorCode?: string;
  statusDetail?: string;
  repoUrl?: string;
  branch?: string;
  createdAt?: string;
  source?: Source;
  prNumber?: number;
  pathOverride?: string;
  synthInputs?: SynthInputs;
  /** Set once the parse lands; a JOB# row only answers with it when that
   * CANON can no longer be found. */
  canonicalGraphId?: string;
  nodeCount?: number;
  edgeCount?: number;
  projectType?: string;
  provider?: string;
  /** Legacy rows only: a parse from before CANON rows kept its graph here. */
  graphData?: Record<string, unknown>;
  hiddenNodeCount?: number;
}

/**
 * `GET /graphs/{id}`. The shapes share no discriminant on the wire, so tell
 * them apart with the guards in `@auto-arch-diagram/core/graphRead`.
 */
export type GraphRead = CanonGraphRead | SeedGraphRead | JobGraphRead;

/**
 * The top-level fields of any `GET /graphs/{id}` answer, for a reader that
 * takes each one as it comes rather than narrowing first: absent on the
 * shapes that do not send it. Every {@link GraphRead} member is assignable to
 * it, which `getGraphWire.types.test.ts` holds.
 */
export interface GraphReadView {
  graphId?: string;
  graphData?: Record<string, unknown>;
  hiddenNodeCount?: number;
  overrides?: Record<string, unknown> | null;
  layoutVersion?: number;
  layoutSource?: "team" | "personal";
  access?: "member" | "viewer" | null;
  role?: OrgRole | null;
  sharedLayout?: boolean;
  repoKey?: string | null;
  autoReparse?: boolean | null;
  autoReparseSupported?: boolean;
  repoInfo?: RepoInfo;
  thumbnailPreview?: ThumbnailPreview;
  delta?: DeltaEnvelope;
  canonicalGraphId?: string;
  status?: JobStatus;
  repoUrl?: string;
  createdAt?: string;
}

/**
 * The CANON fields of any `GET /graphs/{id}` answer, as
 * `canonicalFieldsOf` returns them: `canonical` on a CANON read, the top level
 * otherwise. Optional, and as wide as the widest shape that carries each one.
 */
export interface CanonicalFieldsView {
  graphId?: string;
  branch?: string;
  repoKey?: string | null;
  sourceVisibility?: "public" | "private";
  isPublic?: boolean | "true";
  nodeCount?: number;
  edgeCount?: number;
  createdAt?: string;
  lastParsedAt?: string;
  driftDetectedAt?: string;
  displayOwner?: string;
  displayRepo?: string;
  subpath?: string;
  projectType?: string;
  engines?: unknown;
  provider?: string;
  commitSha?: string;
  status?: JobStatus;
  repoUrl?: string;
  synthInputs?: SynthInputs;
  synthInputsFromRepo?: SynthInputs;
}

/** `GET /gallery/{id}`, and the base of `GET /s/{token}`. `GET /graphs/{id}`
 * is {@link GraphRead}. */
export interface GraphResult {
  graphId: string;
  status?: JobStatus;
  error?: string;
  graphData?: Record<string, unknown>;
  repoInfo?: RepoInfo;
  /** How many nodes the display filter removes — reported whether or not the
   * caller asked for them, so the canvas chip keeps its count while revealed. */
  hiddenNodeCount?: number;
  /** Infra delta for a PR-branch diagram, shaped for the caller's tier.
   * Absent when the CANON carries none or the caller has no library pointer. */
  delta?: DeltaEnvelope;
  /** The caller's role in the org holding the repo; null when no org of
   * theirs holds it. Absent on an in-progress parse's own row. */
  role?: OrgRole | null;
  /** "viewer" for an invited outsider (redacted graph, team layout read-only);
   * null when the caller neither holds the repo nor was invited. */
  access?: "member" | "viewer" | null;
  /** True when the holding org is a team (or someone else's workspace), so
   * the layout is shared; false in the caller's own personal workspace. */
  sharedLayout?: boolean;
  /** The version of the layout in `overrides`, which the next write names. */
  layoutVersion?: number;
  /** "personal" when the team layout could not be seeded and `overrides` is
   * the caller's own row; `layoutVersion` is then 0, the absent team row's. */
  layoutSource?: "team" | "personal";
  /** Absent when no thumbnail has rendered yet. */
  thumbnailPreview?: ThumbnailPreview;
  [key: string]: unknown;
}

export interface SharingViewer {
  userId: string;
  email: string;
  addedAt: string;
}

export interface SharingInvite {
  inviteId: string;
  email: string;
  invitedAt: string;
  expiresAt: string;
}

export interface SharingRequest {
  userId: string;
  email: string;
  name: string;
  requestedAt: string;
}

/** `GET /graphs/{id}/sharing`. */
export interface SharingState {
  link: { enabled: boolean; url: string | null };
  team: { name: string; memberCount: number; tier: string };
  viewers: SharingViewer[];
  invites: SharingInvite[];
  requests: SharingRequest[];
}

/** `POST /share-invites/accept`: `alreadyMember` when the caller turned out to
 *  be a teammate, whose own canvas then opens instead. */
export interface ShareInviteAcceptance {
  graphId: string;
  alreadyMember?: boolean;
}

/** `POST …/request-access`: `recent` when this caller already asked within the day. */
export interface AccessRequestResult {
  status: "sent" | "recent";
}

/** A card in `GET /graphs?view=shared`: a diagram another org invited the
 *  caller to view. `sharedBy` is that org's name. */
export interface SharedItem {
  graphId: string;
  displayOwner: string;
  displayRepo: string;
  branch: string;
  projectType?: string;
  nodeCount: number;
  edgeCount: number;
  lastParsedAt: string;
  sharedBy: string;
  thumbnailUrl?: string;
  thumbnailUrls?: Record<string, string>;
}

/** `truncated`: some grants were not read or not confirmed, so the list is
 *  not the whole set. The server sends it only when true. */
export interface SharedList {
  items: SharedItem[];
  truncated?: boolean;
}

/** `url` is null when the link exists but its token can't be shown: a
 *  hash-only link, or one whose envelope can't be opened. */
export interface ShareLinkResult {
  link: { enabled: true; url: string | null };
  /** Enable only: true when this call created the link, false when it already existed. */
  created?: boolean;
}

/** A row of `GET /graphs`: a LIBRARY# card, a JOB# parse-progress row or a
 *  gallery item. */
export interface GraphSummary {
  graphId: string;
  repoUrl: string;
  branch: string;
  subpath?: string;
  /** JOB# rows only: the subdirectory the run parsed. */
  pathOverride?: string;
  /** JOB# rows only: the run's CDK synth settings (#2008). */
  synthInputs?: SynthInputs;
  projectType: string;
  /** LIBRARY# pointer field: an authored diagram's title. */
  displayRepo?: string;
  /** Write-time facet: present only for a genuinely multi-engine
   *  (`projectType: "mixed"`) result — the engines that actually parsed. */
  engines?: string[];
  provider: string;
  status: string;
  createdAt: string;
  /** CANON's last successful parse, overlaid onto the library pointer. Absent
   *  on rows that never resolved a CANON (orphan pointers, in-flight jobs). */
  lastParsedAt?: string;
  thumbnailKey?: string;
  thumbnailUrl?: string;
  thumbnailKeys?: Record<string, string>;
  thumbnailUrls?: Record<string, string>;
  isPublic?: boolean;
  nodeCount?: number;
  edgeCount?: number;
  description?: string;
  readmeExcerpt?: string;
  ownerAvatarUrl?: string;
  starsCount?: number;
  sourceVisibility?: "public" | "private";
  source?: Source;
  phase?: "clone" | "detect" | "build" | "parse" | "layout" | "finalize";
  pct?: number;
  currentMsg?: string;
  error?: string;
  errorCode?: string;
  statusDetail?: string;
  prNumber?: number;
  commitSha?: string;
  reparsesRemaining?: number;
  refreshBlocked?: string;
  /** LIBRARY# pointer fields, present only on library rows (never on JOB#
   *  parse-progress rows or gallery items). `repoKey` is the settings PUT's
   *  body field; the two `autoReparse*` fields mirror `GET /graphs/{id}`. */
  repoKey?: string;
  autoReparse?: boolean;
  autoReparseSupported?: boolean;
  /** The member who added the repo to the org library. Absent on rows
   *  predating the field. */
  addedBy?: string;
  /** JOB# rows only: the repoKey this parse will land on, derived server-side
   *  from the row's repoUrl/branch/pathOverride. Lets the library fold an
   *  in-flight re-parse into the card it refreshes. Absent for local uploads. */
  targetRepoKey?: string;
  /** Library view only: the in-flight re-parse the API folded into this card
   *  (its JOB# row is not listed separately). */
  inFlightJobId?: string;
  overrides?: DiagramOverrides | null;
  /** The pointer resolved no CANON (admin takedown, in-flight migration). The
   *  row is stamped `status: "completed"` so the card can render, but there is
   *  no diagram behind it — every per-diagram action would 404. */
  orphan?: boolean;
  /** A "Shared with me" card: the sharing org's name, "" when it is unknown. */
  sharedBy?: string;
}

/** `GET /graphs`: one cursor page. */
export interface ListResult {
  items: GraphSummary[];
  cursor?: string;
}

/** One window of `GET /graphs?view=library`. `failed` rides the first window
 *  only; `summary` covers the whole library. */
export interface LibraryPage {
  items: GraphSummary[];
  failed?: GraphSummary[];
  summary?: LibrarySummary;
  /** The caller's role in the acting org. */
  role?: OrgRole;
}

/** A hit of `GET /search/{scope}`. The server sends every `SearchDocument`
 *  field; these are the ones the SPA reads. */
export interface SearchHit {
  graphId: string;
  repoName: string;
  ownerLogin: string;
  branch: string;
  projectType: string;
  engines?: string[];
  provider: string;
  status: string;
  thumbnailKey?: string;
  /** Signed by the search handler from `thumbnailKey` on the way out; absent
   *  when the CANON has no thumbnail yet. */
  thumbnailUrl?: string;
  /** The dark-palette PNG; only sent beside `thumbnailUrl`. */
  thumbnailUrlDark?: string;
  /** Every variant by name, as on a `/gallery` item. Gallery scope only, and
   *  only where a thumbnail CDN is configured. */
  thumbnailUrls?: Record<string, string>;
  nodeCount?: number;
  starsCount?: number;
  ownerAvatarUrl?: string;
  description?: string;
  createdAt: string;
  lastParsedAt?: string;
  score: number;
}

export interface FacetBucket {
  value: string;
  count: number;
}

/** `GET /search/{scope}`. */
export interface SearchResponse {
  hits: SearchHit[];
  facets: {
    projectType: FacetBucket[];
    provider: FacetBucket[];
    status: FacetBucket[];
    topics: FacetBucket[];
    primaryLanguage: FacetBucket[];
  };
  total: number;
  nextPage: number | null;
}

/** The SPA's search call, sent as `GET /search/{scope}` query parameters. */
export interface SearchRequest {
  scope: "library" | "gallery";
  q: string;
  projectType?: string;
  source?: "authored" | "parsed";
  provider?: string;
  status?: string;
  topics?: string[];
  primaryLanguage?: string[];
  sort?: "relevance" | "recent" | "recent-parsed";
  page: number;
  pageSize: number;
}

/**
 * The header the SPA sends on every authed request to name the org it booted
 * with, so a moved server-side pointer cannot re-target an open tab (#2703).
 * Types only: a value here would pull this module into the Base Lambdas' closure.
 */
export type ActingOrgHeader = "x-arcsync-org";

/**
 * `errorCode` of the 404 for a request whose header names an org the caller is
 * not in. "No such org" and "not your org" answer alike, so it confirms nothing;
 * the SPA reloads into a workspace the caller still has.
 */
export type ActingOrgRefused = "ACTING_ORG_REFUSED";
