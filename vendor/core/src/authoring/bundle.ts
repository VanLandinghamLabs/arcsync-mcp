import { DATA_MODEL_ATTRIBUTE, type DataModel } from "../graph/dataModel.js";
import {
  type ArchGraph,
  EdgeType,
  type GraphMetadata,
  type ResourceEdge,
  type ResourceNode,
  ResourceType,
} from "../graph/types.js";
import { createDiagnostics, type Diagnostic } from "./diagnostics.js";
import { parseErDiagram } from "./erDiagram.js";
import {
  type EdgeKind,
  edgeBudget,
  type FlowAst,
  type FlowNode,
  parseFlowchart,
} from "./flowchart.js";
import { resolveIcon, suggestIcon } from "./icons.js";
import type { MetaValue } from "./meta.js";
import { type SourceBlock, splitSource } from "./source.js";
import { parseStateDiagram, type StateAst, stateBudget } from "./stateDiagram.js";
import { type AslDefinition, stateAstToAsl } from "./stateToAsl.js";

export const MAX_AUTHORED_NODES = 2000;
export const DIAGRAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Author text that becomes a CANON field or search facet is clamped to this. */
export const MAX_AUTHORED_TEXT = 200;
export const NO_DIAGRAM_ID = "add %% diagram: <id> to the first block, or pass diagramId";
export const DIAGRAM_ID_FROM_TITLE =
  "diagram id comes from the title; add %% diagram: <id> to keep it stable when the title changes";

export type DiagramIdSource = "pinned" | "title" | "none";

export interface ParseResult {
  graph: ArchGraph;
  diagnostics: Diagnostic[];
  blocks: { id: string; kind: "flow" | "state" | "er"; title?: string }[];
  title: string;
  diagramId: string | undefined;
  diagramIdSource: DiagramIdSource;
  ok: boolean;
}

const EDGE_TYPES: Record<EdgeKind, EdgeType> = {
  sync: EdgeType.REFERENCE,
  async: EdgeType.EVENT_FLOW,
  data: EdgeType.DEPENDENCY,
  network: EdgeType.NETWORK,
  iam: EdgeType.IAM,
};

const DEFINITION_KEYS = ["Definition", "DefinitionString", "definition"];
const CONTRACT_KEYS: ReadonlySet<string> = new Set([
  "icon",
  "kind",
  "link",
  "fill",
  "stroke",
  "authored",
  "description",
  "details",
  ...DEFINITION_KEYS,
]);
const HTTP_URL = /^https?:\/\//i;
const ID_COMMENT = /^\s*%%\s*diagram:/;
const TITLE_LINE = /^\s*(?:%%\s*)?title:/;

const slug = (title: string): string | undefined =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "") || undefined;

const isRecord = (v: MetaValue | undefined): v is { [k: string]: MetaValue } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const providerOf = (icon: string): string => {
  const colon = icon.indexOf(":");
  return colon > 0 ? icon.slice(0, colon) : "custom";
};

const blockName = (block: SourceBlock) => block.id ?? `block-${block.index + 1}`;

interface FlowBlock {
  id: string;
  title: string | undefined;
  ast: FlowAst;
}

export const parseArcsync = (source: string): ParseResult => {
  const diags = createDiagnostics();
  const report = (
    level: Diagnostic["level"],
    block: string,
    line: number,
    message: string,
    suggestion?: string,
  ) => diags.add({ level, block, line, column: 1, message, ...(suggestion && { suggestion }) });
  const clamp = (text: string, what: string, block: string, line: number): string => {
    if (text.length <= MAX_AUTHORED_TEXT) return text;
    report(
      "warning",
      block,
      line,
      `${what} longer than ${MAX_AUTHORED_TEXT} characters was shortened`,
    );
    return text.slice(0, MAX_AUTHORED_TEXT);
  };
  const split = splitSource(source, diags).map((block) =>
    block.title === undefined || block.title.length <= MAX_AUTHORED_TEXT
      ? block
      : {
          ...block,
          title: clamp(
            block.title,
            "title",
            blockName(block),
            block.lines.find((l) => TITLE_LINE.test(l.text))?.line ?? 1,
          ),
        },
  );
  const flowBudget = edgeBudget();
  const stateLimits = stateBudget();

  const seen = new Set<string>();
  const flows: FlowBlock[] = [];
  const states = new Map<string, StateAst>();
  const stateTitles = new Map<string, string | undefined>();
  const models = new Map<string, DataModel>();
  const modelTitles = new Map<string, string | undefined>();
  const kept: ParseResult["blocks"] = [];
  for (const block of split) {
    if (block.kind === "unknown") continue;
    const id = blockName(block);
    if (seen.has(id)) {
      const line = block.lines.find((l) => ID_COMMENT.test(l.text))?.line ?? 1;
      report("error", id, line, `duplicate block id '${id}'`);
      continue;
    }
    seen.add(id);
    kept.push({ id, kind: block.kind, ...(block.title !== undefined && { title: block.title }) });
    if (block.kind === "flow")
      flows.push({ id, title: block.title, ast: parseFlowchart(block, diags, flowBudget) });
    else if (block.kind === "er") {
      models.set(id, parseErDiagram(block, diags));
      modelTitles.set(id, block.title);
    } else {
      states.set(id, parseStateDiagram(block, diags, stateLimits));
      stateTitles.set(id, block.title);
    }
  }

  const definitions = new Map<string, AslDefinition>();
  const definitionOf = (id: string, ast: StateAst): AslDefinition => {
    let definition = definitions.get(id);
    if (!definition) {
      definition = stateAstToAsl(ast, id, diags);
      definitions.set(id, definition);
    }
    return definition;
  };

  const nodes = new Map<string, ResourceNode>();
  const edges: ResourceEdge[] = [];
  const groups = new Set<string>();
  const expanded = new Set<string>();
  const multi = flows.length > 1;

  const contain = (parent: string, child: string) =>
    edges.push({
      id: `${parent}->contains->${child}`,
      source: parent,
      target: child,
      type: EdgeType.CONTAINS,
    });

  const buildNode = (fn: FlowNode, flow: FlowBlock): ResourceNode => {
    const { label: _label, props, expands, icon, link, ...rest } = fn.meta;
    const warn = (message: string) => report("warning", flow.id, fn.line, message);
    if (DEFINITION_KEYS.some((key) => Object.hasOwn(rest, key))) {
      warn("Definition is set only by expands");
      for (const key of DEFINITION_KEYS) delete rest[key];
    }
    const extra: Record<string, MetaValue> = isRecord(props)
      ? { ...props }
      : props !== undefined
        ? { props }
        : {};
    for (const key of Object.keys(extra)) {
      if (!CONTRACT_KEYS.has(key)) continue;
      warn(`props.${key} is ignored; set ${key} directly`);
      delete extra[key];
    }
    const attributes: Record<string, unknown> = { ...rest, ...extra, authored: true };
    let type: string = ResourceType.AUTHORED;
    let provider = "custom";

    if (icon !== undefined) {
      const resolved = typeof icon === "string" ? resolveIcon(icon) : undefined;
      if (resolved) {
        attributes.icon = resolved.icon;
        provider = providerOf(resolved.icon);
        if (!fn.isGroup) type = resolved.type;
      } else {
        attributes.icon = icon;
        const suggestion = typeof icon === "string" ? suggestIcon(icon) : undefined;
        report("warning", flow.id, fn.line, `unknown icon '${String(icon)}'`, suggestion);
      }
    }

    const url = fn.link ?? (typeof link === "string" ? link : undefined);
    if (url !== undefined) {
      if (HTTP_URL.test(url)) attributes.link = url;
      else report("warning", flow.id, fn.line, "only http and https links are kept");
    }

    const style: { fill?: string; stroke?: string } = {};
    for (const cls of fn.classes) Object.assign(style, flow.ast.classDefs.get(cls));
    Object.assign(style, fn.style);
    if (style.fill !== undefined) attributes.fill = style.fill;
    if (style.stroke !== undefined) attributes.stroke = style.stroke;

    if (expands !== undefined) {
      const ast = typeof expands === "string" ? states.get(expands) : undefined;
      const model = typeof expands === "string" ? models.get(expands) : undefined;
      if (typeof expands !== "string")
        report("error", flow.id, fn.line, "expands must name a state or ER diagram block");
      else if (model) {
        attributes[DATA_MODEL_ATTRIBUTE] = model;
        expanded.add(expands);
      } else if (ast) {
        attributes.Definition = definitionOf(expands, ast);
        expanded.add(expands);
      } else if (seen.has(expands))
        report("error", flow.id, fn.line, `'${expands}' is not a state or ER diagram block`);
      else report("error", flow.id, fn.line, `no block named '${expands}'`);
    }

    return {
      id: fn.id,
      type: type as ResourceType,
      provider,
      name: clamp(fn.label ?? fn.id, fn.isGroup ? "container name" : "node name", flow.id, fn.line),
      resourceType: type,
      attributes,
    };
  };

  const authoredNode = (
    id: string,
    name: string,
    attributes: Record<string, unknown>,
  ): ResourceNode => ({
    id,
    type: ResourceType.AUTHORED,
    provider: "custom",
    name,
    resourceType: ResourceType.AUTHORED,
    attributes: { ...attributes, authored: true },
  });

  for (const flow of flows) {
    if (multi && !nodes.has(flow.id))
      nodes.set(
        flow.id,
        authoredNode(flow.id, clamp(flow.title ?? flow.id, "container name", flow.id, 1), {
          kind: "diagram",
        }),
      );
    const endpoints = new Set(flow.ast.edges.flatMap((e) => [e.source, e.target]));
    for (const fn of flow.ast.nodes.values()) {
      if (fn.isGroup) groups.add(fn.id);
      const existing = nodes.get(fn.id);
      if (existing) {
        if (fn.label !== undefined && fn.label.slice(0, MAX_AUTHORED_TEXT) !== existing.name)
          report(
            "warning",
            flow.id,
            fn.line,
            `node '${fn.id}' is already defined as '${existing.name}'`,
          );
        continue;
      }
      const implicit =
        !fn.isGroup &&
        fn.label === undefined &&
        fn.shape === undefined &&
        Object.keys(fn.meta).length === 0 &&
        endpoints.has(fn.id);
      if (implicit) report("info", flow.id, fn.line, `node '${fn.id}' is created by an edge`);
      nodes.set(fn.id, buildNode(fn, flow));
      const parent = fn.parent ?? (multi ? flow.id : undefined);
      if (parent !== undefined) contain(parent, fn.id);
    }
  }

  for (const [id, ast] of states) {
    if (expanded.has(id)) continue;
    if (nodes.has(id)) {
      report("error", id, 1, `'${id}' is both a node and a state diagram block`);
      continue;
    }
    nodes.set(
      id,
      authoredNode(id, clamp(stateTitles.get(id) ?? id, "container name", id, 1), {
        icon: "service",
        kind: "state machine",
        Definition: definitionOf(id, ast),
      }),
    );
  }

  for (const [id, model] of models) {
    if (expanded.has(id)) continue;
    if (nodes.has(id)) {
      report("error", id, 1, `'${id}' is both a node and an ER diagram block`);
      continue;
    }
    nodes.set(
      id,
      authoredNode(id, clamp(modelTitles.get(id) ?? id, "container name", id, 1), {
        icon: "database",
        kind: "data model",
        [DATA_MODEL_ATTRIBUTE]: model,
      }),
    );
  }

  const named =
    split.find((b) => b.title !== undefined)?.title ?? split.find((b) => b.id !== undefined)?.id;
  const title = named === undefined ? "Untitled diagram" : clamp(named, "title", "source", 1);
  const head = split[0];
  const headName = head ? blockName(head) : "source";
  const fallbackId = named === undefined ? undefined : slug(title);
  let diagramId: string | undefined;
  let diagramIdSource: DiagramIdSource;
  if (head?.id !== undefined && DIAGRAM_ID_RE.test(head.id)) {
    diagramId = head.id;
    diagramIdSource = "pinned";
  } else {
    if (head?.id !== undefined) {
      const line = head.lines.find((l) => ID_COMMENT.test(l.text))?.line ?? 1;
      const using = fallbackId === undefined ? "" : `; using '${fallbackId}'`;
      report(
        "warning",
        headName,
        line,
        `diagram id '${head.id}' must be lowercase letters, digits and hyphens${using}`,
      );
    }
    diagramId = fallbackId;
    diagramIdSource = fallbackId === undefined ? "none" : "title";
    report(
      "warning",
      headName,
      1,
      fallbackId === undefined ? NO_DIAGRAM_ID : DIAGRAM_ID_FROM_TITLE,
    );
  }

  const first = flows[0];
  const metadata: GraphMetadata = {
    source: "cloudformation",
    generatedAt: new Date().toISOString(),
    authored: true,
    ...(first && { rankdir: first.ast.direction }),
  };

  const result = (graph: ArchGraph): ParseResult => ({
    graph,
    diagnostics: diags.list(),
    blocks: kept,
    title,
    diagramId,
    diagramIdSource,
    ok: !diags.hasErrors(),
  });

  if (nodes.size > MAX_AUTHORED_NODES) {
    report("error", "source", 1, `more than ${MAX_AUTHORED_NODES} nodes`);
    return result({ nodes: [], edges: [], metadata });
  }

  const idCounts = new Map<string, number>();
  for (const flow of flows) {
    for (const e of flow.ast.edges) {
      const clash = [e.source, e.target].find((id) => groups.has(id) && states.has(id));
      if (clash !== undefined) {
        report("error", flow.id, e.line, `'${clash}' is both a group and a state diagram block`);
        continue;
      }
      const { kind: _kind, ...rest } = e.meta;
      const type = e.kind ? EDGE_TYPES[e.kind] : EdgeType.REFERENCE;
      const base = `${e.source}->${type}->${e.target}`;
      const count = (idCounts.get(base) ?? 0) + 1;
      idCounts.set(base, count);
      const edge: ResourceEdge = {
        id: count === 1 ? base : `${base}#${count}`,
        source: e.source,
        target: e.target,
        type,
      };
      if (e.label !== undefined) edge.label = clamp(e.label, "edge label", flow.id, e.line);
      if (e.bidirectional) edge.direction = "bidirectional";
      if (Object.keys(rest).length > 0) edge.attributes = rest;
      edges.push(edge);
    }
  }

  return result({ nodes: [...nodes.values()], edges, metadata });
};
