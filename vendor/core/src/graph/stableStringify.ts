/**
 * Key-order-insensitive JSON. Two objects that differ only in key order or
 * formatting stringify identically, which is what keeps a reformatted policy
 * document from reading as an infrastructure change.
 *
 * Lives in its own module because both graphDelta and attributeDiff need it
 * and they import each other.
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
