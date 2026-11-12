// `DeltaNode` is a type-only import, so it is erased and creates no runtime
// cycle with graphDelta.ts, which imports diffNodeAttributes back from here.
import type { DeltaNode } from "./graphDelta.js";
import { stableStringify } from "./stableStringify.js";
import { lookupByType } from "./typeLookup.js";
import type { ResourceNode } from "./types.js";

export interface AttributeChange {
  /** `attributes`-relative key path, e.g. ["logging", "bucket"]. */
  path: string[];
  before: unknown;
  after: unknown;
  significance: "high" | "normal";
}

export interface ChangedNodeDetail extends DeltaNode {
  changes: AttributeChange[];
  /** Changes dropped by the cap. Rendered as "+N more". */
  truncated: number;
}

/** Attributes whose value changes what a resource MEANS, not just how it is
 * spelled. Matched on the last path segment. */
const HIGH_SIGNIFICANCE_KEYS = new Set([
  "instance_class",
  "instance_type",
  "memory_size",
  "multi_az",
  "publicly_accessible",
  "acl",
  "runtime",
  "port",
  "cidr_blocks",
  "desired_count",
  "engine_version",
]);

/** Substrings that make any path segment security-relevant. */
const HIGH_SIGNIFICANCE_PATTERNS = ["public", "policy", "ingress", "egress", "encryption"];

/** Guards against a pathological template recursing without bound. */
const MAX_DEPTH = 12;
/** Emitted changes per node. The remainder is counted, not dropped silently. */
const MAX_CHANGES = 8;

function significanceOf(path: string[]): "high" | "normal" {
  const last = path[path.length - 1]?.toLowerCase() ?? "";
  if (HIGH_SIGNIFICANCE_KEYS.has(last)) return "high";
  for (const segment of path) {
    const lower = segment.toLowerCase();
    for (const pattern of HIGH_SIGNIFICANCE_PATTERNS) {
      if (lower.includes(pattern)) return "high";
    }
  }
  return "normal";
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isScalarArray = (v: unknown): v is unknown[] =>
  Array.isArray(v) && v.every((item) => item === null || typeof item !== "object");

/**
 * Order-insensitive equality for arrays of scalars. A reordered `cidr_blocks`
 * or ingress list is not a change any author made. Arrays of OBJECTS are
 * compared by index instead, which does report reordering. That is a known
 * and accepted limitation rather than a list-matching heuristic.
 */
function scalarArraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const item of a) {
    const k = stableStringify(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const item of b) {
    const k = stableStringify(item);
    const n = counts.get(k);
    if (n === undefined) return false;
    if (n === 1) counts.delete(k);
    else counts.set(k, n - 1);
  }
  return counts.size === 0;
}

function walk(before: unknown, after: unknown, path: string[], out: AttributeChange[]): void {
  if (isScalarArray(before) && isScalarArray(after)) {
    if (!scalarArraysEqual(before, after)) {
      out.push({ path, before, after, significance: significanceOf(path) });
    }
    return;
  }

  // `stableStringify` sorts object keys, so a reformatted policy document is
  // equal here. That is what keeps the panel free of phantom changes.
  if (stableStringify(before) === stableStringify(after)) return;

  if (isPlainObject(before) && isPlainObject(after) && path.length < MAX_DEPTH) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      walk(before[key], after[key], [...path, key], out);
    }
    return;
  }

  out.push({ path, before, after, significance: significanceOf(path) });
}

const LAMBDA_CODE = ["Code.S3Bucket", "Code.S3Key", "Code.S3ObjectVersion"];
const LAYER_CONTENT = ["Content.S3Bucket", "Content.S3Key", "Content.S3ObjectVersion"];
const TF_LAMBDA = ["filename", "s3_bucket", "s3_key", "s3_object_version", "source_code_hash"];
const PULUMI_LAMBDA = ["code", "s3Bucket", "s3Key", "s3ObjectVersion", "sourceCodeHash"];

/**
 * Attribute paths, by resource type, that point at a deploy artifact rather
 * than describe the resource: a CDK asset hash in `Code.S3Key`, a bundle's
 * object key. A build changes them on every deploy. `*` matches every element
 * of an array.
 */
const DEPLOY_ARTIFACT_PATHS: Record<string, readonly string[]> = {
  "AWS::Lambda::Function": [...LAMBDA_CODE, "Code.ZipFile"],
  "AWS::Serverless::Function": ["CodeUri", "InlineCode"],
  "AWS::Lambda::LayerVersion": LAYER_CONTENT,
  "AWS::Serverless::LayerVersion": ["ContentUri"],
  "Custom::CDKBucketDeployment": ["SourceBucketNames", "SourceObjectKeys"],
  aws_lambda_function: TF_LAMBDA,
  aws_lambda_layer_version: TF_LAMBDA,
  "aws:lambda/function:Function": PULUMI_LAMBDA,
  "aws:lambda/layerVersion:LayerVersion": PULUMI_LAMBDA,
};

/** Container image references. Only the tag or digest is a deploy pointer; a
 * different repository is a different image. */
const IMAGE_PATHS: Record<string, readonly string[]> = {
  "AWS::Lambda::Function": ["Code.ImageUri"],
  "AWS::Serverless::Function": ["ImageUri"],
  "AWS::ECS::TaskDefinition": ["ContainerDefinitions.*.Image"],
  aws_lambda_function: ["image_uri"],
  "aws:lambda/function:Function": ["imageUri"],
};

/** `host:5000/repo:tag@sha256:…` -> `host:5000/repo`. A `:` before the last
 * `/` is a registry port, not a tag. */
function imageRepository(ref: string): string {
  const name = ref.split("@")[0];
  const colon = name.lastIndexOf(":");
  return colon > name.lastIndexOf("/") ? name.slice(0, colon) : name;
}

/** The repository of every string in an image value; an intrinsic such as
 * `Fn::Sub` keeps its shape with each string leaf reduced the same way. */
function imageRepositories(value: unknown): unknown {
  if (typeof value === "string") return imageRepository(value);
  if (Array.isArray(value)) return value.map(imageRepositories);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, imageRepositories(v)]));
  }
  return value;
}

/** `value` with `fn` applied at `path`; a result of `undefined` drops the key. */
function mapAt(value: unknown, path: readonly string[], fn: (v: unknown) => unknown): unknown {
  const [head, ...rest] = path;
  if (head === "*") return Array.isArray(value) ? value.map((v) => mapAt(v, rest, fn)) : value;
  if (!isPlainObject(value) || !Object.hasOwn(value, head)) return value;
  const next = rest.length === 0 ? fn(value[head]) : mapAt(value[head], rest, fn);
  const others = Object.entries(value).filter(([k]) => k !== head);
  return Object.fromEntries(next === undefined ? others : [...others, [head, next]]);
}

const applyAll = (
  value: unknown,
  paths: readonly string[] | undefined,
  fn: (v: unknown) => unknown,
): unknown => (paths ?? []).reduce((acc, p) => mapAt(acc, p.split("."), fn), value);

/** `attributes` without the resource type's deploy-artifact pointers: those
 * paths dropped, and image references cut to their repository. */
export function withoutDeployArtifacts(
  resourceType: string,
  attributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!attributes) return attributes;
  const dropped = applyAll(
    attributes,
    lookupByType(DEPLOY_ARTIFACT_PATHS, resourceType),
    () => undefined,
  );
  return applyAll(dropped, lookupByType(IMAGE_PATHS, resourceType), imageRepositories) as Record<
    string,
    unknown
  >;
}

export function diffNodeAttributes(
  before: ResourceNode,
  after: ResourceNode,
): { changes: AttributeChange[]; truncated: number } {
  const all: AttributeChange[] = [];
  walk(before.attributes ?? {}, after.attributes ?? {}, [], all);

  all.sort((a, b) => {
    if (a.significance !== b.significance) return a.significance === "high" ? -1 : 1;
    const ap = a.path.join(".");
    const bp = b.path.join(".");
    return ap < bp ? -1 : ap > bp ? 1 : 0;
  });

  return {
    changes: all.slice(0, MAX_CHANGES),
    truncated: Math.max(0, all.length - MAX_CHANGES),
  };
}
