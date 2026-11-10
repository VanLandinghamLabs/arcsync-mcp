import { describe, expect, it } from "vitest";
import { sampleGraph } from "./fixtures.js";
import {
  boundedAttributes,
  describeResource,
  diagramTitle,
  findResource,
  graphAsJson,
  graphOf,
  matchesQuery,
  summarizeListItem,
} from "./graph.js";

describe("diagramTitle", () => {
  it("prefers the display owner/repo, then the URL, then a placeholder", () => {
    expect(
      diagramTitle({
        displayOwner: "acme",
        displayRepo: "infra",
        branch: "main",
        subpath: "envs/prod",
      }),
    ).toBe("acme/infra@main (envs/prod)");
    expect(diagramTitle({ repoUrl: "https://github.com/acme/api.git" })).toBe("acme/api");
    expect(diagramTitle({ repoUrl: "https://gitlab.com/acme/api" })).toBe(
      "https://gitlab.com/acme/api",
    );
    expect(diagramTitle({})).toBe("diagram");
  });
});

describe("summarizeListItem", () => {
  it("keeps the fields an agent chooses by, coerces counts and drops absent ones", () => {
    expect(
      summarizeListItem(
        {
          graphId: "g 1",
          repoUrl: "https://github.com/acme/infra",
          branch: "main",
          projectType: "terraform",
          provider: "aws",
          status: "completed",
          nodeCount: "12",
          edgeCount: 7,
          prNumber: "not-a-number",
          thumbnailUrl: "https://signed",
        },
        "https://arcsync.dev",
      ),
    ).toEqual({
      graphId: "g 1",
      title: "acme/infra@main",
      repoUrl: "https://github.com/acme/infra",
      branch: "main",
      projectType: "terraform",
      provider: "aws",
      status: "completed",
      resources: 12,
      relationships: 7,
      canvasUrl: "https://arcsync.dev/canvas/g%201",
    });
    expect(summarizeListItem({}, "https://a").graphId).toBe("");
  });
});

describe("matchesQuery", () => {
  const row = { repoUrl: "https://github.com/Acme/Infra", branch: "main", subpath: "envs/prod" };
  it("matches any searchable field case-insensitively, and everything on a blank query", () => {
    expect(matchesQuery(row, "acme/infra")).toBe(true);
    expect(matchesQuery(row, "PROD")).toBe(true);
    expect(matchesQuery(row, "  ")).toBe(true);
    expect(matchesQuery(row, "payments")).toBe(false);
  });
});

describe("graphOf", () => {
  it("returns the graph only when it has node and edge arrays", () => {
    expect(graphOf({ graphData: sampleGraph() })?.nodes).toHaveLength(3);
    expect(graphOf({ graphData: { nodes: [] } })).toBeNull();
    expect(graphOf({})).toBeNull();
  });
});

describe("findResource", () => {
  const g = sampleGraph();
  it("finds by exact id, exact name, or a unique substring", () => {
    expect(findResource(g, "aws_lambda_function.api")).toMatchObject({ kind: "found" });
    expect(findResource(g, "ORDERS")).toMatchObject({
      kind: "found",
      node: { id: "aws_dynamodb_table.orders" },
    });
    expect(findResource(g, "archive")).toMatchObject({
      kind: "found",
      node: { name: "orders_archive" },
    });
  });
  it("returns candidates when a substring is ambiguous, and none when nothing matches", () => {
    const hit = findResource(g, "dynamodb");
    expect(hit.kind).toBe("ambiguous");
    expect(hit.kind === "ambiguous" && hit.candidates.map((n) => n.name)).toEqual([
      "orders",
      "orders_archive",
    ]);
    expect(findResource(g, "s3")).toEqual({ kind: "none" });
    expect(findResource(g, " ")).toEqual({ kind: "none" });
  });
  it("caps the candidate list", () => {
    const many = {
      ...g,
      nodes: Array.from({ length: 30 }, (_, i) => ({
        ...g.nodes[0],
        id: `fn${i}`,
        name: `fn${i}`,
      })),
    };
    const hit = findResource(many, "fn");
    expect(hit.kind === "ambiguous" && hit.candidates).toHaveLength(20);
  });
});

describe("describeResource", () => {
  it("lists relationships in both directions with the peer's name where known", () => {
    const g = sampleGraph();
    expect(describeResource(g, g.nodes[0])).toEqual({
      id: "aws_lambda_function.api",
      name: "api",
      type: "lambda",
      resourceType: "aws_lambda_function",
      provider: "aws",
      attributes: { runtime: "nodejs22.x" },
      outgoing: [
        {
          type: "IAM",
          label: "read/write",
          to: {
            id: "aws_dynamodb_table.orders",
            name: "orders",
            resourceType: "aws_dynamodb_table",
          },
        },
      ],
      incoming: [{ type: "REFERENCE", from: { id: "aws_lambda_function.ghost" } }],
    });
  });
});

describe("boundedAttributes", () => {
  it("passes small attributes through and cuts large ones with a note", () => {
    expect(boundedAttributes({ a: 1 })).toEqual({ a: 1 });
    expect(boundedAttributes(undefined)).toEqual({});
    const big = boundedAttributes({ policy: "x".repeat(10_000) }) as Record<string, unknown>;
    expect(big.truncated).toBe(true);
    expect((big.json as string).length).toBe(6000);
  });
});

describe("graphAsJson", () => {
  it("flattens nodes and edges", () => {
    const out = graphAsJson(sampleGraph());
    expect(out.resources[0]).toEqual({
      id: "aws_lambda_function.api",
      name: "api",
      resourceType: "aws_lambda_function",
      type: "lambda",
    });
    expect(out.relationships[1]).toEqual({
      source: "aws_lambda_function.ghost",
      target: "aws_lambda_function.api",
      type: "REFERENCE",
    });
  });
});
