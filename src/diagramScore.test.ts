import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scoreDiagram } from "./diagramScore.js";
import { AUTHORING_FIXTURES } from "./fixtures.js";

const dir = AUTHORING_FIXTURES;
const fixture = (name: string) => readFileSync(new URL(name, dir), "utf8");
// checkout.md is the minimal syntax example: 7 nodes, 2 described, below the eval bar.
const good = readdirSync(dir).filter(
  (f) => f.endsWith(".md") && f !== "broken.md" && f !== "checkout.md",
);

const fence = (body: string) => `\`\`\`arcsync\n${body}\n\`\`\``;

describe("scoreDiagram", () => {
  it.each(good)("%s passes", (name) => {
    const score = scoreDiagram(fixture(name));
    expect(score, JSON.stringify(score)).toMatchObject({ valid: true, pass: true });
  });

  it("has nine full-size fixtures", () => {
    expect(good).toHaveLength(9);
  });

  it("checkout.md is valid but too small to pass", () => {
    expect(scoreDiagram(fixture("checkout.md"))).toMatchObject({
      valid: true,
      nodes: 7,
      containers: 2,
      pass: false,
    });
  });

  it("broken.md is invalid and fails", () => {
    expect(scoreDiagram(fixture("broken.md"))).toMatchObject({ valid: false, pass: false });
  });

  it("fails a flat 10-node diagram with no containers or descriptions", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const source = fence(
      [
        "flowchart LR",
        ...ids.map((id) => `  ${id}[Node ${id}]@{ icon: "aws:lambda" }`),
        `  ${ids.join(" --> ")}`,
      ].join("\n"),
    );
    expect(scoreDiagram(source)).toEqual({
      valid: true,
      nodes: 10,
      containers: 0,
      maxDepth: 0,
      describedRatio: 0,
      iconRatio: 1,
      stateMachines: 0,
      edgeKindsUsed: 1,
      pass: false,
    });
  });

  it("measures nesting, ratios, edge kinds and state machines", () => {
    const source = [
      fence(
        [
          "flowchart LR",
          "  %% diagram: shop",
          '  subgraph cloud[Cloud]@{ kind: "account" }',
          '    subgraph vpc[VPC]@{ kind: "zone" }',
          '      a[API]@{ icon: "aws:api-gateway", description: "Public API" }',
          '      b[Worker]@{ icon: "aws:lamda", description: "Does work", expands: "flow" }',
          "    end",
          "  end",
          '  c[Client]@{ icon: "user" }',
          "  d",
          '  c -- "call"@{ kind: "sync" } --> a',
          "  a -.-> b",
          '  b -- "w"@{ kind: "data" } --> d',
        ].join("\n"),
      ),
      fence("stateDiagram-v2\n  %% diagram: flow\n  [*] --> A\n  A --> [*]"),
      fence("stateDiagram-v2\n  %% diagram: alone\n  [*] --> B"),
    ].join("\n\n");
    expect(scoreDiagram(source)).toEqual({
      valid: true,
      nodes: 4,
      containers: 2,
      maxDepth: 2,
      describedRatio: 0.5,
      iconRatio: 0.5,
      stateMachines: 2,
      edgeKindsUsed: 3,
      pass: false,
    });
  });

  it("scores an empty diagram as zero without dividing by zero", () => {
    expect(scoreDiagram(fence("flowchart LR"))).toMatchObject({
      valid: true,
      nodes: 0,
      describedRatio: 0,
      iconRatio: 0,
      pass: false,
    });
  });
});
