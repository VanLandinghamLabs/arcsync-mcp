import { describe, expect, it, vi } from "vitest";
import { type ApiClient, ApiError, CredentialRejectedError } from "./api.js";
import type { Credential } from "./config.js";
import type { CredentialStore } from "./credentialStore.js";
import type { LoopbackLogin } from "./login.js";
import { makeSessionClient } from "./session.js";

const ENV: Credential = { clientId: "arc_env", clientSecret: "arcsec_env" };
const STORED: Credential = { clientId: "arc_stored", clientSecret: "arcsec_stored" };
const LINKED: Credential = { clientId: "arc_linked", clientSecret: "arcsec_linked" };

function memoryStore(initial: Credential | null = null, writeFails = false) {
  let value = initial;
  const store: CredentialStore = {
    path: "/cfg/arcsync/mcp-credential.json",
    read: vi.fn(async () => value),
    write: vi.fn(async (c: Credential) => {
      if (writeFails) throw new Error("EACCES");
      value = c;
    }),
    clear: vi.fn(async () => {
      value = null;
    }),
  };
  return store;
}

function fakeLogin() {
  let n = 0;
  const pending: Array<{ resolve: (c: Credential) => void; reject: (e: Error) => void }> = [];
  const startLogin = vi.fn(async (): Promise<LoopbackLogin> => {
    n += 1;
    let settle!: (typeof pending)[number];
    const credential = new Promise<Credential>((resolve, reject) => {
      settle = { resolve, reject };
    });
    pending.push(settle);
    return { url: `https://arcsync.test/settings/mcp/connect?n=${n}`, credential, close: () => {} };
  });
  return { startLogin, pending };
}

/** A client that answers with the credential it was built from, or throws. */
function clientFor(c: Credential, fail?: () => Error): ApiClient {
  return {
    get: async <T>(path: string) => {
      if (fail) throw fail();
      return `${c.clientId} GET ${path}` as T;
    },
    post: async <T>(path: string) => `${c.clientId} POST ${path}` as T,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("makeSessionClient", () => {
  it("prefers the environment credential and never touches the store", async () => {
    const store = memoryStore(STORED);
    const { startLogin } = fakeLogin();
    const api = makeSessionClient({
      envCredential: ENV,
      store,
      startLogin,
      makeClient: (c) => clientFor(c),
      warn: vi.fn(),
    });
    expect(await api.get("/graphs")).toBe("arc_env GET /graphs");
    expect(await api.post("/x", {})).toBe("arc_env POST /x");
    expect(store.read).not.toHaveBeenCalled();
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("falls back to the stored credential", async () => {
    const makeClient = vi.fn((c: Credential) => clientFor(c));
    const api = makeSessionClient({
      envCredential: null,
      store: memoryStore(STORED),
      startLogin: fakeLogin().startLogin,
      makeClient,
      warn: vi.fn(),
    });
    expect(await api.get("/graphs")).toBe("arc_stored GET /graphs");
    await api.get("/graphs");
    expect(makeClient).toHaveBeenCalledTimes(1);
  });

  it("with no credential, returns the connect link, reuses it, and uses the linked credential without a restart", async () => {
    const store = memoryStore();
    const { startLogin, pending } = fakeLogin();
    const api = makeSessionClient({
      envCredential: null,
      store,
      startLogin,
      makeClient: (c) => clientFor(c),
      warn: vi.fn(),
    });
    const first = await api.get("/graphs").catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ApiError);
    expect((first as ApiError).status).toBe(401);
    expect((first as ApiError).message).toContain(
      "open this link and click Connect, then call this tool again: https://arcsync.test/settings/mcp/connect?n=1",
    );
    const second = await api.get("/graphs").catch((e: unknown) => e);
    expect((second as ApiError).message).toContain("?n=1");
    expect(startLogin).toHaveBeenCalledTimes(1);

    pending[0]?.resolve(LINKED);
    await flush();
    expect(await api.get("/graphs")).toBe("arc_linked GET /graphs");
    expect(store.write).toHaveBeenCalledWith(LINKED);
  });

  it("starts a fresh link after the previous one expires", async () => {
    const { startLogin, pending } = fakeLogin();
    const api = makeSessionClient({
      envCredential: null,
      store: memoryStore(),
      startLogin,
      makeClient: (c) => clientFor(c),
      warn: vi.fn(),
    });
    await api.get("/graphs").catch(() => {});
    pending[0]?.reject(new Error("expired"));
    await flush();
    const next = await api.get("/graphs").catch((e: unknown) => e);
    expect((next as ApiError).message).toContain("?n=2");
  });

  it("keeps a linked credential in memory and warns when it cannot be saved", async () => {
    const warn = vi.fn();
    const { startLogin, pending } = fakeLogin();
    const api = makeSessionClient({
      envCredential: null,
      store: memoryStore(null, true),
      startLogin,
      makeClient: (c) => clientFor(c),
      warn,
    });
    await api.get("/graphs").catch(() => {});
    pending[0]?.resolve(LINKED);
    await flush();
    expect(await api.get("/graphs")).toBe("arc_linked GET /graphs");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  it("drops a stored credential the API rejects and offers the connect link", async () => {
    const store = memoryStore(STORED);
    const { startLogin } = fakeLogin();
    const api = makeSessionClient({
      envCredential: null,
      store,
      startLogin,
      makeClient: (c) => clientFor(c, () => new CredentialRejectedError("revoked")),
      warn: vi.fn(),
    });
    const err = await api.get("/graphs").catch((e: unknown) => e);
    expect((err as ApiError).message).toMatch(/rejected the saved credential.*connect\?n=1/s);
    expect(store.clear).toHaveBeenCalled();
    expect(await store.read()).toBeNull();
  });

  it("parallel calls with no credential share one listener and one link", async () => {
    const { startLogin } = fakeLogin();
    const api = makeSessionClient({
      envCredential: null,
      store: memoryStore(),
      startLogin,
      makeClient: (c) => clientFor(c),
      warn: vi.fn(),
    });
    const errs = await Promise.all(
      [api.get("/a"), api.get("/b"), api.post("/c", {})].map((p) => p.catch((e: unknown) => e)),
    );
    expect(startLogin).toHaveBeenCalledTimes(1);
    for (const e of errs) expect((e as ApiError).message).toContain("?n=1");
  });

  it("surfaces a listener that cannot start, and tries again on the next call", async () => {
    const startLogin = vi
      .fn<() => Promise<LoopbackLogin>>()
      .mockRejectedValueOnce(new Error("EADDRNOTAVAIL"))
      .mockResolvedValueOnce({
        url: "https://second",
        credential: new Promise(() => {}),
        close: () => {},
      });
    const api = makeSessionClient({
      envCredential: null,
      store: memoryStore(),
      startLogin,
      makeClient: (c) => clientFor(c),
      warn: vi.fn(),
    });
    await expect(api.get("/graphs")).rejects.toThrow("EADDRNOTAVAIL");
    await expect(api.get("/graphs")).rejects.toThrow("https://second");
  });

  it("switches to a newer credential another process saved instead of deleting it", async () => {
    const store = memoryStore(STORED);
    const { startLogin } = fakeLogin();
    const api = makeSessionClient({
      envCredential: null,
      store,
      startLogin,
      makeClient: (c) =>
        clientFor(
          c,
          c.clientId === STORED.clientId ? () => new CredentialRejectedError("revoked") : undefined,
        ),
      warn: vi.fn(),
    });
    await api.post("/warm", {});
    await store.write(LINKED);
    expect(await api.get("/graphs")).toBe("arc_linked GET /graphs");
    expect(store.clear).not.toHaveBeenCalled();
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("gives parallel calls on a revoked stored credential the connect link, not the raw error", async () => {
    const store = memoryStore(STORED);
    const api = makeSessionClient({
      envCredential: null,
      store,
      startLogin: fakeLogin().startLogin,
      makeClient: (c) => clientFor(c, () => new CredentialRejectedError("revoked")),
      warn: vi.fn(),
    });
    const errs = await Promise.all(
      [api.get("/a"), api.get("/b")].map((p) => p.catch((e: unknown) => e)),
    );
    for (const e of errs) expect((e as ApiError).message).toContain("connect?n=1");
  });

  it("lets a parallel call reuse the newer credential the first one switched to", async () => {
    const store = memoryStore(STORED);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const api = makeSessionClient({
      envCredential: null,
      store,
      startLogin: fakeLogin().startLogin,
      makeClient: (c) =>
        c.clientId === STORED.clientId
          ? {
              get: async () => {
                await gate;
                throw new CredentialRejectedError("revoked");
              },
              post: async () => "warm" as never,
            }
          : clientFor(c),
      warn: vi.fn(),
    });
    await api.post("/warm", {});
    await store.write(LINKED);
    const both = Promise.all([api.get("/a"), api.get("/b")]);
    release();
    expect(await both).toEqual(["arc_linked GET /a", "arc_linked GET /b"]);
  });

  it("clears and prompts when the newer stored credential is rejected too", async () => {
    const store = memoryStore(STORED);
    const api = makeSessionClient({
      envCredential: null,
      store,
      startLogin: fakeLogin().startLogin,
      makeClient: (c) =>
        c.clientId === STORED.clientId
          ? {
              get: async () => {
                await store.write(LINKED);
                throw new CredentialRejectedError("revoked");
              },
              post: async () => "x" as never,
            }
          : clientFor(c, () => new CredentialRejectedError("revoked too")),
      warn: vi.fn(),
    });
    await expect(api.get("/graphs")).rejects.toThrow(
      /rejected the saved credential.*connect\?n=1/s,
    );
    expect(store.clear).toHaveBeenCalled();
  });

  it("does not swallow a non-rejection failure on the newer credential", async () => {
    const store = memoryStore(STORED);
    const api = makeSessionClient({
      envCredential: null,
      store,
      startLogin: fakeLogin().startLogin,
      makeClient: (c) =>
        c.clientId === STORED.clientId
          ? {
              get: async () => {
                await store.write(LINKED);
                throw new CredentialRejectedError("revoked");
              },
              post: async () => "x" as never,
            }
          : clientFor(c, () => new ApiError(500, "boom")),
      warn: vi.fn(),
    });
    await expect(api.get("/graphs")).rejects.toThrow("boom");
  });

  it("still offers the link when deleting the rejected credential fails", async () => {
    const store = memoryStore(STORED);
    store.clear = vi.fn(async () => {
      throw new Error("EPERM");
    });
    const warn = vi.fn();
    const api = makeSessionClient({
      envCredential: null,
      store,
      startLogin: fakeLogin().startLogin,
      makeClient: (c) => clientFor(c, () => new CredentialRejectedError("revoked")),
      warn,
    });
    await expect(api.get("/graphs")).rejects.toThrow(/connect\?n=1/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EPERM"));
  });

  it("passes a rejected environment credential and other errors straight through", async () => {
    const store = memoryStore();
    const envApi = makeSessionClient({
      envCredential: ENV,
      store,
      startLogin: fakeLogin().startLogin,
      makeClient: (c) => clientFor(c, () => new CredentialRejectedError("revoked")),
      warn: vi.fn(),
    });
    await expect(envApi.get("/graphs")).rejects.toThrow("revoked");
    expect(store.clear).not.toHaveBeenCalled();

    const storedApi = makeSessionClient({
      envCredential: null,
      store: memoryStore(STORED),
      startLogin: fakeLogin().startLogin,
      makeClient: (c) => clientFor(c, () => new ApiError(500, "boom")),
      warn: vi.fn(),
    });
    await expect(storedApi.get("/graphs")).rejects.toThrow("boom");
  });
});
