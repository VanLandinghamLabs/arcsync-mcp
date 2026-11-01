import {
  type CappedDiagnostic,
  capDiagnostics,
  DIAGRAM_ID_RE,
  type Diagnostic,
  listIcons,
  MAX_SOURCE_CHARS,
  NO_DIAGRAM_ID,
  parseArcsync,
} from "@auto-arch-diagram/core/authoring";
import { EdgeType } from "@auto-arch-diagram/core/types";
import { z } from "zod";
import { ApiError } from "./api.js";
import { canvasUrl, compact } from "./graph.js";
import { defineTool, graphIdSchema } from "./tools.js";

const MAX_ICONS = 200;

const source = z
  .string()
  .min(1)
  .max(MAX_SOURCE_CHARS)
  .describe(
    "The diagram as markdown holding ```arcsync fenced blocks (Mermaid flowchart or stateDiagram-v2 syntax with @{ } node metadata).",
  );

const MAX_DIAGNOSTIC_LINES = 50;
const MAX_DIAGNOSTIC_CHARS = 300;
const MAX_OUTPUT_CHARS = 60_000;

const clip = (value: unknown) => {
  const text = String(value);
  return text.length > MAX_DIAGNOSTIC_CHARS ? `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : text;
};

const formatDiagnostic = (d: CappedDiagnostic) =>
  `${d.level} ${d.block}:${d.line}:${d.column} ${d.message}${
    d.suggestion ? ` (did you mean ${d.suggestion}?)` : ""
  }${d.count ? ` (×${d.count})` : ""}`;

/**
 * `total` is the count before any cap: a server response is already capped
 * and says how many it started from.
 */
const diagnosticLines = (diagnostics: Diagnostic[], total = diagnostics.length): string[] => {
  const shown = capDiagnostics(diagnostics, {
    max: MAX_DIAGNOSTIC_LINES,
    messageChars: MAX_DIAGNOSTIC_CHARS,
  });
  const lines = shown.map(formatDiagnostic);
  const more = total - shown.reduce((n, d) => n + (d.count ?? 1), 0);
  return more > 0 ? [...lines, `…and ${more} more`] : lines;
};

const capOutput = (lines: string[]) => {
  const text = lines.join("\n");
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…truncated` : text;
};

const diagnosticsOf = (body: unknown): Diagnostic[] => {
  const list = (body as { diagnostics?: unknown } | null)?.diagnostics;
  return Array.isArray(list) ? (list as Diagnostic[]) : [];
};

const totalOf = (body: unknown, diagnostics: Diagnostic[]): number => {
  const total = (body as { diagnosticsTotal?: unknown } | null)?.diagnosticsTotal;
  return typeof total === "number" ? total : diagnostics.length;
};

const invalid = (diagnostics: Diagnostic[], ...before: string[]) =>
  capOutput(["INVALID", ...before, ...diagnosticLines(diagnostics)]);

export const validateDiagram = defineTool({
  name: "validate_diagram",
  title: "Validate an authored diagram",
  description:
    "Check ArcSync diagram source (```arcsync blocks) locally, without pushing it: reports OK with node and edge counts, or INVALID with one line per problem (block:line:column, and a suggestion when one exists). Run it, fix every error, then call push_diagram.",
  inputSchema: { source },
  readOnly: true,
  async run(_ctx, { source: text }) {
    const parsed = parseArcsync(text);
    if (!parsed.ok) return invalid(parsed.diagnostics);
    const { nodes, edges } = parsed.graph;
    const containers = new Set(
      edges.filter((e) => e.type === EdgeType.CONTAINS).map((e) => e.source),
    ).size;
    const stateMachines = nodes.filter((n) => n.attributes.Definition !== undefined).length;
    const described = nodes.filter((n) => Boolean(n.attributes.description)).length;
    const links = edges.filter((e) => e.type !== EdgeType.CONTAINS).length;
    return capOutput([
      `OK: ${parsed.blocks.length} blocks, ${nodes.length} nodes (${containers} containers, ${stateMachines} state machines, ${described} with descriptions), ${links} edges`,
      ...diagnosticLines(parsed.diagnostics),
    ]);
  },
});

interface PushResponse {
  graphId: string;
  diagramId: string;
  title: string;
  version: "new" | "unchanged";
  canvasUrl: string;
  embedUrl: string | null;
  shareNote?: string;
  diagnostics?: Diagnostic[];
  diagnosticsTotal?: number;
}

export const pushDiagram = defineTool({
  name: "push_diagram",
  title: "Push an authored diagram",
  description:
    "Validate ArcSync diagram source locally, then store it as a private diagram in the caller's workspace. Pushing the same diagramId again updates that diagram. Returns the canvas link and an embed link for Notion. Counts against the workspace's diagram and hourly limits; call validate_diagram first.",
  inputSchema: {
    source,
    title: z.string().min(1).max(200).optional().describe("Defaults to the source's own title."),
    diagramId: z
      .string()
      .regex(DIAGRAM_ID_RE, "lowercase letters, digits and hyphens")
      .optional()
      .describe(
        "Defaults to the `%% diagram:` id in the source's first block, else a slug of the source's title.",
      ),
  },
  readOnly: false,
  async run({ api, appUrl }, { source: text, title, diagramId }) {
    const parsed = parseArcsync(text);
    if (!parsed.ok) {
      return invalid(parsed.diagnostics, "Nothing was pushed. Fix the errors and try again.");
    }
    if (diagramId === undefined && parsed.diagramIdSource === "none") {
      return `Nothing was pushed: ${NO_DIAGRAM_ID}.`;
    }
    let res: PushResponse;
    try {
      res = await api.post<PushResponse>(
        "/diagrams/authored",
        compact({ source: text, title, diagramId }),
      );
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 400) throw err;
      const diagnostics = diagnosticsOf(err.body);
      if (diagnostics.length === 0) throw err;
      throw new ApiError(
        err.status,
        capOutput([
          clip(err.message),
          ...diagnosticLines(diagnostics, totalOf(err.body, diagnostics)),
        ]),
        err.body,
      );
    }
    return capOutput([
      `Pushed "${res.title}" (diagramId ${res.diagramId}, graphId ${res.graphId}).`,
      `Version: ${res.version}`,
      `Canvas: ${canvasUrl(appUrl, res.graphId)}`,
      res.embedUrl
        ? `Embed: ${res.embedUrl}`
        : `Embed: not available. ${res.shareNote ?? ""}`.trim(),
      ...(res.embedUrl ? ["Paste the embed link into Notion and choose Embed."] : []),
      ...diagnosticLines(res.diagnostics ?? [], res.diagnosticsTotal),
    ]);
  },
});

export const getDiagramSource = defineTool({
  name: "get_diagram_source",
  title: "Get an authored diagram's source",
  description:
    "Return the stored ArcSync source text of an authored diagram (one pushed with push_diagram), to edit and push again. Takes the graphId push_diagram returned.",
  inputSchema: {
    graphId: graphIdSchema("a graphId as push_diagram returns it").describe(
      "The graphId push_diagram returned.",
    ),
  },
  readOnly: true,
  async run({ api }, { graphId }) {
    const res = await api.get<{ source: string }>(
      `/diagrams/authored/${encodeURIComponent(graphId)}/source`,
    );
    return res.source;
  },
});

export const listIconsTool = defineTool({
  name: "list_icons",
  title: "List diagram icons",
  description:
    'List the icon ids a diagram node can use in `@{ icon: "..." }` (aws:lambda, azure:function-apps, gcp:cloud-storage, generic ones such as user), grouped by vendor. `query` filters by substring.',
  inputSchema: {
    query: z.string().max(100).optional().describe("Case-insensitive substring, e.g. lambda."),
  },
  readOnly: true,
  async run(_ctx, { query }) {
    const all = listIcons(query);
    if (all.length === 0) return `No icons match "${query}".`;
    const byVendor = new Map<string, string[]>();
    for (const { id, vendor } of all.slice(0, MAX_ICONS)) {
      byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), id]);
    }
    return [
      ...[...byVendor].map(([vendor, ids]) => `${vendor} (${ids.length}): ${ids.join(", ")}`),
      ...(all.length > MAX_ICONS
        ? [`Showing ${MAX_ICONS} of ${all.length}; narrow with a query.`]
        : []),
    ].join("\n");
  },
});

export const AUTHORING_TOOLS = [
  validateDiagram,
  pushDiagram,
  getDiagramSource,
  listIconsTool,
] as const;
