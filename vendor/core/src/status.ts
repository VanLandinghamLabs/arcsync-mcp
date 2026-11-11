export const ALL_STATUS_DETAILS = [
  "cloning",
  "detecting",
  "parsing",
  "generating",
  "private_repo_not_installed",
  "github_token_mint_failed",
  "private_repo_not_selected",
  "pat_or_install_required",
  "pat_expired",
  "unsupported_private_host",
] as const;

export type StatusDetail = (typeof ALL_STATUS_DETAILS)[number];

export const ALL_ERROR_CODES = [
  "REPO_NOT_FOUND",
  "CLONE_TIMEOUT",
  /** git failed for a reason that is not "this repo needs credentials" —
   * network, TLS, a 5xx from the host, or a branch that does not exist. */
  "CLONE_FAILED",
  /** The requested branch does not exist in the repository. */
  "BRANCH_NOT_FOUND",
  /** The builder ran out of its own disk materializing the repository — the
   * sandbox Lambda's 10 GiB `/tmp`, shared by the working tree, every
   * toolchain cache and `cdk.out`. OUR capacity, not the user's repository, so
   * it is triageable: as CLONE_FAILED it would be silent, and a builder that
   * has started failing on large repos is exactly what has to be heard. */
  "CHECKOUT_DISK_FULL",
  "NO_IAC_FILES",
  "NPM_INSTALL_FAILED",
  "PY_INSTALL_FAILED",
  "JAVA_INSTALL_FAILED",
  "GO_INSTALL_FAILED",
  "DOTNET_INSTALL_FAILED",
  "CDK_SYNTH_FAILED",
  "CDK_SYNTH_OOM",
  /** `pulumi preview` rejected the user's program — a syntax error, a runtime
   * throw, a missing dependency. The Pulumi analogue of CDK_SYNTH_FAILED, and
   * ignored for the same reason: only the program's author can fix it. */
  "PULUMI_PREVIEW_FAILED",
  "PULUMI_PREVIEW_OOM",
  "CREDENTIALS_REQUIRED",
  "CDK_DOCKER_REQUIRED",
  "CDK_NO_TEMPLATES",
  /** `cdk synth` succeeded but its templates total more than the sandbox will
   * stage and the parser will read. A refusal of the project's own output. */
  "CDK_TEMPLATES_TOO_LARGE",
  "UNKNOWN_CDK_LANGUAGE",
  /** A Pulumi project whose language we could not name: `Pulumi.yaml` declares
   * a `runtime` we have no builder for (`hcl`), or declares none at all and
   * carries no manifest. Deliberately NOT the CDK code — routing a Pulumi
   * project through `UNKNOWN_CDK_LANGUAGE` filed it against us as "a CDK
   * project we mis-parsed" when nothing about it was CDK (#1410). */
  "UNKNOWN_PULUMI_LANGUAGE",
  "BUILDER_INVOKE_FAILED",
  /** The sandbox NAT, started on demand (#1160), never forwarded within the
   * router's wait. Nothing about the user's project was touched; a retry after
   * the instance is up succeeds. */
  "BUILD_ENV_UNAVAILABLE",
  /** The router or a builder reached the parser hand-off with less time left
   * than the parser may take, so it refused rather than time out under a live
   * parse (#1968). Nothing about the project was wrong. */
  "BUILD_TIME_EXHAUSTED",
  /** The user's IaC document is unusable — malformed YAML, or one of our
   * deliberate refusals (size cap, anchor-expansion bomb, cyclic anchor).
   * Distinct from PARSE_ERROR precisely so auto-triage does not file an issue
   * against us for a typo in someone else's repository. */
  "IAC_SYNTAX_ERROR",
  "PARSE_ERROR",
  "INTERNAL_ERROR",
  "PRIVATE_REPO_NOT_INSTALLED",
  "GITHUB_TOKEN_MINT_FAILED",
  "PRIVATE_REPO_NOT_SELECTED",
  "PAT_INVALID",
  "PAT_EXPIRED",
  /** GitHub answered 403 to a clone with the user's PAT: the token is valid
   * but cannot read this repository (SAML SSO not authorized, or a
   * fine-grained token without this repo). */
  "PAT_ACCESS_DENIED",
  "PAT_RATE_LIMITED",
  "EXPECTED_CDK_GOT_OTHER",
  "CDK_OUTPUT_HANDOFF_FAILED",
  "UNSUPPORTED_PRIVATE_HOST",
  /** The subpath on the event failed the router's git-argv gate (leading `-`,
   * absolute, `..`, control characters). The API already 400s these; this is
   * the code for a stored or forwarded subpath that reaches the router. */
  "INVALID_PATH_OVERRIDE",
  /** The account has spent its monthly server-side synth budget. Refused by the
   * sandbox router before any builder Lambda is invoked. */
  "SYNTH_QUOTA_EXCEEDED",
  /** The org's plan does not include server synths. Same refusal point as
   * SYNTH_QUOTA_EXCEEDED, but the parse charge is returned. */
  "SYNTH_PLAN_REQUIRED",
  /** The account is frozen on its cost cap. Same refusal point as
   * SYNTH_QUOTA_EXCEEDED, but it does not clear at month rollover. */
  "COST_FREEZE",
  /** The fleet-wide spend breaker (#1146) has tripped, so the API failed the
   * job before dispatching it to the sandbox (#1731). Nothing was attempted. */
  "BUILDS_PAUSED",
  /** The worker died past its own catch (timeout, OOM, init crash) and the
   * async-invoke DLQ failed the job for it (#1774). */
  "WORKER_CRASHED",
  /** Lambda throttled the async event past `maxEventAge` and dropped it
   * unrun. Capacity, not a defect in anything that ran. */
  "JOB_EXPIRED",
  /** Lambda answered a builder invoke with `TooManyRequestsException`, which
   * includes the per-function ceiling on tenant environments (#2807). Nothing
   * ran. Distinct from BUILDER_INVOKE_FAILED so it reads as capacity, not a bug. */
  "BUILDER_CAPACITY_EXCEEDED",
  /** The org already holds its tier's stored-diagram allowance, so the parser
   * refused to add a new library entry. The API admits against the same cap,
   * but imports in flight together all pass that count. */
  "DIAGRAM_LIMIT",
  /** An erasure was deleting this diagram when the parse tried to write it. */
  "DIAGRAM_ERASING",
] as const;

export type ErrorCode = (typeof ALL_ERROR_CODES)[number];

/** What a repo-lane run reports when detection finds no engine. The text is
 * stored on the JOB row, so the task page re-derives it from the code: a row
 * written before a rewording would otherwise keep the retired sentence. */
export const NO_IAC_FILES_MESSAGE = "No Infrastructure as Code Files Found";

/** Failures caused by the user's repository, credentials, or environment. Expected
 * in normal operation and deliberately silent — they must never open an issue. */
export const KNOWN_AND_IGNORED_PARSE_FAILURES = [
  "REPO_NOT_FOUND",
  "CLONE_TIMEOUT",
  "CLONE_FAILED",
  "BRANCH_NOT_FOUND",
  "NO_IAC_FILES",
  "NPM_INSTALL_FAILED",
  "PY_INSTALL_FAILED",
  "JAVA_INSTALL_FAILED",
  "GO_INSTALL_FAILED",
  "DOTNET_INSTALL_FAILED",
  "CDK_SYNTH_FAILED",
  "CDK_NO_TEMPLATES",
  "CDK_TEMPLATES_TOO_LARGE",
  "EXPECTED_CDK_GOT_OTHER",
  "CDK_SYNTH_OOM",
  "PULUMI_PREVIEW_FAILED",
  "PULUMI_PREVIEW_OOM",
  "CREDENTIALS_REQUIRED",
  "CDK_DOCKER_REQUIRED",
  "PRIVATE_REPO_NOT_INSTALLED",
  "PRIVATE_REPO_NOT_SELECTED",
  "PAT_INVALID",
  "PAT_EXPIRED",
  "PAT_ACCESS_DENIED",
  "PAT_RATE_LIMITED",
  "UNSUPPORTED_PRIVATE_HOST",
  // "We cannot tell what this project is written in" is a statement about the
  // project, not a defect: a Pulumi HCL program, or one whose Pulumi.yaml
  // omits the `runtime` key Pulumi itself requires.
  "UNKNOWN_PULUMI_LANGUAGE",
  // The caller's subpath, not our code: the refusal is the gate working.
  "INVALID_PATH_OVERRIDE",
  // The document is the problem, and only its author can fix it. Triaging these
  // would file one issue against ArcSync per malformed template on the internet.
  "IAC_SYNTAX_ERROR",
  // Deliberate refusals against the account's own budget, not defects. Triaging
  // them would open an issue every time metering worked as designed.
  "SYNTH_QUOTA_EXCEEDED",
  "SYNTH_PLAN_REQUIRED",
  "COST_FREEZE",
  "DIAGRAM_LIMIT",
  // An erasure deleting the diagram the parse targets: a race, not a defect.
  "DIAGRAM_ERASING",
  // The spend breaker paging the operator is the signal; one issue per job
  // refused while it is tripped would only bury it.
  "BUILDS_PAUSED",
  // Throttling, not code: nothing ran. Kept off INTERNAL_ERROR so it neither
  // files as a defect nor shares a fingerprint with one.
  "JOB_EXPIRED",
  // Capacity, not code: nothing ran, and the user retries.
  "BUILDER_CAPACITY_EXCEEDED",
] as const satisfies readonly ErrorCode[];

/** Failures that indicate an ArcSync defect. `GITHUB_TOKEN_MINT_FAILED` sits here
 * despite also firing on user-revoked installations: a misclassified outage stays
 * silent forever, whereas a misclassified user action costs one deduplicated issue. */
export const TRIAGEABLE_PARSE_FAILURES = [
  "PARSE_ERROR",
  "INTERNAL_ERROR",
  "CDK_OUTPUT_HANDOFF_FAILED",
  "BUILDER_INVOKE_FAILED",
  // Ours: the NAT failed to come up, or came up too slowly for the wait.
  "BUILD_ENV_UNAVAILABLE",
  // Ours: the time budgets ahead of the parser left it no room.
  "BUILD_TIME_EXHAUSTED",
  "UNKNOWN_CDK_LANGUAGE",
  "GITHUB_TOKEN_MINT_FAILED",
  "CHECKOUT_DISK_FULL",
  "WORKER_CRASHED",
] as const satisfies readonly ErrorCode[];

export type KnownAndIgnoredParseFailure = (typeof KNOWN_AND_IGNORED_PARSE_FAILURES)[number];
export type TriageableParseFailure = (typeof TRIAGEABLE_PARSE_FAILURES)[number];

type AllCodesClassified =
  Exclude<ErrorCode, KnownAndIgnoredParseFailure | TriageableParseFailure> extends never
    ? true
    : never;
type HalvesAreDisjoint =
  Extract<KnownAndIgnoredParseFailure, TriageableParseFailure> extends never ? true : never;

/** Compile-time half of the partition proof: adding a member to `ALL_ERROR_CODES`
 * without classifying it resolves these to `never` and fails `tsc --noEmit`.
 * Exported so Biome does not flag them unused — reading them is not the point. */
export const PARSE_FAILURE_PARTITION_IS_TOTAL: AllCodesClassified = true;
export const PARSE_FAILURE_PARTITION_IS_DISJOINT: HalvesAreDisjoint = true;

const IGNORED_CODES: ReadonlySet<string> = new Set(KNOWN_AND_IGNORED_PARSE_FAILURES);

/** Unrecognised codes are triageable on purpose — reachable during a rolling
 * deploy where an older Lambda emits a code a newer consumer has not seen, and a
 * code we do not recognise is by definition not one we chose to ignore. */
export function isTriageableParseFailure(code: string): boolean {
  return !IGNORED_CODES.has(code);
}

/**
 * Refusals where the platform declined to run, so the repository is not at
 * fault — the account's own budget (DIAGRAM_LIMIT even parsed fine), or
 * capacity (BUILDER_CAPACITY_EXCEEDED never started a build). They must be
 * excluded wherever a failure is counted against the user.
 *
 * Load-bearing for the #231 consecutive-failure cap: three of these in a month
 * would otherwise block the repo for 24h with `REPARSE_LIMIT`, punishing a
 * metered user a second time, and that block survives both a month rollover
 * and an upgrade to Pro. BUILDER_CAPACITY_EXCEEDED belongs here for a second
 * reason: its message tells the user to retry, and the retry must not be the
 * thing that trips the block.
 */
export const QUOTA_REFUSAL_FAILURES = [
  "SYNTH_QUOTA_EXCEEDED",
  "SYNTH_PLAN_REQUIRED",
  "COST_FREEZE",
  "DIAGRAM_LIMIT",
  "BUILDER_CAPACITY_EXCEEDED",
  // Its message tells the user to retry once an erasure finishes (#2797).
  "DIAGRAM_ERASING",
] as const satisfies readonly ErrorCode[];

const QUOTA_REFUSAL_CODES: ReadonlySet<string> = new Set(QUOTA_REFUSAL_FAILURES);

export function isQuotaRefusal(code: string | undefined): boolean {
  return code !== undefined && QUOTA_REFUSAL_CODES.has(code);
}

/**
 * Why an automatic drift-refresh was skipped, as stamped on a LIBRARY# pointer's
 * `refreshBlocked` by the GitHub webhook. Every one of these has to be explained
 * in the SPA, so the union lives here rather than in the backend: the Library's
 * copy map is typed `Record<RefreshBlockedCode, string>`, which turns a newly
 * stamped code into a build failure instead of an empty tooltip (#1069).
 *
 * The backend half of that contract is
 * `MarkLibraryEntryRefreshBlockedArgs.errorCode` (`lib/libraryStore.ts`),
 * typed to this union — so a refusal code cannot be stamped before it is listed
 * here, and cannot be listed here without copy.
 */
export const REFRESH_BLOCKED_CODES = [
  /** Auto-refresh on merge is Pro-only; free installs run the GitHub Action. */
  "AUTO_REFRESH_PRO_ONLY",
  /** The pointer's owner is a Viewer in the org that would be charged; auto-refresh spends the org's pooled parse quota, which needs Editor. */
  "AUTO_REFRESH_ROLE_REQUIRED",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "COST_FREEZE",
  /** The fleet-wide spend breaker has paused builds (#1731). */
  "BUILDS_PAUSED",
  /** A synth variant's own settings could not be read off its canonical (#2020). */
  "SYNTH_SETTINGS_UNAVAILABLE",
] as const;

export type RefreshBlockedCode = (typeof REFRESH_BLOCKED_CODES)[number];

export type Phase = "clone" | "detect" | "build" | "parse" | "layout" | "finalize";
export const ALL_SOURCES = ["manual", "github-action", "cli", "reparse", "upload"] as const;

export type Source = (typeof ALL_SOURCES)[number];
export type LogLevel = "info" | "ok" | "warn" | "error";

export interface LogLine {
  ts: string;
  level: LogLevel;
  msg: string;
  truncated?: boolean;
}

/** A JOB# row's lifecycle state, and the `status` of every frame about it. */
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface GraphStatusMessage {
  graphId: string;
  status: JobStatus;
  statusDetail?: StatusDetail;
  error?: string;
  errorCode?: ErrorCode;
  phase?: Phase;
  pct?: number;
  currentMsg?: string;
  logLine?: LogLine;
  source?: Source;
  commitSha?: string;
  cancelRequested?: boolean;
  /** On a `completed` frame: the CANON id the diagram lives under, which is
   * never the JOB# id the frame is addressed to. */
  canonicalGraphId?: string;
}
