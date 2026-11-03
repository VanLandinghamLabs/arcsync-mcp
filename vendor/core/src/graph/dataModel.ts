import type { ResourceNode } from "./types.js";

export type FieldKey = "PK" | "SK" | "FK" | "UK" | "GSI" | "LSI";

export interface DataField {
  name: string;
  type: string;
  keys: FieldKey[];
  comment?: string;
}

export interface DataEntity {
  /** Identity: relationships refer to entities by this. */
  name: string;
  /** Display label (a Mermaid alias), when it differs from `name`. */
  label?: string;
  /** `TABLE` for a base table, `INDEX` for a DynamoDB secondary index, `ENTITY` for an authored entity. */
  kind: "TABLE" | "INDEX" | "ENTITY";
  fields: DataField[];
}

export type Cardinality = "one" | "zero-or-one" | "many" | "one-or-many";

export interface DataRelationship {
  from: string;
  to: string;
  fromCardinality: Cardinality;
  toCardinality: Cardinality;
  label?: string;
  identifying: boolean;
}

export interface DataModel {
  entities: DataEntity[];
  relationships: DataRelationship[];
}

/**
 * A store's model rides on this attribute, set when the graph is built: from an
 * authored `erDiagram` block (`parseArcsync`), or by the parser from a DynamoDB
 * table's key schema and the app code's schemas (`attachAppSchemas`). The canvas
 * only reads it, so no IaC knowledge ships in the SPA.
 */
export const DATA_MODEL_ATTRIBUTE = "DataModel";

const MAX_ENTITIES = 60;
const MAX_FIELDS = 80;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

const ENTITY_KINDS: ReadonlySet<string> = new Set(["TABLE", "INDEX", "ENTITY"]);

/** One stored entity, validated shape-by-shape rather than trusted. */
function validEntity(e: unknown): DataEntity | undefined {
  if (!isRecord(e) || !str(e.name) || !Array.isArray(e.fields)) return undefined;
  const fields: DataField[] = [];
  for (const f of e.fields.slice(0, MAX_FIELDS)) {
    if (!isRecord(f) || !str(f.name)) return undefined;
    fields.push({
      name: f.name as string,
      type: str(f.type) ?? "",
      keys: Array.isArray(f.keys)
        ? (f.keys.filter((k) => typeof k === "string") as FieldKey[])
        : [],
      ...(str(f.comment) ? { comment: f.comment as string } : {}),
    });
  }
  return {
    name: e.name as string,
    kind: ENTITY_KINDS.has(e.kind as string) ? (e.kind as DataEntity["kind"]) : "ENTITY",
    fields,
    ...(str(e.label) ? { label: e.label as string } : {}),
  };
}

/** A stored model, validated shape-by-shape rather than trusted. */
function storedModel(raw: unknown): DataModel | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.entities)) return undefined;
  const entities: DataEntity[] = [];
  for (const e of raw.entities.slice(0, MAX_ENTITIES)) {
    const entity = validEntity(e);
    if (!entity) return undefined;
    entities.push(entity);
  }
  if (entities.length === 0) return undefined;
  const names = new Set(entities.map((e) => e.name));
  const relationships = (Array.isArray(raw.relationships) ? raw.relationships : []).filter(
    (r): r is DataRelationship =>
      isRecord(r) &&
      names.has(r.from as string) &&
      names.has(r.to as string) &&
      Object.hasOwn(CARDINALITY_GLYPH, r.fromCardinality as string) &&
      Object.hasOwn(CARDINALITY_GLYPH, r.toCardinality as string),
  );
  return { entities, relationships };
}

// Keyed by the attributes object, which a model is attached by replacing, so a
// lookup made before the attach can't answer for the node after it.
const decoded = new WeakMap<object, DataModel | null>();

/** The node's data model, or `undefined` when it has none to show. Memoised per attributes object. */
export function decodeDataModel(node: ResourceNode): DataModel | undefined {
  const key = node.attributes ?? node;
  const hit = decoded.get(key);
  if (hit !== undefined) return hit ?? undefined;
  const raw = node.attributes?.[DATA_MODEL_ATTRIBUTE];
  const model = raw !== undefined ? storedModel(raw) : undefined;
  decoded.set(key, model ?? null);
  return model;
}

export function isExpandableDataStore(node: ResourceNode): boolean {
  return decodeDataModel(node) !== undefined;
}

const CARDINALITY_GLYPH: Record<Cardinality, string> = {
  one: "1",
  "zero-or-one": "0..1",
  many: "0..N",
  "one-or-many": "1..N",
};

/** `places · 1 → 0..N` — the drawn label of a relationship edge. */
export function relationshipLabel(r: DataRelationship): string {
  const card = `${CARDINALITY_GLYPH[r.fromCardinality]} → ${CARDINALITY_GLYPH[r.toCardinality]}`;
  return r.label ? `${r.label} · ${card}` : card;
}
