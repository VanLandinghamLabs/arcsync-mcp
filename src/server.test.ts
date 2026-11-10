import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { type ApiClient, ApiError } from "./api.js";
import { sampleGraph } from "./fixtures.js";
import { createServer } from "./server.js";

type Handler = (body?: unknown) => unknown;

function fakeApi(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const api: ApiClient = {
    async get<T>(path: string) {
      calls.push(`GET ${path}`);
      const h = routes[`GET ${path}`];
      if (!h) throw new ApiError(404, `no route GET ${path}`);
      return h() as T;
    },
    async post<T>(path: string, body: unknown) {
      calls.push(`POST ${path} ${JSON.stringify(body)}`);
      const h = routes[`POST ${path}`];
      if (!h) throw new ApiError(404, `no route POST ${path}`);
      return h(body) as T;
    },
  };
  return { api, calls };
}

let client: Client | null = null;

async function connect(routes: Record<string, Handler>) {
  const { api, calls } = fakeApi(routes);
  const server = createServer({ api, appUrl: "https://arcsync.dev" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await (client as Client).callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
    return { text, isError: res.isError === true };
  };
  return { call, calls, client };
}

afterEach(async () => {
  await client?.close();
  client = null;
});

const CANON_FIELDS = {
  displayOwner: "acme",
  displayRepo: "infra",
  branch: "main",
  projectType: "terraform",
  provider: "aws",
  lastParsedAt: "2026-10-01T00:00:00.000Z",
};

/** A CANON read: the row nested under `canonical`. */
const canon = (extra: Record<string, unknown> = {}) => ({
  graphId: "g1",
  graphData: sampleGraph(),
  canonical: CANON_FIELDS,
  ...extra,
});

/** A start_parse id followed to its CANON: the row spread at the top level. */
const seed = (extra: Record<string, unknown> = {}) => ({
  graphId: "job1",
  ...CANON_FIELDS,
  graphData: sampleGraph(),
  canonicalGraphId: "g1",
  repoInfo: {},
  access: "member",
  role: "owner",
  ...extra,
});

const manyNodes = () =>
  Array.from({ length: 2000 }, (_, i) => ({
    id: `aws_lambda_function.r${i}`,
    type: "lambda",
    name: `r${i}`,
    resourceType: "aws_lambda_function",
  }));

function expectTruncated(text: string, canvas: string) {
  const [body, note] = text.split("\n…truncated: ");
  expect(body).toHaveLength(60_000);
  expect(note).toMatch(/^\d+ characters in full\. Call describe_resource/);
  expect(note.endsWith(`open the canvas: ${canvas}`)).toBe(true);
}

describe("arcsync MCP server", () => {
  it("reports the package's own version in serverInfo", async () => {
    const { client } = await connect({});
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(client.getServerVersion()?.version).toBe(pkg.version);
  });

  it("advertises eleven tools, read-only except start_parse and push_diagram", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "describe_resource",
      "get_delta",
      "get_diagram",
      "get_diagram_source",
      "get_parse_status",
      "list_diagrams",
      "list_icons",
      "list_versions",
      "push_diagram",
      "start_parse",
      "validate_diagram",
    ]);
    const writable = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
    expect(writable.sort()).toEqual(["push_diagram", "start_parse"]);
  });

  describe("list_diagrams", () => {
    it("pages until the limit, filters by query and summarizes rows", async () => {
      const page1 = {
        items: [
          {
            graphId: "a",
            repoUrl: "https://github.com/acme/infra",
            branch: "main",
            status: "completed",
          },
          { graphId: "b", repoUrl: "https://github.com/acme/web", branch: "main" },
        ],
        cursor: "c1",
      };
      const page2 = {
        items: [{ graphId: "c", repoUrl: "https://github.com/acme/infra", branch: "dev" }],
      };
      const { call, calls } = await connect({
        "GET /graphs?limit=100": () => page1,
        "GET /graphs?limit=100&cursor=c1": () => page2,
      });
      const out = JSON.parse((await call("list_diagrams", { query: "infra" })).text);
      expect(out.diagrams.map((d: { graphId: string }) => d.graphId)).toEqual(["a", "c"]);
      expect(out.diagrams[0].canvasUrl).toBe("https://arcsync.dev/canvas/a");
      expect(out.more).toBe(false);
      expect(calls).toHaveLength(2);
    });

    it("stops at the limit and flags that more exist", async () => {
      const { call } = await connect({
        "GET /graphs?limit=100": () => ({ items: [{ graphId: "a" }, { graphId: "b" }] }),
      });
      const out = JSON.parse((await call("list_diagrams", { limit: 1 })).text);
      expect(out).toMatchObject({ diagrams: [{ graphId: "a" }], more: true });
    });

    it("explains an empty workspace and an empty filter", async () => {
      const { call } = await connect({ "GET /graphs?limit=100": () => ({}) });
      expect((await call("list_diagrams")).text).toMatch(/no diagrams yet/);
      expect((await call("list_diagrams", { query: "zzz" })).text).toMatch(
        /No diagrams match "zzz"/,
      );
    });
  });

  describe("get_diagram", () => {
    it("renders Mermaid with a canvas link", async () => {
      const { call } = await connect({ "GET /graphs/g1": () => canon() });
      const { text } = await call("get_diagram", { graphId: "g1" });
      expect(text).toContain("# acme/infra@main");
      expect(text).toContain("Canvas: https://arcsync.dev/canvas/g1");
      expect(text).toContain("Resources: 3 · Relationships: 2 · Parsed: 2026-10-01");
      expect(text).toMatch(/```mermaid\n(flowchart|graph) /);
    });

    it("returns JSON lists on request", async () => {
      const { call } = await connect({ "GET /graphs/g1": () => canon() });
      const out = JSON.parse((await call("get_diagram", { graphId: "g1", format: "json" })).text);
      expect(out).toMatchObject({
        graphId: "g1",
        title: "acme/infra@main",
        projectType: "terraform",
      });
      expect(out.resources).toHaveLength(3);
      expect(out.relationships).toHaveLength(2);
    });

    it("cuts oversized JSON and points at the canonical canvas", async () => {
      const { call } = await connect({
        "GET /graphs/job1": () => seed({ graphData: { ...sampleGraph(), nodes: manyNodes() } }),
      });
      const { text } = await call("get_diagram", { graphId: "job1", format: "json" });
      expectTruncated(text, "https://arcsync.dev/canvas/g1");
      expect(text.slice(0, 200)).toContain('"title": "acme/infra@main"');
    });

    it("reports the canonical graphId when given the id start_parse returned", async () => {
      const { call } = await connect({
        "GET /graphs/job1": () => seed(),
      });
      const out = JSON.parse((await call("get_diagram", { graphId: "job1", format: "json" })).text);
      expect(out).toMatchObject({ graphId: "g1", canvasUrl: "https://arcsync.dev/canvas/g1" });
    });

    it("clips a very large Mermaid document", async () => {
      const g = sampleGraph();
      const base = g.nodes[0];
      g.nodes = Array.from({ length: 1500 }, (_, i) => ({
        ...base,
        id: `aws_lambda_function.fn_with_a_long_name_${i}`,
        name: `fn_with_a_long_name_${i}`,
      }));
      g.edges = [];
      const { call } = await connect({ "GET /graphs/g1": () => ({ graphId: "g1", graphData: g }) });
      const { text } = await call("get_diagram", { graphId: "g1" });
      expect(text).toContain("%% truncated:");
      expect(text).not.toContain("Parsed:");
    });

    it("reports a diagram with no graph data yet", async () => {
      const { call } = await connect({
        "GET /graphs/g1": () => ({ graphId: "g1", status: "running" }),
        "GET /graphs/g2": () => ({ graphId: "g2" }),
      });
      expect(JSON.parse((await call("get_diagram", { graphId: "g1" })).text)).toMatchObject({
        status: "running",
      });
      expect(JSON.parse((await call("get_diagram", { graphId: "g2" })).text).status).toBe(
        "unknown",
      );
    });

    it("rejects a graphId that would change the request path", async () => {
      const { call, calls } = await connect({});
      const res = await call("get_diagram", { graphId: "../account/export.json" });
      expect(res.isError).toBe(true);
      for (const graphId of [".", ".."]) {
        expect((await call("get_diagram", { graphId })).isError).toBe(true);
      }
      expect(calls).toEqual([]);
    });

    it("returns API errors as tool errors", async () => {
      const { call } = await connect({});
      const res = await call("get_diagram", { graphId: "missing" });
      expect(res).toEqual({ isError: true, text: "no route GET /graphs/missing" });
    });
  });

  describe("describe_resource", () => {
    it("describes a match, lists ambiguous candidates, and explains a miss", async () => {
      const { call } = await connect({
        "GET /graphs/g1": () => canon(),
        "GET /graphs/g2": () => ({ graphId: "g2" }),
      });
      const found = JSON.parse(
        (await call("describe_resource", { graphId: "g1", resource: "api" })).text,
      );
      expect(found.outgoing[0].to.name).toBe("orders");
      const amb = JSON.parse(
        (await call("describe_resource", { graphId: "g1", resource: "dynamodb" })).text,
      );
      expect(amb.candidates).toHaveLength(2);
      expect((await call("describe_resource", { graphId: "g1", resource: "s3" })).text).toMatch(
        /No resource/,
      );
      expect((await call("describe_resource", { graphId: "g2", resource: "x" })).text).toMatch(
        /no graph data/,
      );
    });
  });

  describe("list_versions", () => {
    it("lists versions and explains an empty history", async () => {
      const { call } = await connect({
        "GET /graphs/g1/history": () => ({
          entries: [
            {
              timestamp: "2026-10-01T00:00:00.000Z",
              parsedAt: "x",
              commitSha: "abc",
              triggeredBy: "push",
              changeSummary: { added: 1 },
            },
          ],
        }),
        "GET /graphs/g2/history": () => ({}),
      });
      expect(JSON.parse((await call("list_versions", { graphId: "g1" })).text)).toEqual({
        versions: [
          {
            timestamp: "2026-10-01T00:00:00.000Z",
            commitSha: "abc",
            triggeredBy: "push",
            changes: { added: 1 },
          },
        ],
        more: false,
      });
      expect((await call("list_versions", { graphId: "g2" })).text).toMatch(/No saved versions/);
    });

    it("follows nextCursor past the first page and flags a capped history", async () => {
      const entry = (i: number) => ({
        timestamp: `2026-10-01T00:00:${String(i).padStart(2, "0")}Z`,
      });
      const routes: Record<string, Handler> = {
        "GET /graphs/g1/history": () => ({ entries: [entry(0)], nextCursor: "c1" }),
        "GET /graphs/g1/history?cursor=c1": () => ({ entries: [entry(1)] }),
      };
      for (let i = 0; i < 10; i++) {
        routes[`GET /graphs/big/history${i === 0 ? "" : `?cursor=b${i}`}`] = () => ({
          entries: [entry(i)],
          nextCursor: `b${i + 1}`,
        });
      }
      const { call, calls } = await connect(routes);

      const two = JSON.parse((await call("list_versions", { graphId: "g1" })).text);
      expect(two.versions.map((v: { timestamp: string }) => v.timestamp)).toEqual([
        entry(0).timestamp,
        entry(1).timestamp,
      ]);
      expect(two.more).toBe(false);

      const capped = JSON.parse((await call("list_versions", { graphId: "big" })).text);
      expect(capped.versions).toHaveLength(10);
      expect(capped.more).toBe(true);
      expect(calls.filter((c) => c.startsWith("GET /graphs/big/"))).toHaveLength(10);
    });
  });

  describe("get_delta", () => {
    const counts = {
      added: 1,
      removed: 0,
      changed: 0,
      edgesAdded: 0,
      edgesRemoved: 0,
      resources: 1,
    };
    const base = { graphId: "base", ref: "main", sha: "s1", exact: true };

    it("explains each PR delta envelope", async () => {
      const { call } = await connect({
        "GET /graphs/none": () => canon(),
        "GET /graphs/nobase": () => canon({ delta: { status: "no-base", baseRef: "main" } }),
        "GET /graphs/free": () => canon({ delta: { status: "ok", tier: "free", base, counts } }),
        "GET /graphs/pro": () =>
          canon({
            delta: {
              status: "ok",
              tier: "pro",
              base,
              counts,
              summary: "adds 1 DynamoDB",
              nodes: { added: [{ id: "t" }], removed: [], changed: [] },
              edges: { added: [], removed: [] },
            },
          }),
      });
      expect(JSON.parse((await call("get_delta", { graphId: "none" })).text).note).toMatch(
        /no pull-request delta/,
      );
      expect(JSON.parse((await call("get_delta", { graphId: "nobase" })).text)).toMatchObject({
        status: "no-base",
      });
      expect(JSON.parse((await call("get_delta", { graphId: "free" })).text)).toMatchObject({
        counts,
        note: expect.stringMatching(/Pro feature/),
      });
      expect(JSON.parse((await call("get_delta", { graphId: "pro" })).text)).toMatchObject({
        summary: "adds 1 DynamoDB",
        base: { ref: "main", sha: "s1" },
        canvasUrl: "https://arcsync.dev/canvas/pro?delta=1",
      });
    });

    it("does not tell a Pro workspace with an unreadable delta to upgrade", async () => {
      const { call } = await connect({
        "GET /graphs/pc": () =>
          canon({ delta: { status: "ok", tier: "pro-counts", base, counts } }),
        "GET /graphs/future": () =>
          canon({ delta: { status: "ok", tier: "enterprise", base, counts } }),
      });
      const out = JSON.parse((await call("get_delta", { graphId: "pc" })).text);
      expect(out).toMatchObject({ counts, canvasUrl: "https://arcsync.dev/canvas/pc?delta=1" });
      expect(out.note).toMatch(/could not be loaded/);
      expect(out.note).not.toMatch(/Pro feature|plan/);
      const future = await call("get_delta", { graphId: "future" });
      expect(future.isError).toBe(true);
      expect(future.text).toMatch(/Unhandled delta envelope/);
    });

    it("diffs a saved version against the previous one or live", async () => {
      const ts = "2026-10-01T00:00:00.000Z";
      const enc = encodeURIComponent(ts);
      const { call, calls } = await connect({
        [`GET /graphs/g1/history/${enc}/diff?against=previous`]: () => ({
          base: { timestamp: "t0" },
          head: { timestamp: ts },
          isInitial: false,
          isLiveUnavailable: false,
          counts,
          nodes: { added: [], removed: [], changed: [] },
          edges: { added: [], removed: [] },
        }),
        [`GET /graphs/g1/history/${enc}/diff?against=live`]: () => ({ isLiveUnavailable: true }),
        [`GET /graphs/g2/history/${enc}/diff?against=previous`]: () => ({ isInitial: true }),
      });
      expect(
        JSON.parse((await call("get_delta", { graphId: "g1", version: ts })).text),
      ).toMatchObject({
        counts,
      });
      expect(
        (await call("get_delta", { graphId: "g1", version: ts, against: "live" })).text,
      ).toMatch(/no graph data/);
      expect((await call("get_delta", { graphId: "g2", version: ts })).text).toMatch(/first saved/);
      expect(calls[0]).toContain("%3A");
    });

    it("cuts an oversized pull-request delta and links its canvas view", async () => {
      const { call } = await connect({
        "GET /graphs/pro": () => ({
          delta: {
            status: "ok",
            tier: "pro",
            base: { ref: "main", sha: "abc", exact: true },
            summary: "adds many",
            counts,
            nodes: { added: manyNodes(), removed: [], changed: [] },
            edges: { added: [], removed: [] },
          },
        }),
      });
      const { text } = await call("get_delta", { graphId: "pro" });
      expectTruncated(text, "https://arcsync.dev/canvas/pro?delta=1");
    });

    it("cuts an oversized version diff", async () => {
      const ts = "2026-10-01T00:00:00.000Z";
      const { call } = await connect({
        [`GET /graphs/g1/history/${encodeURIComponent(ts)}/diff?against=previous`]: () => ({
          counts,
          nodes: { added: manyNodes(), removed: [], changed: [] },
          edges: { added: [], removed: [] },
        }),
      });
      const { text } = await call("get_delta", { graphId: "g1", version: ts });
      expectTruncated(text, "https://arcsync.dev/canvas/g1");
    });

    it("refuses a version that is not a timestamp", async () => {
      const { call, calls } = await connect({});
      expect((await call("get_delta", { graphId: "g1", version: "../../x" })).isError).toBe(true);
      expect((await call("get_delta", { graphId: "g1", version: "." })).isError).toBe(true);
      expect(calls).toEqual([]);
    });
  });

  describe("start_parse / get_parse_status", () => {
    it("starts a parse with only the fields given", async () => {
      const { call, calls } = await connect({
        "POST /graphs/generate": () => ({ graphId: "job1", status: "pending" }),
      });
      const out = JSON.parse(
        (
          await call("start_parse", {
            repoUrl: "https://github.com/acme/infra/",
            path: "envs/prod",
          })
        ).text,
      );
      expect(out).toMatchObject({ graphId: "job1", status: "pending" });
      expect(calls).toEqual([
        'POST /graphs/generate {"repoUrl":"https://github.com/acme/infra","pathOverride":"envs/prod"}',
      ]);
    });

    it("hands back the canonical graphId once a parse completes", async () => {
      const { call } = await connect({
        "GET /graphs/job1/status": () => ({ status: "completed", canonicalGraphId: "g1" }),
        "GET /graphs/job2/status": () => ({ status: "running", canonicalGraphId: "g1" }),
      });
      expect(JSON.parse((await call("get_parse_status", { graphId: "job1" })).text)).toMatchObject({
        graphId: "g1",
        canvasUrl: "https://arcsync.dev/canvas/g1",
      });
      expect(JSON.parse((await call("get_parse_status", { graphId: "job2" })).text).graphId).toBe(
        "job2",
      );
    });

    it("only accepts GitHub repository URLs", async () => {
      const { call, calls } = await connect({});
      const res = await call("start_parse", { repoUrl: "https://evil.example/acme/infra" });
      expect(res.isError).toBe(true);
      expect(calls).toEqual([]);
    });

    it("reports running, completed and failed parses with the right next step", async () => {
      const { call } = await connect({
        "GET /graphs/j1/status": () => ({
          status: "running",
          phase: "build",
          pct: 40,
          currentMsg: "synth",
        }),
        "GET /graphs/j2/status": () => ({ status: "completed" }),
        "GET /graphs/j3/status": () => ({
          status: "failed",
          error: "no IaC found",
          errorCode: "NO_IAC",
        }),
      });
      expect(JSON.parse((await call("get_parse_status", { graphId: "j1" })).text)).toEqual({
        graphId: "j1",
        status: "running",
        phase: "build",
        pct: 40,
        message: "synth",
        next: "Still running; poll again in a few seconds.",
      });
      expect(JSON.parse((await call("get_parse_status", { graphId: "j2" })).text)).toMatchObject({
        graphId: "j2",
        canvasUrl: "https://arcsync.dev/canvas/j2",
        next: "Call get_diagram, list_versions or get_delta with this graphId.",
      });
      const failed = JSON.parse((await call("get_parse_status", { graphId: "j3" })).text);
      expect(failed).toEqual({
        graphId: "j3",
        status: "failed",
        error: "no IaC found",
        errorCode: "NO_IAC",
      });
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { call } = await connect({
      "GET /graphs/g1": () => {
        throw "plain";
      },
    });
    expect(await call("get_diagram", { graphId: "g1" })).toEqual({ isError: true, text: "plain" });
  });
});
