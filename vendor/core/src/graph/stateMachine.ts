import { flattenDefinition, flattenEmbeddedRefs, REF_MARKER } from "./aslFlatten.js";
import { containsReferenceToken } from "./routeTable.js";
import type { ArchGraph, AslTransitionKind, ResourceNode } from "./types.js";
import { ResourceType } from "./types.js";

export type { AslTransitionKind };

/** Nesting levels of Map/Parallel materialised before deeper levels collapse
 * into a single labelled box. Three covers a Map whose iterator contains a
 * Parallel, the deepest shape seen in practice. */
export const ASL_DEPTH_CAP = 3;

export type AslStateType =
  | "Task"
  | "Choice"
  | "Wait"
  | "Pass"
  | "Succeed"
  | "Fail"
  | "Map"
  | "Parallel";

const ASL_STATE_TYPES = new Set<string>([
  "Task",
  "Choice",
  "Wait",
  "Pass",
  "Succeed",
  "Fail",
  "Map",
  "Parallel",
]);

/** One successor edge. Kept as a record rather than a bare target string plus a
 * parallel `catchTargets` array, so a target reached by two different routes (a
 * Choice rule *and* a Catch handler, say) carries both facts instead of one
 * winning. */
export interface AslTransition {
  /** ASL key of the successor state. */
  target: string;
  kind: AslTransitionKind;
  /** Compact condition text for a Choice rule, e.g. `status == SUCCEEDED`.
   * Absent for a composite (`And`/`Or`/`Not`) this does not try to summarise —
   * an unlabelled edge is honest, an approximated one is not. */
  label?: string;
}

/** First entry of a state's `Retry` block. ASL allows several, keyed by error
 * name; the first is what a reader wants at a glance and the rest are in the
 * raw attributes. */
export interface AslRetry {
  /** `MaxAttempts`, defaulted to ASL's own 3 when omitted. */
  attempts: number;
  /** `IntervalSeconds`, defaulted to ASL's own 1 when omitted. */
  intervalSeconds: number;
  /** `BackoffRate`, defaulted to ASL's own 2 when omitted. */
  backoffRate: number;
}

/** An edge to the machine's End rather than to a state. */
export interface AslEndTransition {
  kind: AslTransitionKind;
  label?: string;
}

export interface AslState {
  /** ASL state name, e.g. "Job Complete?". Arbitrary user text. */
  key: string;
  /** ArcSync-only `ArcSyncLabel`: the display name an authored diagram gave the state. */
  label?: string;
  /** The state's `Comment`. */
  comment?: string;
  type: AslStateType;
  /** Successors in declaration order: Next, then Choices[], Default, Catch[]. */
  transitions: AslTransition[];
  /** End: true, or a Succeed / Fail state. */
  terminal: boolean;
  /** ArcSync-only labelled routes to End (`ArcSyncEnd` rules, `ArcSyncDefaultEnd`,
   * or `ArcSyncNextLabel` beside `End: true`). IaC ASL never carries these. */
  endTransitions?: AslEndTransition[];
  /** The state's `Retry` policy, when it has one — drawn as an annotation,
   * never as a self-loop edge, or every retryable Task in every real workflow
   * grows one. */
  retry?: AslRetry;
  /** Graph node id this Task invokes, when resolvable. */
  targetNodeId?: string;
  /** The Step Functions service-integration verb from a Task's `Resource`
   * (`invoke`, `invoke.sync`, `invoke.waitForTaskToken`, `sendMessage`, …).
   * Only set for an `arn:…:states:::` optimised integration — a bare function
   * ARN's last segment is the function name, not a verb. */
  integration?: string;
  /** A Wait's literal `Seconds`. */
  waitSeconds?: number;
  /** A Wait's reference form — `SecondsPath`, `TimestampPath`, or a literal
   * `Timestamp` — when it has no literal `Seconds`. */
  waitRef?: string;
  /** The reference a Choice branches on (its first rule's `Variable`), for the
   * state's own label. Per-branch conditions ride on the transitions. */
  choiceVariable?: string;
  /** A Fail state's `Error`. */
  errorName?: string;
  /** Map ItemProcessor / Iterator, or one entry per Parallel branch. */
  children?: StateMachineGraph[];
}

export interface StateMachineGraph {
  startAt: string;
  states: Map<string, AslState>;
}

type Resolver = (ref: string) => string | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A Task's target lives under `Parameters` (JSONPath) or `Arguments`
 * (JSONata). Checking only one loses every Task link in JSONata machines.
 * Also called for `Map` (see its caller in `parseAsl`): `ItemReader` is a Map
 * field, never a Task one, so this must run for both kinds or a Distributed
 * Map's S3 source never resolves.
 *
 * The dynamic `.$` spellings (`"FunctionName.$": "$.fnArn"`) are deliberately
 * NOT read: by ASL's own rules that value is a JSONPath into runtime execution
 * state, never a name or an ARN, so resolving it against graph node ids could
 * only ever succeed by accident. */
function targetOf(state: Record<string, unknown>, resolve: Resolver): string | undefined {
  for (const key of ["Parameters", "Arguments"]) {
    const bag = asRecord(state[key]);
    const fn = bag?.FunctionName ?? bag?.StateMachineArn ?? bag?.TableName;
    if (typeof fn === "string") {
      const hit = resolve(fn);
      if (hit) return hit;
    }
  }
  const reader = asRecord(state.ItemReader);
  const bucket = asRecord(reader?.Parameters)?.Bucket;
  if (typeof bucket === "string") return resolve(bucket);
  return undefined;
}

/** Marks an optimised service integration ARN, whose final segment is the verb
 * (`arn:aws:states:::lambda:invoke.sync`). A bare resource ARN
 * (`arn:aws:lambda:us-east-1:1:function:Foo`) has no such marker and its final
 * segment is a resource name, which is why this is a prefix test and not a
 * `lastIndexOf(":")`. */
const OPTIMISED_INTEGRATION = ":states:::";

function integrationOf(state: Record<string, unknown>): string | undefined {
  const resource = state.Resource;
  if (typeof resource !== "string") return undefined;
  const at = resource.indexOf(OPTIMISED_INTEGRATION);
  if (at === -1) return undefined;
  const verb = resource.slice(at + OPTIMISED_INTEGRATION.length);
  // `lambda:invoke` → `invoke`; `aws-sdk:s3:getObject` → `getObject`.
  const last = verb.slice(verb.lastIndexOf(":") + 1);
  return last === "" ? undefined : last;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** ASL's own documented defaults for an omitted Retry field. */
function retryOf(state: Record<string, unknown>): AslRetry | undefined {
  if (!Array.isArray(state.Retry) || state.Retry.length === 0) return undefined;
  const first = asRecord(state.Retry[0]) ?? {};
  const attempts = numberOr(first.MaxAttempts, 3);
  // `MaxAttempts: 0` is valid ASL and means "do not retry" — it is how a
  // catch-only handler is written. Reporting a policy for it would draw
  // "retry 0x" on the card and answer "does this retry?" with yes.
  if (attempts <= 0) return undefined;
  return {
    attempts,
    intervalSeconds: numberOr(first.IntervalSeconds, 1),
    backoffRate: numberOr(first.BackoffRate, 2),
  };
}

/** Longest-suffix-first: `GreaterThanEquals` must be tested before
 * `GreaterThan`, or `NumericGreaterThanEquals` reads as `>`. */
const COMPARATORS: ReadonlyArray<readonly [string, string]> = [
  ["GreaterThanEquals", ">="],
  ["LessThanEquals", "<="],
  ["GreaterThan", ">"],
  ["LessThan", "<"],
  ["Equals", "=="],
  ["Matches", "matches"],
];

/** A compact, readable rendering of one Choice rule.
 *
 * Returns `undefined` for a composite (`And` / `Or` / `Not`) rather than
 * inventing a summary: the whole point of the label is that a reader can trust
 * it, and "the first of three ANDed conditions" is a wrong label, not a short
 * one. JSONata's `Condition` is a boolean expression already written for a
 * human, so it passes through as-is.
 */
function choiceLabelOf(rule: Record<string, unknown>): string | undefined {
  if (typeof rule.Condition === "string") return rule.Condition;
  const variable = rule.Variable;
  if (typeof variable !== "string") return undefined;

  for (const key of Object.keys(rule)) {
    if (key === "Variable" || key === "Next" || key === "Comment") continue;
    // A `…Path` operator compares against another reference rather than a
    // literal; the symbol is the same either way. The OPERAND deliberately
    // keeps its `$.` while the variable loses one: `x >= $.y` says the right
    // side is a reference, where `x >= y` would read as a literal — the same
    // "a wrong label, not a short one" argument this function makes about
    // composites below.
    const op = key.endsWith("Path") ? key.slice(0, -"Path".length) : key;
    if (op.startsWith("Is")) {
      // IsPresent / IsNull / IsNumeric / … are unary predicates whose operand
      // is a boolean saying whether to assert or negate them.
      return rule[key] === false ? `not ${bareRef(variable)} ${op}` : `${bareRef(variable)} ${op}`;
    }
    const symbol = COMPARATORS.find(([suffix]) => op.endsWith(suffix))?.[1];
    if (!symbol) continue;
    const operand = rule[key];
    if (typeof operand === "object" && operand !== null) continue;
    return `${bareRef(variable)} ${symbol} ${String(operand)}`;
  }
  return undefined;
}

/** `$.status` → `status`. The state's own label carries the full reference; an
 * edge label repeating the `$.` on every branch is noise. */
function bareRef(reference: string): string {
  return reference.startsWith("$.") ? reference.slice(2) : reference;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function endTransitionsOf(state: Record<string, unknown>): AslEndTransition[] {
  const ends: AslEndTransition[] = [];
  const nextLabel = nonEmpty(state.ArcSyncNextLabel);
  if (state.End === true && nextLabel) ends.push({ kind: "next", label: nextLabel });
  if (Array.isArray(state.Choices)) {
    for (const choice of state.Choices) {
      const rule = asRecord(choice);
      if (rule?.ArcSyncEnd !== true || rule.Next !== undefined) continue;
      const label = nonEmpty(rule.Condition);
      ends.push({ kind: "choice", ...(label ? { label } : {}) });
    }
  }
  if (state.ArcSyncDefaultEnd === true) ends.push({ kind: "default", label: "default" });
  return ends;
}

function transitionsOf(state: Record<string, unknown>): AslTransition[] {
  const transitions: AslTransition[] = [];
  if (typeof state.Next === "string") {
    const label = nonEmpty(state.ArcSyncNextLabel);
    transitions.push({ target: state.Next, kind: "next", ...(label ? { label } : {}) });
  }
  if (Array.isArray(state.Choices)) {
    for (const choice of state.Choices) {
      const rule = asRecord(choice);
      const target = rule?.Next;
      if (typeof target !== "string") continue;
      const label = choiceLabelOf(rule as Record<string, unknown>);
      transitions.push({ target, kind: "choice", ...(label ? { label } : {}) });
    }
  }
  if (typeof state.Default === "string")
    transitions.push({ target: state.Default, kind: "default", label: "default" });
  if (Array.isArray(state.Catch)) {
    for (const handler of state.Catch) {
      const target = asRecord(handler)?.Next;
      if (typeof target === "string") transitions.push({ target, kind: "catch", label: "catch" });
    }
  }
  return transitions;
}

/** A Wait's duration, as either a literal second count or the reference it
 * reads one from. ASL permits exactly one of these four fields; the literal is
 * preferred because it is the only one that says how long the wait actually
 * is. */
function waitOf(state: Record<string, unknown>): Pick<AslState, "waitSeconds" | "waitRef"> {
  if (typeof state.Seconds === "number" && Number.isFinite(state.Seconds))
    return { waitSeconds: state.Seconds };
  for (const key of ["SecondsPath", "TimestampPath", "Timestamp"]) {
    if (typeof state[key] === "string") return { waitRef: state[key] as string };
  }
  return {};
}

function childrenOf(
  state: Record<string, unknown>,
  type: AslStateType,
  resolve: Resolver,
  depth: number,
): StateMachineGraph[] | undefined {
  if (type === "Map") {
    // `Iterator` is deprecated in favour of `ItemProcessor` but remains valid,
    // and modern CDK emits `ItemProcessor`. Handling one spelling yields an
    // empty cluster for a large class of real graphs.
    const body = state.ItemProcessor ?? state.Iterator;
    const parsed = parseAsl(body, resolve, depth + 1);
    return parsed ? [parsed] : undefined;
  }
  if (type === "Parallel") {
    const branches = state.Branches;
    if (!Array.isArray(branches)) return undefined;
    const out: StateMachineGraph[] = [];
    for (const branch of branches) {
      const parsed = parseAsl(branch, resolve, depth + 1);
      if (!parsed) return undefined;
      out.push(parsed);
    }
    return out;
  }
  return undefined;
}

/**
 * Parses an ASL definition into an engine-independent graph.
 *
 * Returns `undefined` for anything it cannot represent faithfully — an unknown
 * state type, a transition naming a state that does not exist, a Map or
 * Parallel whose body will not parse, or nesting past {@link ASL_DEPTH_CAP}.
 * AWS has extended ASL before (Distributed Map, JSONata, Variables all
 * post-date the original spec), so an unrecognised `Type` must land here
 * rather than throw or silently drop the state.
 */
export function parseAsl(
  definition: unknown,
  resolve: Resolver,
  depth = 0,
): StateMachineGraph | undefined {
  if (depth > ASL_DEPTH_CAP) return undefined;

  const root = asRecord(definition);
  const startAt = root?.StartAt;
  const rawStates = asRecord(root?.States);
  if (typeof startAt !== "string" || !rawStates) return undefined;

  const states = new Map<string, AslState>();

  for (const [key, raw] of Object.entries(rawStates)) {
    const state = asRecord(raw);
    const type = state?.Type;
    if (!state || typeof type !== "string" || !ASL_STATE_TYPES.has(type)) return undefined;
    const kind = type as AslStateType;

    const children = childrenOf(state, kind, resolve, depth);
    if ((kind === "Map" || kind === "Parallel") && !children) return undefined;

    const retry = retryOf(state);
    const integration = integrationOf(state);
    const choiceVariable = Array.isArray(state.Choices)
      ? asRecord(state.Choices[0])?.Variable
      : undefined;

    const label = nonEmpty(state.ArcSyncLabel);
    const comment = nonEmpty(state.Comment);
    const endTransitions = endTransitionsOf(state);
    states.set(key, {
      key,
      ...(label ? { label } : {}),
      ...(comment ? { comment } : {}),
      type: kind,
      transitions: transitionsOf(state),
      terminal: state.End === true || kind === "Succeed" || kind === "Fail",
      ...(endTransitions.length > 0 ? { endTransitions } : {}),
      ...(retry ? { retry } : {}),
      // Map as well as Task: a Distributed Map's `ItemReader` names the S3
      // source it iterates, resolved by the same `targetOf` (see its own
      // doc comment) — the same "resolve to a node" treatment as a Task.
      ...(kind === "Task" || kind === "Map" ? { targetNodeId: targetOf(state, resolve) } : {}),
      ...(integration ? { integration } : {}),
      ...(kind === "Wait" ? waitOf(state) : {}),
      ...(typeof choiceVariable === "string" ? { choiceVariable } : {}),
      ...(kind === "Fail" && typeof state.Error === "string" ? { errorName: state.Error } : {}),
      ...(children ? { children } : {}),
    });
  }

  if (!states.has(startAt)) return undefined;
  for (const state of states.values()) {
    for (const transition of state.transitions) {
      if (!states.has(transition.target)) return undefined;
    }
  }

  return { startAt, states };
}

/** Attribute keys carrying an ASL definition, in the order they are tried.
 * `Definition` is a native object needing no Fn::Join-style string assembly,
 * though its leaf values can still be raw intrinsics; `DefinitionString`
 * (CFN/CDK) is an intrinsic tree built as text; `definition` is Terraform's
 * spelling, already resolved when the graph came from a plan. */
const DEFINITION_KEYS = ["Definition", "DefinitionString", "definition"] as const;

/**
 * Decodes a state machine node's ASL definition, resolving Task targets to real
 * graph node ids.
 *
 * Returns `undefined` whenever the definition cannot be read faithfully — an
 * S3-hosted definition, a marker collision, or anything `parseAsl` rejects.
 * Callers render the collapsed box.
 *
 * A Terraform `definition` now arrives in both shapes. `jsonencode({...})` over
 * a literal is decoded at parse time and reaches the native-object branch below,
 * which is what this whole path exists for; `jsonencode(local.definition)` and
 * friends cannot be decoded, so they stay the interpolated blob hcl2json
 * produced, fail `JSON.parse`, and still collapse. So does any graph stored
 * before the decode shipped.
 */
export function decodeStateMachine(
  node: ResourceNode,
  graph: Pick<ArchGraph, "nodes">,
): StateMachineGraph | undefined {
  for (const key of DEFINITION_KEYS) {
    const raw = node.attributes[key];
    if (raw === undefined) continue;

    // A native object needs no Fn::Join-style string assembly, but its leaf
    // values can still be raw intrinsics — hand-authored ASL commonly writes
    // a Task's Parameters.FunctionName as a bare Fn::GetAtt rather than
    // paying DefinitionString's escaping cost — so walk it for embedded refs
    // instead of assuming every value is already a plain string. Anything
    // else goes through the intrinsic flattener, which also rejects marker
    // collisions.
    let json: string;
    let refs: string[];
    if (typeof raw === "object" && raw !== null && !("Fn::Join" in raw) && !("Fn::Sub" in raw)) {
      const flat = flattenEmbeddedRefs(raw);
      if (!flat) continue;
      json = JSON.stringify(flat.value);
      refs = flat.refs;
    } else {
      const flat = flattenDefinition(raw);
      if (!flat) continue;
      json = flat.json;
      refs = flat.refs;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      // An unevaluated HCL expression lands here — it is not JSON.
      continue;
    }

    const resolve = (value: string): string | undefined => {
      // `targetNodeId` is singular by design, so a field embedding more than
      // one marker (e.g. an Fn::Sub template naming two resources in the same
      // string) has no single correct target either way. No `g` flag here is
      // deliberate: take the first marker and resolve deterministically to
      // it, rather than drop a link that is probably right.
      const marker = value.match(new RegExp(`${REF_MARKER}(\\d+)__`));
      const logicalId = marker ? refs[Number(marker[1])] : value;
      if (logicalId === undefined) return undefined;
      const candidates = graph.nodes.filter((candidate) => candidate.id !== node.id);
      // Precedence passes, not one first-match loop: a Terraform node's name is
      // its bare block label, so `aws_dynamodb_table.orders` would otherwise
      // claim `${aws_lambda_function.orders.arn}` just by sorting first (#2106).
      const byId =
        candidates.find((candidate) => candidate.id === logicalId) ??
        candidates.find((candidate) => containsReferenceToken(logicalId, candidate.id));
      if (byId) return byId.id;
      const byName = candidates.filter((candidate) =>
        containsReferenceToken(logicalId, candidate.name),
      );
      return byName.length === 1 ? byName[0].id : undefined;
    };

    const decoded = parseAsl(parsed, resolve);
    if (decoded) return decoded;
  }
  return undefined;
}

const authoredDecodable = new WeakMap<ResourceNode, boolean>();

/**
 * Whether the canvas may expand `node` into its ASL states. Every Step
 * Functions machine qualifies, as before (an undecodable one still collapses
 * at draw time). Any other node qualifies only when an author marked it
 * `attributes.authored === true` AND its definition decodes, so it keeps its
 * own type and icon; the marker keeps an IaC resource that merely has a
 * `definition` attribute out. Memoised per node object because the canvas
 * asks on every LOD flip.
 */
export function isExpandableStateMachine(node: ResourceNode): boolean {
  if (node.type === ResourceType.SFN_STATE_MACHINE) return true;
  if (node.attributes?.authored !== true) return false;
  let decodable = authoredDecodable.get(node);
  if (decodable === undefined) {
    decodable = decodeStateMachine(node, { nodes: [node] }) !== undefined;
    authoredDecodable.set(node, decodable);
  }
  return decodable;
}
