import { describe, expect, it, vi } from "vitest";
import { type ApiError, CredentialRejectedError, type FetchLike, makeApiClient } from "./api.js";
import type { Config } from "./config.js";

const config: Config = {
  apiUrl: "https://api.test",
  appUrl: "https://app.test",
  clientId: "arc_id",
  clientSecret: "arcsec_secret",
};

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? "" : JSON.stringify(body), { status });

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const key = `${init.method} ${url.replace(config.apiUrl, "")}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    return route(url, init);
  };
  return { fn, calls };
}

const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

describe("makeApiClient", () => {
  it("exchanges the credential once and reuses the token until it nears expiry", async () => {
    let nowMs = 1_000_000;
    let minted = 0;
    const { fn, calls } = fakeFetch({
      "POST /action/token": () => {
        minted += 1;
        return json(200, { accessToken: jwt(nowMs / 1000 + 900) });
      },
      "GET /graphs": () => json(200, { items: [] }),
    });
    const api = makeApiClient(config, fn, () => nowMs);

    await api.get("/graphs");
    await api.get("/graphs");
    expect(minted).toBe(1);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      clientId: "arc_id",
      clientSecret: "arcsec_secret",
    });
    expect(header(calls[1].init, "authorization")).toMatch(/^Bearer h\./);

    nowMs += 850_000;
    await api.get("/graphs");
    expect(minted).toBe(2);
  });

  it("shares one in-flight exchange between concurrent requests", async () => {
    let minted = 0;
    const { fn } = fakeFetch({
      "POST /action/token": () => {
        minted += 1;
        return json(200, { accessToken: "opaque" });
      },
      "GET /graphs": () => json(200, {}),
    });
    const api = makeApiClient(config, fn, () => 0);
    await Promise.all([api.get("/graphs"), api.get("/graphs")]);
    expect(minted).toBe(1);
  });

  it("gives an opaque token a conservative lifetime", async () => {
    let nowMs = 0;
    let minted = 0;
    const { fn } = fakeFetch({
      "POST /action/token": () => {
        minted += 1;
        return json(200, { accessToken: "not-a-jwt" });
      },
      "GET /graphs": () => json(200, {}),
    });
    const api = makeApiClient(config, fn, () => nowMs);
    await api.get("/graphs");
    nowMs = 5 * 60_000;
    await api.get("/graphs");
    expect(minted).toBe(2);
  });

  it("sends the org header and a JSON body on POST", async () => {
    const { fn, calls } = fakeFetch({
      "POST /action/token": () => json(200, { accessToken: "t" }),
      "POST /graphs/generate": () => json(202, { graphId: "g1", status: "pending" }),
    });
    const api = makeApiClient({ ...config, orgId: "org_9" }, fn, () => 0);
    expect(await api.post("/graphs/generate", { repoUrl: "r" })).toEqual({
      graphId: "g1",
      status: "pending",
    });
    const sent = calls[1].init;
    expect(header(sent, "x-arcsync-org")).toBe("org_9");
    expect(header(sent, "content-type")).toBe("application/json");
    expect(sent.body).toBe('{"repoUrl":"r"}');
  });

  it("re-exchanges once when the gateway refuses a cached token", async () => {
    let minted = 0;
    let served = 0;
    const { fn } = fakeFetch({
      "POST /action/token": () => {
        minted += 1;
        return json(200, { accessToken: `t${minted}` });
      },
      "GET /graphs": (_url, init) => {
        served += 1;
        return header(init, "authorization") === "Bearer t1"
          ? json(403, { message: "Forbidden" })
          : json(200, { ok: true });
      },
    });
    const api = makeApiClient(config, fn, () => 0);
    expect(await api.get("/graphs")).toEqual({ ok: true });
    expect(minted).toBe(2);
    expect(served).toBe(2);
  });

  it("explains a refusal that survives a fresh token as a credential-scope problem", async () => {
    const { fn } = fakeFetch({
      "POST /action/token": () => json(200, { accessToken: "t" }),
      "GET /graphs": () => json(403, { message: "Forbidden" }),
    });
    const api = makeApiClient(config, fn, () => 0);
    await expect(api.get("/graphs")).rejects.toThrow(/created as an MCP credential/);
  });

  it("keeps the parsed error body on the ApiError", async () => {
    const body = { error: "bad", diagnostics: [{ level: "error" }] };
    const { fn } = fakeFetch({
      "POST /action/token": () => json(200, { accessToken: "t" }),
      "POST /diagrams/authored": () => json(400, body),
    });
    const api = makeApiClient(config, fn, () => 0);
    await expect(api.post("/diagrams/authored", {})).rejects.toMatchObject({ status: 400, body });
  });

  it("surfaces a handler's own error text and status", async () => {
    const { fn } = fakeFetch({
      "POST /action/token": () => json(200, { accessToken: "t" }),
      "GET /graphs/g1": () => json(404, { error: "Graph not found" }),
      "GET /graphs/g2": () => new Response("upstream timeout", { status: 504 }),
      "GET /graphs/g3": () => json(500, undefined),
      "GET /graphs/g4": () => json(429, { message: "Too Many Requests" }),
    });
    const api = makeApiClient(config, fn, () => 0);
    await expect(api.get("/graphs/g4")).rejects.toMatchObject({
      status: 429,
      message: "Too Many Requests",
    });
    await expect(api.get("/graphs/g1")).rejects.toMatchObject({
      status: 404,
      message: "Graph not found",
    });
    await expect(api.get("/graphs/g2")).rejects.toThrow("upstream timeout");
    await expect(api.get("/graphs/g3")).rejects.toThrow("ArcSync API error 500");
  });

  it("spells out a quota refusal for the agent, over the server's human error", async () => {
    const { fn } = fakeFetch({
      "POST /action/token": () => json(200, { accessToken: "t" }),
      "POST /graphs/generate": () =>
        json(429, {
          ok: false,
          errorCode: "RATE_LIMITED",
          error: "This workspace has reached its hourly parse limit.",
          tier: "free",
          limit: 5,
          used: 5,
          resetAt: "2026-10-21T16:00:00.000Z",
          upgradeUrl: "https://arcsync.dev/pricing",
        }),
      "GET /graphs/frozen": () =>
        json(429, {
          errorCode: "COST_FREEZE",
          limit: 100,
          used: 100,
          resetAt: "",
          upgradeUrl: "https://arcsync.dev/pricing",
        }),
      "GET /graphs/frozen-team": () =>
        json(429, {
          errorCode: "COST_FREEZE",
          tier: "team",
          limit: 100,
          used: 100,
          resetAt: "",
          upgradeUrl: "https://arcsync.dev/pricing",
        }),
      "GET /graphs/frozen-free": () =>
        json(429, {
          errorCode: "COST_FREEZE",
          tier: "free",
          limit: 100,
          used: 100,
          resetAt: "",
          upgradeUrl: "https://arcsync.dev/pricing",
        }),
      "GET /graphs/frozen-trial": () =>
        json(429, {
          errorCode: "COST_FREEZE",
          tier: "pro",
          limit: 100,
          used: 100,
          resetAt: "2026-11-20T12:00:00.000Z",
          upgradeUrl: "https://arcsync.dev/pricing",
        }),
      "GET /graphs/frozen-subscribed": () =>
        json(429, {
          errorCode: "COST_FREEZE",
          tier: "free",
          limit: 100,
          used: 100,
          resetAt: "",
          upgradeUrl: "",
          manageBilling: true,
        }),
      "GET /graphs/plan": () => json(429, { errorCode: "SYNTH_PLAN_REQUIRED" }),
      "GET /graphs/other": () => json(429, { errorCode: "SOMETHING_NEW" }),
      "GET /graphs/bare": () => json(500, { ok: false }),
    });
    const api = makeApiClient(config, fn, () => 0);
    const frozenTrial = await api.get("/graphs/frozen-trial").catch((e: Error) => e.message);
    expect(frozenTrial).toContain(
      "It resumes when the first payment clears, after the trial ends at 2026-11-20T12:00:00.000Z.",
    );
    expect(frozenTrial).not.toContain("Resets at");
    expect(frozenTrial).not.toContain("Upgrade:");
    expect(await api.get("/graphs/frozen-team").catch((e: Error) => e.message)).not.toContain(
      "Upgrade:",
    );
    await expect(api.get("/graphs/frozen-free")).rejects.toThrow(
      "Upgrade: https://arcsync.dev/pricing",
    );
    // #2839: checkout refuses a Free org that still holds a subscription.
    const subscribed = await api.get("/graphs/frozen-subscribed").catch((e: Error) => e.message);
    expect(subscribed).not.toContain("Upgrade:");
    expect(subscribed).toContain("https://arcsync.dev/account/billing");
    await expect(api.post("/graphs/generate", {})).rejects.toMatchObject({
      status: 429,
      message:
        "RATE_LIMITED: the workspace's hourly parse limit is reached; retry after the reset time. Used 5 of 5 on the free plan. Resets at 2026-10-21T16:00:00.000Z. Upgrade: https://arcsync.dev/pricing",
    });
    await expect(api.get("/graphs/frozen")).rejects.toThrow(
      /^COST_FREEZE: parsing is frozen for this workspace; do not retry.*\. Used 100 of 100\.$/,
    );
    await expect(api.get("/graphs/plan")).rejects.toThrow(
      "SYNTH_PLAN_REQUIRED: server-side CDK and Pulumi builds are temporarily limited to paid plans; do not retry on this plan.",
    );
    await expect(api.get("/graphs/other")).rejects.toThrow(
      "SOMETHING_NEW: a usage limit was reached.",
    );
    await expect(api.get("/graphs/bare")).rejects.toThrow("ArcSync API error 500");
  });

  it("does not retry a handler-shaped 403", async () => {
    let served = 0;
    const { fn } = fakeFetch({
      "POST /action/token": () => json(200, { accessToken: "t" }),
      "GET /graphs/g1/history": () => {
        served += 1;
        return json(403, { errorCode: "PRO_FEATURE", error: "Time-travel is a Pro feature" });
      },
    });
    const api = makeApiClient(config, fn, () => 0);
    await expect(api.get("/graphs/g1/history")).rejects.toThrow("Time-travel is a Pro feature");
    expect(served).toBe(1);
  });

  it("explains a rejected credential without echoing it", async () => {
    const { fn } = fakeFetch({
      "POST /action/token": () => json(401, { error: "Invalid client credentials" }),
    });
    const api = makeApiClient(config, fn, () => 0);
    const err = await api.get("/graphs").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialRejectedError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toMatch(/rejected ARCSYNC_CLIENT_ID/);
    expect((err as ApiError).message).not.toContain("arcsec_secret");
  });

  it("reports other exchange failures and a missing token", async () => {
    const failing = makeApiClient(
      config,
      fakeFetch({ "POST /action/token": () => json(500, { error: "kms down" }) }).fn,
      () => 0,
    );
    await expect(failing.get("/graphs")).rejects.toThrow(
      "ArcSync token exchange failed (500): kms down",
    );
    const bare = makeApiClient(
      config,
      fakeFetch({ "POST /action/token": () => json(503, undefined) }).fn,
      () => 0,
    );
    await expect(bare.get("/graphs")).rejects.toThrow("(503): no detail");
    const empty = makeApiClient(
      config,
      fakeFetch({ "POST /action/token": () => json(200, {}) }).fn,
      () => 0,
    );
    await expect(empty.get("/graphs")).rejects.toThrow("returned no accessToken");
  });

  it("retries the exchange after a failed one", async () => {
    let attempt = 0;
    const fetchSpy = vi.fn<FetchLike>(async (url) => {
      if (url.endsWith("/action/token")) {
        attempt += 1;
        return attempt === 1 ? json(500, {}) : json(200, { accessToken: "t" });
      }
      return json(200, { ok: 1 });
    });
    const api = makeApiClient(config, fetchSpy, () => 0);
    await expect(api.get("/graphs")).rejects.toThrow();
    expect(await api.get("/graphs")).toEqual({ ok: 1 });
  });
});
