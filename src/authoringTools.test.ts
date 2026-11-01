import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ApiClient, ApiError } from "./api.js";
import { getDiagramSource, listIconsTool, pushDiagram, validateDiagram } from "./authoringTools.js";
import { AUTHORING_FIXTURES } from "./fixtures.js";

const fixture = (name: string) => readFileSync(new URL(name, AUTHORING_FIXTURES), "utf8");

const stub = (handlers: {
  get?: (p: string) => unknown;
  post?: (p: string, b: unknown) => unknown;
}) => {
  const calls: string[] = [];
  const api: ApiClient = {
    async get<T>(path: string) {
      calls.push(`GET ${path}`);
      return handlers.get?.(path) as T;
    },
    async post<T>(path: string, body: unknown) {
      calls.push(`POST ${path} ${JSON.stringify(body)}`);
      return handlers.post?.(path, body) as T;
    },
  };
  return { ctx: { api, appUrl: "https://app.example.test" }, calls };
};

const throwing = (err: unknown) =>
  stub({
    post: () => {
      throw err;
    },
  }).ctx;

const pushed = {
  graphId: "g1",
  diagramId: "checkout-architecture",
  title: "Checkout architecture",
  version: "new",
  canvasUrl: "https://arcsync.dev/canvas/g1",
  embedUrl: "https://embed.arcsync.dev/d/tok",
  diagnostics: [],
};

describe("validate_diagram", () => {
  it("summarises a valid source without a network call", async () => {
    const { ctx, calls } = stub({});
    const text = await validateDiagram.run(ctx, { source: fixture("checkout.md") });
    expect(text).toMatch(
      /^OK: 2 blocks, \d+ nodes \(\d+ containers, \d+ state machines, \d+ with descriptions\), \d+ edges/,
    );
    expect(calls).toEqual([]);
  });

  it("lists diagnostics for a broken source", async () => {
    const text = await validateDiagram.run(stub({}).ctx, { source: fixture("broken.md") });
    expect(text.split("\n")[0]).toBe("INVALID");
    expect(text).toMatch(/^error \S+:\d+:\d+ .+/m);
    expect(text).toMatch(/^warning \S+:\d+:\d+ unknown icon.*\(did you mean .*\?\)/m);
  });

  it("keeps info diagnostics without making the source invalid", async () => {
    const text = await validateDiagram.run(stub({}).ctx, {
      source: "```arcsync\nflowchart LR\n  a --> b\n```",
    });
    expect(text.startsWith("OK:")).toBe(true);
    expect(text).toMatch(/\ninfo \S+:\d+:\d+ node 'a' is created by an edge/);
  });

  it("warns when the diagram id is missing or comes from the title", async () => {
    const none = await validateDiagram.run(stub({}).ctx, {
      source: "```arcsync\nflowchart LR\n  a[A]\n```",
    });
    expect(none).toContain("add %% diagram: <id> to the first block, or pass diagramId");
    const titled = await validateDiagram.run(stub({}).ctx, {
      source: "```arcsync\nflowchart LR\n  %% title: Orders\n  a[A]\n```",
    });
    expect(titled).toContain(
      "diagram id comes from the title; add %% diagram: <id> to keep it stable when the title changes",
    );
  });
});

describe("push_diagram", () => {
  it("posts source, title and diagramId and formats the response", async () => {
    const { ctx, calls } = stub({ post: () => pushed });
    const source = fixture("checkout.md");
    const text = await pushDiagram.run(ctx, {
      source,
      title: "T",
      diagramId: "checkout-architecture",
    });
    expect(calls).toEqual([
      `POST /diagrams/authored ${JSON.stringify({ source, title: "T", diagramId: "checkout-architecture" })}`,
    ]);
    expect(text).toContain("Canvas: https://app.example.test/canvas/g1");
    expect(text).toContain("Embed: https://embed.arcsync.dev/d/tok");
    expect(text).toContain("Version: new");
    expect(text).toContain("Paste the embed link into Notion and choose Embed.");
  });

  it("omits absent title and diagramId from the body", async () => {
    const { ctx, calls } = stub({ post: () => pushed });
    await pushDiagram.run(ctx, { source: fixture("checkout.md") });
    expect(calls[0]).not.toContain('"title"');
    expect(calls[0]).not.toContain('"diagramId"');
  });

  it("pushes nothing when the source has no id and no title to make one", async () => {
    const source = "```arcsync\nflowchart LR\n  a[A]\n```";
    const { ctx, calls } = stub({ post: () => pushed });
    expect(await pushDiagram.run(ctx, { source })).toBe(
      "Nothing was pushed: add %% diagram: <id> to the first block, or pass diagramId.",
    );
    expect(calls).toEqual([]);
    await pushDiagram.run(ctx, { source, diagramId: "named" });
    expect(calls).toHaveLength(1);
  });

  it("prints the share note and no Notion instruction when there is no embed", async () => {
    const { ctx } = stub({
      post: () => ({
        ...pushed,
        embedUrl: null,
        shareNote: "Open Share in ArcSync.",
        version: "unchanged",
      }),
    });
    const text = await pushDiagram.run(ctx, { source: fixture("checkout.md") });
    expect(text).toContain("Embed: not available. Open Share in ArcSync.");
    expect(text).toContain("Version: unchanged");
    expect(text).not.toContain("Paste the embed link");
  });

  it("includes returned warnings", async () => {
    const { ctx } = stub({
      post: () => ({
        ...pushed,
        diagnostics: [{ level: "warning", block: "b", line: 2, column: 1, message: "careful" }],
      }),
    });
    const text = await pushDiagram.run(ctx, { source: fixture("checkout.md") });
    expect(text).toContain("warning b:2:1 careful");
  });

  it("refuses invalid source without calling the API", async () => {
    const { ctx, calls } = stub({ post: () => pushed });
    const text = await pushDiagram.run(ctx, { source: fixture("broken.md") });
    expect(calls).toEqual([]);
    expect(text.startsWith("INVALID")).toBe(true);
    expect(text).toContain("Nothing was pushed");
  });

  it("surfaces a 400's diagnostics", async () => {
    const body = {
      error: "The diagram source has errors",
      diagnostics: [{ level: "error", block: "b", line: 3, column: 5, message: "bad edge" }],
    };
    const err = await pushDiagram
      .run(throwing(new ApiError(400, body.error, body)), { source: fixture("checkout.md") })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain("The diagram source has errors");
    expect((err as Error).message).toContain("error b:3:5 bad edge");
  });

  it("rethrows other errors unchanged", async () => {
    const source = fixture("checkout.md");
    for (const err of [
      new ApiError(429, "QUOTA_EXCEEDED: the monthly quota is used up."),
      new ApiError(400, "diagramId must be lowercase", { error: "x" }),
      new ApiError(400, "no body"),
      new Error("boom"),
    ]) {
      await expect(pushDiagram.run(throwing(err), { source })).rejects.toBe(err);
    }
  });
});

describe("diagnostic caps", () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({
    level: i % 2 ? "info" : "error",
    block: "b",
    line: i,
    column: 1,
    message: i === 0 ? "x".repeat(1000) : `m${i}`,
  }));
  const ok = { ...pushed, diagnostics: many };

  it("shows 50 lines, errors first, and counts the rest", async () => {
    const text = await pushDiagram.run(stub({ post: () => ok }).ctx, {
      source: fixture("checkout.md"),
    });
    const lines = text.split("\n").filter((l) => /^(error|info) /.test(l));
    expect(lines).toHaveLength(50);
    expect(lines.every((l) => l.startsWith("error "))).toBe(true);
    expect(text).toContain("…and 4950 more");
    expect(lines[0]?.length).toBeLessThan(400);
    expect(text.length).toBeLessThan(60_000);
  });

  it("caps a 400's re-sent diagnostics", async () => {
    const err = await pushDiagram
      .run(throwing(new ApiError(400, "bad", { diagnostics: many })), {
        source: fixture("checkout.md"),
      })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain("…and 4950 more");
  });

  it("counts a 400's folded diagnostics against the server's total", async () => {
    const err = await pushDiagram
      .run(
        throwing(
          new ApiError(400, "b".repeat(1000), {
            diagnostics: [{ ...many[0], message: "edge has no target", count: 7 }],
            diagnosticsTotal: 10,
          }),
        ),
        { source: fixture("checkout.md") },
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toContain("edge has no target (×7)");
    expect((err as Error).message).toContain("…and 3 more");
    expect((err as Error).message).toContain(`${"b".repeat(300)}…`);
    expect((err as Error).message).not.toContain("b".repeat(301));
  });

  it("folds repeated diagnostics and trusts the server's total", async () => {
    const repeated = Array.from({ length: 300 }, (_, i) => ({
      level: "warning",
      block: "b",
      line: i,
      column: 1,
      message: "invisible links are not drawn",
    }));
    const local = await pushDiagram.run(
      stub({ post: () => ({ ...pushed, diagnostics: repeated }) }).ctx,
      { source: fixture("checkout.md") },
    );
    expect(local).toContain("warning b:0:1 invisible links are not drawn (×300)");
    expect(local).not.toContain("more");

    const capped = await pushDiagram.run(
      stub({
        post: () => ({
          ...pushed,
          diagnostics: [{ ...repeated[0], count: 120_000 }],
          diagnosticsTotal: 120_005,
        }),
      }).ctx,
      { source: fixture("checkout.md") },
    );
    expect(capped).toContain("invisible links are not drawn (×120000)");
    expect(capped).toContain("…and 5 more");
  });

  it("puts 'Nothing was pushed' before the diagnostics", async () => {
    const text = await pushDiagram.run(stub({}).ctx, { source: fixture("broken.md") });
    expect(text.split("\n").slice(0, 2)).toEqual([
      "INVALID",
      "Nothing was pushed. Fix the errors and try again.",
    ]);
  });

  it("truncates a final output beyond 60,000 characters", async () => {
    const text = await pushDiagram.run(
      stub({ post: () => ({ ...pushed, title: "t".repeat(100_000) }) }).ctx,
      { source: fixture("checkout.md") },
    );
    expect(text.length).toBeLessThan(60_020);
    expect(text.endsWith("…truncated")).toBe(true);
  });
});

describe("get_diagram_source", () => {
  it("returns the stored source", async () => {
    const { ctx, calls } = stub({ get: () => ({ graphId: "g1", diagramId: "d", source: "SRC" }) });
    expect(await getDiagramSource.run(ctx, { graphId: "g1" })).toBe("SRC");
    expect(calls).toEqual(["GET /diagrams/authored/g1/source"]);
  });
});

describe("list_icons", () => {
  it("finds lambda by substring", async () => {
    const text = await listIconsTool.run(stub({}).ctx, { query: "lamb" });
    expect(text).toContain("aws:lambda");
  });

  it("groups by vendor", async () => {
    const text = await listIconsTool.run(stub({}).ctx, {});
    expect(text).toMatch(/^aws \(\d+\): /m);
    expect(text).toMatch(/^generic \(\d+\): /m);
  });

  it("reports no match", async () => {
    expect(await listIconsTool.run(stub({}).ctx, { query: "zzzzqq" })).toBe(
      'No icons match "zzzzqq".',
    );
  });
});
