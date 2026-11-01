/** Marker substituted for a captured reference. Printable ASCII: JSON forbids
 * raw control characters inside strings, so the safety here comes from the
 * collision check in `collect`, not from an exotic character choice. */
export const REF_MARKER = "__ARCSYNC_REF_";

import { lookupByType } from "./typeLookup.js";

export interface FlattenResult {
  /** Parseable JSON text with every reference replaced by a marker. */
  json: string;
  /** Logical ID captured by each marker index. */
  refs: string[];
}

/** CloudFormation pseudo-parameters. Their real values never affect topology,
 * so any syntactically valid stand-in works. */
const PSEUDO_PARAMETERS: Record<string, string> = {
  "AWS::Partition": "aws",
  "AWS::Region": "us-east-1",
  "AWS::AccountId": "000000000000",
  "AWS::URLSuffix": "amazonaws.com",
};

/** Maximum recursion depth. Prevents stack overflow from deeply nested
 * Fn::Join/Fn::Sub structures in adversarial input. */
const MAX_DEPTH = 32;

function markerFor(logicalId: string, refs: string[]): string {
  const index = refs.length;
  refs.push(logicalId);
  return `${REF_MARKER}${index}__`;
}

function collect(
  value: unknown,
  out: string[],
  refs: string[],
  depth: number = MAX_DEPTH,
): boolean {
  if (depth < 0) return false;

  if (typeof value === "string") {
    // A source that already contains the marker could be forged into a false
    // reference, so bail rather than risk it. State names are arbitrary
    // user strings, which is why this check cannot be skipped.
    if (value.includes(REF_MARKER)) return false;
    out.push(value);
    return true;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const obj = value as Record<string, unknown>;

  const join = obj["Fn::Join"];
  if (Array.isArray(join) && join.length === 2 && Array.isArray(join[1])) {
    const separator = typeof join[0] === "string" ? join[0] : "";
    const parts = join[1] as unknown[];
    for (let i = 0; i < parts.length; i++) {
      if (i > 0 && separator) {
        if (separator.includes(REF_MARKER)) return false;
        out.push(separator);
      }
      if (!collect(parts[i], out, refs, depth - 1)) return false;
    }
    return true;
  }

  const ref = obj.Ref;
  if (typeof ref === "string") {
    out.push(lookupByType(PSEUDO_PARAMETERS, ref) ?? markerFor(ref, refs));
    return true;
  }

  const getAtt = obj["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
    out.push(markerFor(getAtt[0], refs));
    return true;
  }
  if (typeof getAtt === "string") {
    out.push(markerFor(getAtt.split(".")[0], refs));
    return true;
  }

  const sub = obj["Fn::Sub"];
  const template = typeof sub === "string" ? sub : Array.isArray(sub) ? sub[0] : undefined;
  if (typeof template === "string") {
    if (template.includes(REF_MARKER)) return false;
    const vars = (Array.isArray(sub) ? sub[1] : undefined) as Record<string, unknown> | undefined;
    let failed = false;
    const rendered = template.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
      const key = name.trim();
      const pseudo = lookupByType(PSEUDO_PARAMETERS, key);
      if (pseudo) return pseudo;
      if (vars && Object.hasOwn(vars, key)) {
        const nested: string[] = [];
        if (!collect(vars[key], nested, refs, depth - 1)) {
          failed = true;
          return "";
        }
        return nested.join("");
      }
      return markerFor(key.split(".")[0], refs);
    });
    if (failed) return false;
    out.push(rendered);
    return true;
  }

  return false;
}

/**
 * Flattens a CloudFormation intrinsic tree into parseable JSON text, replacing
 * every resource reference with an indexed marker.
 *
 * Returns `undefined` for anything it cannot flatten faithfully — an
 * unsupported intrinsic, or a source string that already contains the marker.
 * Callers treat `undefined` as "render the collapsed box".
 */
export function flattenDefinition(value: unknown): FlattenResult | undefined {
  const refs: string[] = [];
  const parts: string[] = [];
  if (!collect(value, parts, refs, MAX_DEPTH)) return undefined;
  return { json: parts.join(""), refs };
}

export interface FlattenValueResult {
  /** The same JSON value, with every embedded intrinsic leaf replaced by an
   * indexed marker string. */
  value: unknown;
  /** Logical ID captured by each marker index. */
  refs: string[];
}

/** Real CloudFormation intrinsic functions are always exactly one reserved
 * key — this is what lets `substituteEmbeddedRefs` tell "resolve me" from
 * "recurse into me" apart without a false match on some ASL object that
 * happens to have a single field. */
const INTRINSIC_KEYS = new Set(["Ref", "Fn::GetAtt", "Fn::Join", "Fn::Sub"]);

function isIntrinsicLeaf(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && INTRINSIC_KEYS.has(keys[0]);
}

/** Distinct from any legitimate JSON value, so it can be threaded back up the
 * recursion as an unambiguous failure signal. */
const SUBSTITUTE_FAILED = Symbol("aslFlatten:substituteEmbeddedRefs failed");

function substituteEmbeddedRefs(value: unknown, refs: string[], depth: number): unknown {
  if (depth < 0) return SUBSTITUTE_FAILED;

  if (isIntrinsicLeaf(value)) {
    const out: string[] = [];
    if (!collect(value, out, refs, depth)) return SUBSTITUTE_FAILED;
    return out.join("");
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const resolved = substituteEmbeddedRefs(item, refs, depth - 1);
      if (resolved === SUBSTITUTE_FAILED) return SUBSTITUTE_FAILED;
      result.push(resolved);
    }
    return result;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(obj)) {
      const resolved = substituteEmbeddedRefs(v, refs, depth - 1);
      if (resolved === SUBSTITUTE_FAILED) return SUBSTITUTE_FAILED;
      result[key] = resolved;
    }
    return result;
  }
  // Same forged-reference guard `collect` applies to every string it emits.
  if (typeof value === "string" && value.includes(REF_MARKER)) return SUBSTITUTE_FAILED;
  return value;
}

/**
 * Walks an already-parsed JSON value — a StepFunctions `Definition` object,
 * which CDK and CloudFormation emit without `Fn::Join`-style string assembly —
 * substituting every embedded intrinsic leaf (`Ref`, `Fn::GetAtt`, `Fn::Join`,
 * `Fn::Sub`) with the same indexed marker `flattenDefinition` uses, while
 * leaving the surrounding structure (states, transitions, arrays) untouched.
 * Hand-authored ASL commonly writes a Task's `Parameters.FunctionName` as a
 * bare `Fn::GetAtt` rather than paying `DefinitionString`'s escaping cost, so
 * a `Definition` object can carry unresolved intrinsics several levels deep.
 *
 * Returns `undefined` for anything it cannot flatten faithfully, mirroring
 * `flattenDefinition`.
 */
export function flattenEmbeddedRefs(value: unknown): FlattenValueResult | undefined {
  const refs: string[] = [];
  const result = substituteEmbeddedRefs(value, refs, MAX_DEPTH);
  return result === SUBSTITUTE_FAILED ? undefined : { value: result, refs };
}
