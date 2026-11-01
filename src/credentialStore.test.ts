import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialPath, makeFileCredentialStore } from "./credentialStore.js";

const API = "https://api.arcsync.test";
const cred = { clientId: "arc_abcdefghijkl", clientSecret: "arcsec_abcdefghijklmnop" };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arcsync-mcp-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("credentialPath", () => {
  it("prefers XDG_CONFIG_HOME, then APPDATA on Windows, then ~/.config", () => {
    expect(credentialPath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe(
      "/x/arcsync/mcp-credential.json",
    );
    expect(credentialPath({ APPDATA: "/appdata" }, "win32", "/home/u")).toBe(
      join("/appdata", "arcsync", "mcp-credential.json"),
    );
    expect(credentialPath({ APPDATA: "/appdata" }, "darwin", "/home/u")).toBe(
      "/home/u/.config/arcsync/mcp-credential.json",
    );
    expect(credentialPath({ XDG_CONFIG_HOME: " " }, "win32", "/home/u")).toBe(
      join("/home/u", ".config", "arcsync", "mcp-credential.json"),
    );
  });
});

describe("makeFileCredentialStore", () => {
  it("reads nothing before a write, and round-trips a write", async () => {
    const store = makeFileCredentialStore(join(dir, "nested", "c.json"), API);
    expect(await store.read()).toBeNull();
    await store.write(cred);
    expect(await store.read()).toEqual(cred);
  });

  it("writes the file 0600 in a 0700 directory, leaving no temp file", async () => {
    const path = join(dir, "arcsync", "c.json");
    await makeFileCredentialStore(path, API).write(cred);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, "arcsync"))).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(join(dir, "arcsync"))).toEqual(["c.json"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ apiUrl: API, ...cred });
  });

  it("ignores a credential minted for another API", async () => {
    const path = join(dir, "c.json");
    await makeFileCredentialStore(path, "https://api.staging.test").write(cred);
    expect(await makeFileCredentialStore(path, API).read()).toBeNull();
  });

  it("reads a corrupt or incomplete file as empty", async () => {
    const path = join(dir, "c.json");
    const store = makeFileCredentialStore(path, API);
    for (const body of [
      "{not json",
      "null",
      JSON.stringify({ apiUrl: API, clientId: 1, clientSecret: "s" }),
      JSON.stringify({ apiUrl: API, clientId: "arc_x", clientSecret: "" }),
    ]) {
      await writeFile(path, body);
      expect(await store.read()).toBeNull();
    }
  });

  it("surfaces read errors other than a missing file", async () => {
    await expect(makeFileCredentialStore(dir, API).read()).rejects.toThrow();
  });

  it("clears the file, and clearing twice is fine", async () => {
    const path = join(dir, "c.json");
    const store = makeFileCredentialStore(path, API);
    await store.write(cred);
    await store.clear();
    await store.clear();
    expect(await store.read()).toBeNull();
    expect(store.path).toBe(path);
  });
});
