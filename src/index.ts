import { spawn } from "node:child_process";
import { homedir, hostname } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServerApi, type CliDeps, runCommand } from "./cli.js";
import { createServer } from "./server.js";

const deps: CliDeps = {
  env: process.env,
  platform: process.platform,
  home: homedir(),
  hostname: hostname(),
  fetch: (url, init) => fetch(url, init),
  now: Date.now,
  spawn,
  // stdout carries the MCP protocol, so diagnostics go to stderr.
  log: (message) => console.error(message),
};

try {
  const code = await runCommand(process.argv[2], deps);
  if (code !== null) process.exit(code);
  const { api, settings } = buildServerApi(deps);
  await createServer({ api, appUrl: settings.appUrl }).connect(new StdioServerTransport());
} catch (err) {
  console.error(`arcsync-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
