/**
 * Resolving an IaC reference to a node id, and reading the two shapes an event
 * pattern arrives in. Provider-agnostic: CFN intrinsics and Terraform
 * interpolations both show up in AWS, GCP and Azure graphs.
 */

/** Resolve a CFN intrinsic ({Ref: X} / {Fn::GetAtt: [X, ...]}) to a logical id. */
export function resolveCfnRef(value: unknown): string | null {
  if (value == null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.Ref === "string") return obj.Ref;
  const getAtt = obj["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") return getAtt[0];
  return null;
}

/**
 * Match a bare ref (id or interpolation text) against node ids, retrying
 * under the owning node's stack prefix for multi-stack CFN parses.
 */
export function scopedIdMatch(ref: string, ownerId: string, nodeIds: Set<string>): string | null {
  if (nodeIds.has(ref)) return ref;
  const slashIdx = ownerId.lastIndexOf("/");
  if (slashIdx !== -1) {
    const scoped = `${ownerId.slice(0, slashIdx + 1)}${ref}`;
    if (nodeIds.has(scoped)) return scoped;
  }
  return null;
}

/**
 * Resolve a CFN ref to an existing node id. CDK synth keeps bare logical ids
 * inside Ref/Fn::GetAtt while multi-stack parses prefix node ids with
 * "{Stack}/" — retry the bare ref under the owning node's stack prefix.
 */
export function scopedCfnRef(value: unknown, ownerId: string, nodeIds: Set<string>): string | null {
  const ref = resolveCfnRef(value);
  if (!ref) return null;
  return scopedIdMatch(ref, ownerId, nodeIds);
}

/** Extract "type.name" from a TF interpolation like "${aws_x.y.attr}". */
export function resolveTfRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.match(/\$\{([a-z0-9_]+\.[A-Za-z0-9_-]+)\./);
  return m ? m[1] : null;
}

/** Parse an event pattern that may be a CFN object or a Terraform JSON string. */
export function parsePattern(raw: unknown): Record<string, unknown> | null {
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

export function stringValues(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((v) => typeof v === "string") ? (value as string[]) : null;
}
