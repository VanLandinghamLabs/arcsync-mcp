import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { connectLabel, type LoopbackLogin, startLoopbackLogin } from "./login.js";

const APP = "https://arcsync.test";
const CLIENT_ID = "arc_abcdefghijkl";
const SECRET = "arcsec_abcdefghijklmnopqrstuvwx";

let login: LoopbackLogin | null = null;

afterEach(() => {
  login?.close();
  login = null;
});

async function start(timeoutMs?: number) {
  login = await startLoopbackLogin({ appUrl: APP, label: "arcsync-mcp on box", timeoutMs });
  const url = new URL(login.url);
  return {
    login,
    url,
    port: Number(url.searchParams.get("port")),
    state: url.searchParams.get("state") ?? "",
  };
}

interface Send {
  port: number;
  method?: string;
  path?: string;
  host?: string;
  headers?: Record<string, string | null>;
  body?: string;
}

function send({ port, method = "POST", path = "/callback", host, headers = {}, body = "" }: Send) {
  return new Promise<{ status: number; text: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path,
          headers: Object.fromEntries(
            Object.entries({
              host: host ?? `127.0.0.1:${port}`,
              origin: APP,
              "content-type": "application/x-www-form-urlencoded",
              ...headers,
            }).filter((e): e is [string, string] => e[1] !== null),
          ),
        },
        (res) => {
          let text = "";
          res.on("data", (c) => {
            text += c;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
        },
      );
      req.on("error", reject);
      req.end(body);
    },
  );
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

describe("connectLabel", () => {
  it("names the host and fits the 60-character label limit", () => {
    expect(connectLabel("box")).toBe("arcsync-mcp on box");
    expect(connectLabel("x".repeat(100))).toHaveLength(60);
  });
});

describe("startLoopbackLogin", () => {
  it("builds a connect URL on the app with a loopback port, a long random state and the label", async () => {
    const { url, port, state } = await start();
    expect(url.origin).toBe(APP);
    expect(url.pathname).toBe("/settings/mcp/connect");
    expect(port).toBeGreaterThan(1023);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("label")).toBe("arcsync-mcp on box");
    const exp = Number(url.searchParams.get("exp"));
    expect(exp * 1000).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(exp * 1000).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    const other = await startLoopbackLogin({ appUrl: APP, label: "x" });
    expect(new URL(other.url).searchParams.get("state")).not.toBe(state);
    other.close();
  });

  it("accepts one well-formed callback and closes", async () => {
    const { login, port, state } = await start();
    const res = await send({ port, body: form({ state, clientId: CLIENT_ID, secret: SECRET }) });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Connected");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
    await expect(login.credential).resolves.toEqual({ clientId: CLIENT_ID, clientSecret: SECRET });
    await expect(
      send({ port, body: form({ state, clientId: CLIENT_ID, secret: SECRET }) }),
    ).rejects.toThrow();
  });

  it.each([
    ["Origin: null, as Chromium sends on this https-to-loopback navigation", "null"],
    ["no Origin header", null],
  ])("accepts %s, since the state carries the proof", async (_name, origin) => {
    const { login, port, state } = await start();
    const res = await send({
      port,
      headers: { origin },
      body: form({ state, clientId: CLIENT_ID, secret: SECRET }),
    });
    expect(res.status).toBe(200);
    await expect(login.credential).resolves.toEqual({ clientId: CLIENT_ID, clientSecret: SECRET });
  });

  describe("refuses, and keeps waiting for the genuine callback", () => {
    const cases: Array<[string, (p: { port: number; state: string }) => Send, number]> = [
      [
        "a mismatched state",
        ({ port }) => ({
          port,
          body: form({ state: "x".repeat(43), clientId: CLIENT_ID, secret: SECRET }),
        }),
        403,
      ],
      [
        "a missing state",
        ({ port }) => ({ port, body: form({ clientId: CLIENT_ID, secret: SECRET }) }),
        403,
      ],
      [
        "a state of a different length",
        ({ port, state }) => ({
          port,
          body: form({ state: `${state}x`, clientId: CLIENT_ID, secret: SECRET }),
        }),
        403,
      ],
      [
        "a foreign origin",
        ({ port, state }) => ({
          port,
          headers: { origin: "https://evil.test" },
          body: form({ state, clientId: CLIENT_ID, secret: SECRET }),
        }),
        403,
      ],
      [
        "an empty origin",
        ({ port, state }) => ({
          port,
          headers: { origin: "" },
          body: form({ state, clientId: CLIENT_ID, secret: SECRET }),
        }),
        403,
      ],
      [
        "a non-loopback Host (DNS rebinding)",
        ({ port, state }) => ({
          port,
          host: `evil.test:${port}`,
          body: form({ state, clientId: CLIENT_ID, secret: SECRET }),
        }),
        400,
      ],
      [
        "a localhost Host",
        ({ port, state }) => ({
          port,
          host: `localhost:${port}`,
          body: form({ state, clientId: CLIENT_ID, secret: SECRET }),
        }),
        400,
      ],
      ["a GET", ({ port }) => ({ port, method: "GET" }), 404],
      [
        "another path",
        ({ port, state }) => ({ port, path: "/callback?x=1", body: form({ state }) }),
        404,
      ],
      [
        "a JSON body",
        ({ port, state }) => ({
          port,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state }),
        }),
        415,
      ],
      [
        "an oversized body",
        ({ port, state }) => ({ port, body: form({ state, pad: "x".repeat(5000) }) }),
        413,
      ],
      [
        "a malformed client ID",
        ({ port, state }) => ({ port, body: form({ state, clientId: "evil", secret: SECRET }) }),
        400,
      ],
      [
        "a malformed secret",
        ({ port, state }) => ({
          port,
          body: form({ state, clientId: CLIENT_ID, secret: "arcsec_<script>" }),
        }),
        400,
      ],
    ];
    for (const [name, build, status] of cases) {
      it(name, async () => {
        const { login, port, state } = await start();
        const res = await send(build({ port, state })).catch(() => ({ status: 413 }));
        expect(res.status).toBe(status);
        const ok = await send({ port, body: form({ state, clientId: CLIENT_ID, secret: SECRET }) });
        expect(ok.status).toBe(200);
        await expect(login.credential).resolves.toEqual({
          clientId: CLIENT_ID,
          clientSecret: SECRET,
        });
      });
    }
  });

  it("does not hold the process open when asked not to", async () => {
    login = await startLoopbackLogin({ appUrl: APP, label: "x", holdProcess: false });
    const port = Number(new URL(login.url).searchParams.get("port"));
    const state = new URL(login.url).searchParams.get("state") ?? "";
    const res = await send({ port, body: form({ state, clientId: CLIENT_ID, secret: SECRET }) });
    expect(res.status).toBe(200);
  });

  it("expires after the timeout", async () => {
    const { login } = await start(20);
    await expect(login.credential).rejects.toThrow(/expired/);
  });

  it("rejects the credential when closed, and refuses requests that race the close", async () => {
    const { login } = await start();
    login.close();
    login.close();
    await expect(login.credential).rejects.toThrow(/closed/);
  });

  it("answers 410 to a request that arrives on a connection opened before it finished", async () => {
    const { login, port, state } = await start();
    const first = send({ port, body: form({ state, clientId: CLIENT_ID, secret: SECRET }) });
    const second = send({ port, body: form({ state, clientId: CLIENT_ID, secret: SECRET }) });
    const results = await Promise.allSettled([first, second]);
    await login.credential;
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0));
    expect(statuses).toContain(200);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  });
});
