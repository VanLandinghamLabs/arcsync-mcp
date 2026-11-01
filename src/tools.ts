import type { DeltaEnvelope } from "@auto-arch-diagram/core/graphDelta";
import { renderMermaid } from "@auto-arch-diagram/core/mermaid";
import { z } from "zod";
import type { ApiClient } from "./api.js";
import {
  canvasUrl,
  compact,
  describeResource,
  diagramFields,
  diagramTitle,
  findResource,
  graphAsJson,
  graphOf,
  matchesQuery,
  nodeRef,
  summarizeListItem,
} from "./graph.js";

export interface ToolContext {
  api: ApiClient;
  appUrl: string;
}

export interface ToolDef<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  readOnly: boolean;
  run(ctx: ToolContext, args: z.infer<z.ZodObject<S>>): Promise<string>;
}

export const defineTool = <S extends z.ZodRawShape>(def: ToolDef<S>) => def;

const asJson = (value: unknown) => JSON.stringify(value, null, 2);
const enc = encodeURIComponent;

export const graphIdSchema = (message: string) =>
  z
    .string()
    .min(1)
    .max(200)
    .regex(/^(?!\.{1,2}$)[A-Za-z0-9_:.-]+$/, message);

const graphId = graphIdSchema("a graphId as list_diagrams returns it").describe(
  "The diagram's graphId, as list_diagrams or get_diagram returns it. The id start_parse returned also works.",
);

type Row = Record<string, unknown>;

const MAX_LIST_PAGES = 10;
const MAX_MERMAID_CHARS = 60_000;

const listDiagrams = defineTool({
  name: "list_diagrams",
  title: "List ArcSync diagrams",
  description:
    "List the architecture diagrams in the caller's ArcSync workspace (one per repository, branch and IaC path), newest first. Use it to find the graphId for a repository before calling get_diagram, describe_resource or get_delta. Optional `query` filters by repository URL, owner, repo name, branch, path or project type.",
  inputSchema: {
    query: z.string().max(200).optional().describe("Case-insensitive substring filter."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum rows (default 25)."),
  },
  readOnly: true,
  async run({ api, appUrl }, { query, limit = 25 }) {
    const rows: Row[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES && rows.length < limit; page++) {
      const qs = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const res = await api.get<{ items?: Row[]; cursor?: string }>(`/graphs?${qs}`);
      rows.push(...(res.items ?? []).filter((r) => matchesQuery(r, query ?? "")));
      cursor = res.cursor;
      if (!cursor) break;
    }
    const diagrams = rows.slice(0, limit).map((r) => summarizeListItem(r, appUrl));
    if (diagrams.length === 0) {
      return query
        ? `No diagrams match "${query}". Call list_diagrams without a query to see them all, or start_parse to diagram a repository.`
        : "This workspace has no diagrams yet. Call start_parse with a repository URL to create one.";
    }
    return asJson({ diagrams, more: rows.length > limit || Boolean(cursor) });
  },
});

const getDiagram = defineTool({
  name: "get_diagram",
  title: "Get an ArcSync diagram",
  description:
    'Fetch one architecture diagram ArcSync parsed from infrastructure-as-code. `format: "mermaid"` (default) returns a Mermaid flowchart to show or embed; `format: "json"` returns the resources and relationships as lists to reason over. Both include a link to the interactive canvas. Prefer this to inferring architecture from source files.',
  inputSchema: {
    graphId,
    format: z.enum(["mermaid", "json"]).optional(),
  },
  readOnly: true,
  async run({ api, appUrl }, { graphId: id, format = "mermaid" }) {
    const raw = await api.get<Row>(`/graphs/${enc(id)}`);
    const fields = diagramFields(raw);
    const graph = graphOf(raw);
    // A start_parse id resolves to the diagram's canonical id, which is the
    // one list_diagrams and the version history are keyed by.
    const diagramId = (raw.canonicalGraphId as string | undefined) || id;
    const header = compact({
      graphId: diagramId,
      title: diagramTitle(fields),
      projectType: fields.projectType as string | undefined,
      provider: fields.provider as string | undefined,
      lastParsedAt: (fields.lastParsedAt as string | undefined) || undefined,
      commitSha: fields.commitSha as string | undefined,
      canvasUrl: canvasUrl(appUrl, diagramId),
    });
    if (!graph) {
      const status = (fields.status as string | undefined) ?? "unknown";
      return asJson({
        ...header,
        status,
        note: "This diagram has no graph data yet. If a parse is running, poll get_parse_status.",
      });
    }
    if (format === "json") return asJson({ ...header, ...graphAsJson(graph) });

    const mermaid = renderMermaid(graph);
    const clipped =
      mermaid.length > MAX_MERMAID_CHARS
        ? `${mermaid.slice(0, MAX_MERMAID_CHARS)}\n%% truncated: ${mermaid.length} characters in full; open the canvas for the whole diagram`
        : mermaid;
    return [
      `# ${header.title}`,
      "",
      `Canvas: ${header.canvasUrl}`,
      `Resources: ${graph.nodes.length} · Relationships: ${graph.edges.length}${
        header.lastParsedAt ? ` · Parsed: ${header.lastParsedAt}` : ""
      }`,
      "",
      "```mermaid",
      clipped,
      "```",
    ].join("\n");
  },
});

const describeResourceTool = defineTool({
  name: "describe_resource",
  title: "Describe a resource",
  description:
    "Describe one resource in an ArcSync diagram: its type, IaC attributes, and every relationship in and out (what it calls, reads, is attached to, or is contained by). `resource` may be the resource id, its name, or a substring; an ambiguous match returns the candidates to choose from.",
  inputSchema: {
    graphId,
    resource: z.string().min(1).max(500).describe("Resource id, name, or a substring of either."),
  },
  readOnly: true,
  async run({ api }, { graphId: id, resource }) {
    const graph = graphOf(await api.get<Row>(`/graphs/${enc(id)}`));
    if (!graph) return "This diagram has no graph data yet.";
    const match = findResource(graph, resource);
    if (match.kind === "none") {
      return `No resource in this diagram matches "${resource}". Call get_diagram with format "json" to list them.`;
    }
    if (match.kind === "ambiguous") {
      return asJson({
        note: `"${resource}" matches several resources; call again with one of these ids.`,
        candidates: match.candidates.map(nodeRef),
      });
    }
    return asJson(describeResource(graph, match.node));
  },
});

const listVersions = defineTool({
  name: "list_versions",
  title: "List diagram versions",
  description:
    "List the saved versions of a diagram (one per re-parse, newest first) with the commit each came from and how much it changed. Pass a version's `timestamp` to get_delta to see what it changed. Version history is a Pro feature.",
  inputSchema: { graphId },
  readOnly: true,
  async run({ api }, { graphId: id }) {
    const entries: Row[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const qs = cursor ? `?${new URLSearchParams({ cursor })}` : "";
      const res = await api.get<{ entries?: Row[]; nextCursor?: string }>(
        `/graphs/${enc(id)}/history${qs}`,
      );
      entries.push(...(res.entries ?? []));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    const versions = entries.map((e) =>
      compact({
        timestamp: e.timestamp as string,
        commitSha: e.commitSha as string | undefined,
        triggeredBy: e.triggeredBy as string | undefined,
        changes: e.changeSummary,
      }),
    );
    return versions.length === 0
      ? "No saved versions yet: a version is recorded each time the diagram is re-parsed."
      : asJson({ versions, more: Boolean(cursor) });
  },
});

function describeEnvelope(delta: DeltaEnvelope | undefined, appUrl: string, id: string): unknown {
  if (!delta) {
    return {
      note: "This diagram carries no pull-request delta. A PR delta exists for a PR-branch diagram uploaded by the ArcSync GitHub Action. For changes between saved versions, call list_versions, then get_delta with a version.",
    };
  }
  if (delta.status === "no-base") {
    return {
      status: "no-base",
      note: `The base branch (${delta.baseRef}) has never been diagrammed, so there is nothing to compare against. Run the ArcSync Action on a push to the base branch.`,
    };
  }
  const base = { ref: delta.base.ref, sha: delta.base.sha };
  switch (delta.tier) {
    case "free":
      return {
        base,
        counts: delta.counts,
        note: "Per-resource detail is a Pro feature; only counts are available on this plan.",
      };
    case "pro-counts":
      return {
        base,
        counts: delta.counts,
        note: "Per-resource detail could not be loaded for this delta; only counts are available. Open the canvas or retry later.",
        canvasUrl: `${canvasUrl(appUrl, id)}?delta=1`,
      };
    case "pro":
      return {
        base,
        summary: delta.summary,
        counts: delta.counts,
        resources: delta.nodes,
        relationships: delta.edges,
        canvasUrl: `${canvasUrl(appUrl, id)}?delta=1`,
      };
    default:
      return assertNever(delta);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled delta envelope: ${JSON.stringify(value)}`);
}

const getDelta = defineTool({
  name: "get_delta",
  title: "Get an infrastructure delta",
  description:
    'Show what changed in a diagram\'s infrastructure. Without `version`, returns the pull-request delta for a PR-branch diagram: resources added, removed and changed compared with the base branch. With `version` (a timestamp from list_versions), compares that version with the one before it, or with the latest parse when `against` is "live".',
  inputSchema: {
    graphId,
    version: z
      .string()
      .min(1)
      .max(64)
      .regex(/^(?!\.{1,2}$)[0-9A-Za-z:.+-]+$/, "a timestamp from list_versions")
      .optional(),
    against: z.enum(["previous", "live"]).optional(),
  },
  readOnly: true,
  async run({ api, appUrl }, { graphId: id, version, against = "previous" }) {
    if (!version) {
      const raw = await api.get<Row>(`/graphs/${enc(id)}`);
      return asJson(describeEnvelope(raw.delta as DeltaEnvelope | undefined, appUrl, id));
    }
    const diff = await api.get<Row>(
      `/graphs/${enc(id)}/history/${enc(version)}/diff?against=${against}`,
    );
    if (diff.isInitial)
      return "This is the diagram's first saved version; there is nothing earlier to compare.";
    if (diff.isLiveUnavailable) return "The latest parse has no graph data to compare against.";
    return asJson(
      compact({
        base: diff.base,
        head: diff.head,
        counts: diff.counts,
        resources: diff.nodes,
        relationships: diff.edges,
      }),
    );
  },
});

const GITHUB_REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;

const startParse = defineTool({
  name: "start_parse",
  title: "Diagram a repository",
  description:
    "Ask ArcSync to clone a GitHub repository and parse its infrastructure-as-code (Terraform, CloudFormation, AWS CDK, Pulumi, Azure ARM, Serverless Framework) into a diagram. Returns a graphId at once; poll get_parse_status until it completes, then call get_diagram. Uses one parse from the workspace's monthly quota (CDK and Pulumi also use a server-side synth), so call list_diagrams first and reuse a diagram that already exists. Private repositories need the ArcSync GitHub App installed.",
  inputSchema: {
    repoUrl: z
      .string()
      .regex(GITHUB_REPO_URL, "an https://github.com/owner/repo URL")
      .describe("https://github.com/owner/repo"),
    branch: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "Defaults to the repository's default branch, or main when ArcSync cannot look it up. Pass it when you know it.",
      ),
    path: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("Subdirectory holding the IaC, when it is not at the repository root."),
  },
  readOnly: false,
  async run({ api, appUrl }, { repoUrl, branch, path }) {
    const res = await api.post<{ graphId: string; status: string }>(
      "/graphs/generate",
      compact({ repoUrl: repoUrl.replace(/\/$/, ""), branch, pathOverride: path }),
    );
    return asJson({
      graphId: res.graphId,
      status: res.status,
      canvasUrl: canvasUrl(appUrl, res.graphId),
      next: "Poll get_parse_status with this graphId every few seconds until status is completed or failed.",
    });
  },
});

const getParseStatus = defineTool({
  name: "get_parse_status",
  title: "Check a parse",
  description:
    "Report the progress of a parse started with start_parse: status (pending, running, completed, failed, cancelled), the current phase and percentage, and the error when it failed. Takes the graphId start_parse returned, or the canonical graphId a completed parse reports.",
  inputSchema: { graphId },
  readOnly: true,
  async run({ api, appUrl }, { graphId: id }) {
    const row = await api.get<Row>(`/graphs/${enc(id)}/status`);
    const status = row.status as string | undefined;
    const done = status === "completed";
    const diagramId = (done && (row.canonicalGraphId as string | undefined)) || id;
    return asJson(
      compact({
        graphId: diagramId,
        status,
        phase: row.phase as string | undefined,
        pct: row.pct as number | undefined,
        message: row.currentMsg as string | undefined,
        error: row.error as string | undefined,
        errorCode: row.errorCode as string | undefined,
        canvasUrl: done ? canvasUrl(appUrl, diagramId) : undefined,
        next: done
          ? "Call get_diagram, list_versions or get_delta with this graphId."
          : status === "failed" || status === "cancelled"
            ? undefined
            : "Still running; poll again in a few seconds.",
      }),
    );
  },
});

export const TOOLS = [
  listDiagrams,
  getDiagram,
  describeResourceTool,
  listVersions,
  getDelta,
  startParse,
  getParseStatus,
] as const;
