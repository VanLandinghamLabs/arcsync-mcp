// `DeltaNode` is a type-only import, so it is erased and creates no runtime
// cycle with graphDelta.ts, which imports diffNodeAttributes back from here.
import type { DeltaNode } from "./graphDelta.js";
import { stableStringify } from "./stableStringify.js";
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
