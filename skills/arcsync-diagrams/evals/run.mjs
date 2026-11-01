#!/usr/bin/env node
// Evals for the arcsync-diagrams skill. Manual, not CI: every prompt is a model run.
//
//   pnpm --filter arcsync-mcp build          # first: this imports dist/diagramScore.js
//   pnpm --filter arcsync-mcp eval:diagrams  # and starts dist/index.js as the MCP server
//
// Options: --model <alias>  --only id,id  --concurrency <n> (default 4)  --out <dir>
//
// Each prompt runs through headless `claude -p` in a scratch directory whose only
// project skill is this one (user settings, skills, plugins and CLAUDE.md are not
// loaded; Claude Code's bundled skills still are), with only the ArcSync MCP server.
// That server gets a dummy credential and an unroutable API URL: only the local tools
// validate_diagram and list_icons are allowed, and push_diagram and every other
// network tool are denied, so nothing is ever pushed. The `arcsync` blocks in each
// final reply are scored locally. Exits 1 when fewer than 10 of 12 pass.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../../..");
const server = join(pkg, "dist/index.js");
const scorer = join(pkg, "dist/diagramScore.js");
const PASS_GATE = 10;
const TIMEOUT_MS = 15 * 60_000;
const LOCAL_TOOLS = ["validate_diagram", "list_icons"].map((t) => `mcp__arcsync__${t}`);
const DENIED_TOOLS = [
  "push_diagram",
  "get_diagram_source",
  "list_diagrams",
  "get_diagram",
  "describe_resource",
  "get_delta",
  "list_versions",
  "start_parse",
  "get_parse_status",
].map((t) => `mcp__arcsync__${t}`);
const NO_FILES =
  "You cannot write files in this session. Reply with the complete spec section, diagrams included, as markdown in your final message.";

const { values: opts } = parseArgs({
  options: {
    model: { type: "string" },
    only: { type: "string" },
    concurrency: { type: "string", default: "4" },
    out: { type: "string" },
  },
});

if (!existsSync(server) || !existsSync(scorer)) {
  console.error("Build first: pnpm --filter arcsync-mcp build");
  process.exit(2);
}
const { scoreDiagram } = await import(pathToFileURL(scorer).href);
const { framing, prompts: all } = JSON.parse(await readFile(join(here, "prompts.json"), "utf8"));
const only = opts.only?.split(",");
const prompts = only ? all.filter((p) => only.includes(p.id)) : all;

const work = await mkdtemp(join(tmpdir(), "arcsync-diagrams-eval-"));
const out = resolve(opts.out ?? join(work, "out"));
await mkdir(join(work, ".claude/skills/arcsync-diagrams"), { recursive: true });
await mkdir(out, { recursive: true });
await copyFile(join(here, "../SKILL.md"), join(work, ".claude/skills/arcsync-diagrams/SKILL.md"));
const mcpConfig = join(work, "mcp.json");
await writeFile(
  mcpConfig,
  JSON.stringify({
    mcpServers: {
      arcsync: {
        command: process.execPath,
        args: [server],
        env: {
          ARCSYNC_CLIENT_ID: "arc_eval_local_only",
          ARCSYNC_CLIENT_SECRET: "eval-local-only",
          ARCSYNC_API_URL: "http://127.0.0.1:9",
        },
      },
    },
  }),
);

const ARCSYNC_FENCE = /^[ \t]*```+[ \t]*arcsync[^\n]*\n[\s\S]*?^[ \t]*```+[ \t]*$/gm;

const runClaude = (prompt) =>
  new Promise((done) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig,
      "--tools",
      "Skill",
      "--allowedTools",
      ...LOCAL_TOOLS,
      "--disallowedTools",
      ...DENIED_TOOLS,
      "--append-system-prompt",
      NO_FILES,
      ...(opts.model ? ["--model", opts.model] : []),
    ];
    const child = spawn("claude", args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });

const toolCalls = (events) =>
  events.flatMap((e) =>
    e.type === "assistant" && Array.isArray(e.message?.content)
      ? e.message.content.filter((c) => c.type === "tool_use")
      : [],
  );

const evaluate = async ({ id, brief }) => {
  const { code, stdout, stderr } = await runClaude(framing + brief);
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const reply = events.findLast((e) => e.type === "result")?.result ?? "";
  const calls = toolCalls(events);
  const blocks = reply.match(ARCSYNC_FENCE) ?? [];
  await writeFile(join(out, `${id}.md`), reply);
  if (code !== 0) await writeFile(join(out, `${id}.stderr.txt`), stderr);
  const score = blocks.length
    ? scoreDiagram(blocks.join("\n\n"))
    : { ...scoreDiagram("```arcsync\n```"), valid: false, pass: false };
  return {
    id,
    exit: code,
    blocks: blocks.length,
    skill: calls.some((c) => c.name === "Skill" && c.input?.skill === "arcsync-diagrams"),
    validateCalls: calls.filter((c) => c.name === LOCAL_TOOLS[0]).length,
    ...score,
  };
};

const results = [];
const queue = [...prompts];
const worker = async () => {
  for (let p = queue.shift(); p; p = queue.shift()) {
    const r = await evaluate(p);
    console.error(`${r.pass ? "PASS" : "FAIL"} ${r.id}`);
    results.push(r);
  }
};
const concurrency = Math.max(1, Number(opts.concurrency) || 1);
await Promise.all(Array.from({ length: concurrency }, worker));
results.sort(
  (a, b) => prompts.findIndex((p) => p.id === a.id) - prompts.findIndex((p) => p.id === b.id),
);

const pct = (n) => `${Math.round(n * 100)}%`;
const rows = [
  "| prompt | skill | validate | blocks | valid | nodes | containers | depth | described | icons | state machines | edge kinds | pass |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...results
    .map((r) =>
      [
        r.id,
        r.skill ? "yes" : "no",
        r.validateCalls,
        r.blocks,
        r.valid ? "yes" : "no",
        r.nodes,
        r.containers,
        r.maxDepth,
        pct(r.describedRatio),
        pct(r.iconRatio),
        r.stateMachines,
        r.edgeKindsUsed,
        r.pass ? "PASS" : "FAIL",
      ].join(" | "),
    )
    .map((row) => `| ${row} |`),
];
const passed = results.filter((r) => r.pass).length;
const gate = Math.ceil((PASS_GATE / 12) * results.length);
console.log(rows.join("\n"));
console.log(`\nPass rate: ${passed}/${results.length} (gate ${gate}). Replies: ${out}`);
await writeFile(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
process.exit(passed >= gate ? 0 : 1);
