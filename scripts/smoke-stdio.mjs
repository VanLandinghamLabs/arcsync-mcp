#!/usr/bin/env node
// Starts a built server, completes the MCP handshake over stdio and checks
// tools/list returns the graph tools. Runs against each release binary before
// anything is published.
//
// Usage: node scripts/smoke-stdio.mjs <command> [args...]

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const EXPECTED_TOOLS = ["list_diagrams", "get_diagram", "validate_diagram"];

/** Resolves with the tool names, or rejects with what went wrong. */
export function smoke(command, args = [], { timeoutMs = 30_000 } = {}) {
  // A throwaway HOME, so a developer's saved credential is never read.
  const home = mkdtempSync(join(tmpdir(), "arcsync-mcp-smoke-"));
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home },
  });
  // A server that dies early fails a write with EPIPE; the exit handler
  // reports that, so the write error itself is dropped.
  child.stdin.on("error", () => {});
  const send = (message) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no tools/list reply in ${timeoutMs}ms`)),
      timeoutMs,
    );
    const settle = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    child.on("error", (err) => settle(reject, err));
    child.on("exit", (code) => settle(reject, new Error(`server exited early with code ${code}`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return settle(reject, new Error(`non-JSON line on stdout: ${line}`));
      }
      if (message.error) return settle(reject, new Error(JSON.stringify(message.error)));
      if (message.id === 1) {
        send({ method: "notifications/initialized" });
        send({ id: 2, method: "tools/list" });
      } else if (message.id === 2) {
        const names = message.result.tools.map((tool) => tool.name);
        const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
        if (missing.length)
          settle(reject, new Error(`tools/list is missing ${missing.join(", ")}`));
        else settle(resolve, names);
      }
    });
  });

  send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "arcsync-mcp-smoke", version: "0" },
    },
  });

  return result.finally(async () => {
    child.removeAllListeners("exit");
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("usage: node scripts/smoke-stdio.mjs <command> [args...]");
    process.exit(1);
  }
  // A relative path to a binary resolves against the cwd, which Windows
  // CreateProcess does not do for a path with forward slashes.
  const isPath = /[\\/]/.test(command);
  smoke(isPath ? resolve(command) : command, args).then(
    (names) => console.log(`ok: ${names.length} tools (${names.join(", ")})`),
    (err) => {
      console.error(`smoke test failed: ${err.message}`);
      process.exit(1);
    },
  );
}
