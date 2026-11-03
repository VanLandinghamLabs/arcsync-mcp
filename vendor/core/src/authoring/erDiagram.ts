import type {
  Cardinality,
  DataEntity,
  DataField,
  DataModel,
  DataRelationship,
  FieldKey,
} from "../graph/dataModel.js";
import type { Diagnostics } from "./diagnostics.js";
import type { SourceBlock } from "./source.js";

export const MAX_ER_ENTITIES = 60;
export const MAX_ER_FIELDS = 80;

const START = /^erDiagram\b/;
const NAME = String.raw`[A-Za-z_][\w-]*`;
const ALIAS = String.raw`(?:\[\s*"?([^"\]]*)"?\s*\])?`;
// Mermaid crow's foot: left end |o || }o }| ; right end o| || o{ |{ ; -- identifying,
// .. .- -. not.
const RELATIONSHIP = new RegExp(
  String.raw`^(${NAME})${ALIAS}\s*(\|o|\|\||\}o|\}\|)(--|\.\.|\.-|-\.)(o\||\|\||o\{|\|\{)\s*(${NAME})${ALIAS}\s*(?::\s*(.*))?$`,
);
// Mermaid's word forms: `CAR 1 to zero or more DRIVER`; `optionally to` is non-identifying.
const WORD_CARDINALITY = String.raw`zero or one|one or zero|only one|zero or more|zero or many|one or more|one or many|many\(0\)|many\(1\)|0\+|1\+|1`;
const WORD_RELATIONSHIP = new RegExp(
  String.raw`^(${NAME})${ALIAS}\s+(${WORD_CARDINALITY})\s+(to|optionally to)\s+(${WORD_CARDINALITY})\s+(${NAME})${ALIAS}\s*(?::\s*(.*))?$`,
  "i",
);
const ENTITY_OPEN = new RegExp(String.raw`^(${NAME})${ALIAS}\s*\{\s*(\})?\s*$`);
const DIRECTIVE = /^(?:direction|accTitle|accDescr|style|classDef|class)(?=\s|:|$)|^title:/;
const ENTITY_BARE = new RegExp(String.raw`^(${NAME})${ALIAS}$`);
const FIELD =
  /^([\w()[\],.-]+)\s+([\w*-]+)((?:\s+(?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?)\s*(?:"([^"]*)")?$/;

const LEFT: Record<string, Cardinality> = {
  "|o": "zero-or-one",
  "||": "one",
  "}o": "many",
  "}|": "one-or-many",
};
const RIGHT: Record<string, Cardinality> = {
  "o|": "zero-or-one",
  "||": "one",
  "o{": "many",
  "|{": "one-or-many",
};

const WORDS: Record<string, Cardinality> = {
  "zero or one": "zero-or-one",
  "one or zero": "zero-or-one",
  "only one": "one",
  "1": "one",
  "zero or more": "many",
  "zero or many": "many",
  "many(0)": "many",
  "0+": "many",
  "one or more": "one-or-many",
  "one or many": "one-or-many",
  "many(1)": "one-or-many",
  "1+": "one-or-many",
};

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1");

/**
 * A Mermaid `erDiagram` block as a `DataModel`. Unrecognised lines are reported
 * and skipped rather than failing the block, matching the other block parsers.
 */
export function parseErDiagram(block: SourceBlock, diags: Diagnostics): DataModel {
  const blockId = block.id ?? `block-${block.index + 1}`;
  const entities = new Map<string, DataEntity>();
  const relationships: DataRelationship[] = [];
  const aliases = new Map<string, string>();
  const capped = new Set<DataEntity>();
  const warn = (line: number, message: string) =>
    diags.add({ level: "warning", block: blockId, line, column: 1, message });

  const entity = (
    name: string,
    alias: string | undefined,
    line: number,
  ): DataEntity | undefined => {
    let e = entities.get(name);
    if (!e) {
      if (entities.size >= MAX_ER_ENTITIES) {
        warn(line, `more than ${MAX_ER_ENTITIES} entities; the rest are dropped`);
        return undefined;
      }
      e = { name, kind: "ENTITY", fields: [] };
      entities.set(name, e);
    }
    if (alias?.trim()) aliases.set(name, alias.trim());
    return e;
  };

  let open: DataEntity | undefined;
  let seenHeader = false;
  for (const { text, line } of block.lines) {
    const t = text.trim();
    if (t === "" || t.startsWith("%%")) continue;
    if (!seenHeader) {
      if (START.test(t)) seenHeader = true;
      continue;
    }
    if (open) {
      if (t === "}") {
        open = undefined;
        continue;
      }
      const m = FIELD.exec(t);
      if (!m) {
        warn(line, `can't read field '${t}'; expected 'type name [PK|FK|UK] ["comment"]'`);
        continue;
      }
      if (open.fields.length >= MAX_ER_FIELDS) {
        if (!capped.has(open))
          warn(line, `more than ${MAX_ER_FIELDS} fields on '${open.name}'; the rest are dropped`);
        capped.add(open);
        continue;
      }
      const keys = (m[3] ?? "")
        .split(/[\s,]+/)
        .filter((k): k is FieldKey => k === "PK" || k === "FK" || k === "UK");
      const field: DataField = { name: m[2], type: m[1], keys, ...(m[4] ? { comment: m[4] } : {}) };
      open.fields.push(field);
      continue;
    }
    if (DIRECTIVE.test(t)) continue;
    const symbols = RELATIONSHIP.exec(t);
    const words = symbols ? undefined : WORD_RELATIONSHIP.exec(t);
    const rel = symbols ?? words;
    if (rel) {
      const [, a, aAlias, left, link, right, b, bAlias, label] = rel;
      const from = entity(a, aAlias, line);
      const to = entity(b, bAlias, line);
      const word = (w: string) => WORDS[w.toLowerCase().replace(/\s+/g, " ")];
      if (from && to)
        relationships.push({
          from: from.name,
          to: to.name,
          fromCardinality: words ? word(left) : LEFT[left],
          toCardinality: words ? word(right) : RIGHT[right],
          identifying: words ? link.toLowerCase() === "to" : link === "--",
          ...(label && unquote(label) ? { label: unquote(label) } : {}),
        });
      continue;
    }
    const opened = ENTITY_OPEN.exec(t);
    if (opened) {
      const found = entity(opened[1], opened[2], line);
      if (!opened[3]) open = found ?? { name: opened[1], kind: "ENTITY", fields: [] };
      continue;
    }
    const bare = ENTITY_BARE.exec(t);
    if (bare) {
      entity(bare[1], bare[2], line);
      continue;
    }
    warn(line, `can't read '${t}'`);
  }
  if (open) warn(block.lines.at(-1)?.line ?? 1, `entity '${open.name}' is missing its closing }`);
  // Aliases apply last: authors usually write relationships before the entity
  // block that declares one. They are labels only, so identity stays the raw name.
  return {
    entities: [...entities.values()].map((e) => {
      const label = aliases.get(e.name);
      return label && label !== e.name ? { ...e, label } : e;
    }),
    relationships,
  };
}
