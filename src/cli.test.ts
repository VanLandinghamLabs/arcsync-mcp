import type { SpawnOptions } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServerApi, type CliDeps, openBrowser, runCommand } from "./cli.js";
import type { LoopbackLogin } from "./login.js";

const CRED = { clientId: "arc_abcdefghijkl", clientSecret: "arcsec_abcdefghijklmnop" };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arcsync-mcp-cli-"));
});
afterEach(async () => {
  await chmod(join(dir, "arcsync"), 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

function fakeSpawn() {
  const calls: Array<[string, string[]]> = [];
  const child = { on: vi.fn(), unref: vi.fn() };
  const spawn = vi.fn((command: string, args: string[], _options: SpawnOptions) => {
    calls.push([command, args]);
    return child;
  });
  return { spawn, calls, child };
}

function deps(over: Partial<CliDeps> = {}): CliDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    env: { XDG_CONFIG_HOME: dir },
    platform: "linux",
    home: "/home/u",
    hostname: "box",
    fetch: vi.fn(),
    now: () => 0,
    spawn: fakeSpawn().spawn,
    log: (m) => logs.push(m),
    logs,
    ...over,
  };
}

const storePath = () => join(dir, "arcsync", "mcp-credential.json");

describe("openBrowser", () => {
  it("uses each platform's opener, detached", () => {
    for (const [platform, command] of [
      ["darwin", "open"],
      ["win32", "rundll32"],
      ["linux", "xdg-open"],
    ] as const) {
      const { spawn, calls, child } = fakeSpawn();
      openBrowser(spawn, platform, "https://arcsync.test/x?a=1&b=2");
      expect(calls[0]?.[0]).toBe(command);
      expect(calls[0]?.[1].at(-1)).toBe("https://arcsync.test/x?a=1&b=2");
      expect(spawn.mock.calls[0]?.[2]).toEqual({ detached: true, stdio: "ignore" });
      expect(child.unref).toHaveBeenCalled();
      expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
    }
  });

  it("swallows a spawn that throws, since the URL is printed anyway", () => {
    expect(() =>
      openBrowser(
        () => {
          throw new Error("ENOENT");
        },
        "linux",
        "https://x",
      ),
    ).not.toThrow();
  });
});

describe("runCommand", () => {
  it("returns null for the server's own invocation", async () => {
    expect(await runCommand(undefined, deps())).toBeNull();
    expect(await runCommand("serve", deps())).toBeNull();
  });

  it("login prints and opens the connect link, then saves the credential", async () => {
    const { spawn, calls } = fakeSpawn();
    const startLogin = vi.fn(
      async (): Promise<LoopbackLogin> => ({
        url: "https://arcsync.dev/settings/mcp/connect?port=5000&state=s",
        credential: Promise.resolve(CRED),
        close: () => {},
      }),
    );
    const d = deps({ spawn, startLogin });
    expect(await runCommand("login", d)).toBe(0);
    expect(startLogin).toHaveBeenCalledWith({
      appUrl: "https://arcsync.dev",
      label: "arcsync-mcp on box",
      holdProcess: true,
    });
    expect(d.logs[0]).toContain("https://arcsync.dev/settings/mcp/connect?port=5000&state=s");
    expect(calls[0]?.[1]).toEqual(["https://arcsync.dev/settings/mcp/connect?port=5000&state=s"]);
    expect(JSON.parse(await readFile(storePath(), "utf8"))).toEqual({
      apiUrl: "https://api.arcsync.dev",
      ...CRED,
    });
    expect(d.logs.at(-1)).toContain(`Saved the credential to ${storePath()}`);
  });

  it("logout removes the stored credential", async () => {
    await runCommand(
      "login",
      deps({
        startLogin: async () => ({ url: "u", credential: Promise.resolve(CRED), close: () => {} }),
      }),
    );
    const d = deps();
    expect(await runCommand("logout", d)).toBe(0);
    await expect(readFile(storePath(), "utf8")).rejects.toThrow();
    expect(d.logs[0]).toMatch(/Removed .*Revoke the credential/);
  });
});

describe("buildServerApi", () => {
  it("uses the stored credential for the configured API", async () => {
    await runCommand(
      "login",
      deps({
        startLogin: async () => ({ url: "u", credential: Promise.resolve(CRED), close: () => {} }),
      }),
    );
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/action/token")) {
        expect(JSON.parse(String(init.body))).toEqual({
          clientId: CRED.clientId,
          clientSecret: CRED.clientSecret,
        });
        return new Response(JSON.stringify({ accessToken: "t" }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    const { api, settings } = buildServerApi(deps({ fetch }));
    expect(settings.appUrl).toBe("https://arcsync.dev");
    expect(await api.get("/graphs")).toEqual({ items: [] });
  });

  it("returns the connect link when nothing is configured, and warns through log", async () => {
    let settle!: (c: typeof CRED) => void;
    const credential = new Promise<typeof CRED>((r) => {
      settle = r;
    });
    await mkdir(join(dir, "arcsync"), { mode: 0o500 });
    const d = deps({
      startLogin: async () => ({ url: "https://connect", credential, close: () => {} }),
    });
    const { api } = buildServerApi(d);
    await expect(api.get("/graphs")).rejects.toThrow("https://connect");
    settle(CRED);
    await new Promise((r) => setTimeout(r, 10));
    expect(d.logs[0]).toMatch(/^arcsync-mcp: connected, but could not save/);
  });
});
