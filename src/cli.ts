import type { SpawnOptions } from "node:child_process";
import { type ApiClient, type FetchLike, makeApiClient } from "./api.js";
import { envCredential, readSettings, type Settings } from "./config.js";
import {
  type CredentialStore,
  credentialPath,
  makeFileCredentialStore,
} from "./credentialStore.js";
import { connectLabel, type LoopbackLogin, startLoopbackLogin } from "./login.js";
import { makeSessionClient } from "./session.js";

type Spawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => { on(event: "error", cb: () => void): unknown; unref(): void };

export interface CliDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
  hostname: string;
  fetch: FetchLike;
  now: () => number;
  spawn: Spawn;
  log: (message: string) => void;
  startLogin?: typeof startLoopbackLogin;
}

/** Best effort: a headless box has no browser, and the URL is printed anyway. */
export function openBrowser(spawn: Spawn, platform: NodeJS.Platform, url: string): void {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printed URL is the fallback.
  }
}

function setup(deps: CliDeps, holdProcess: boolean) {
  const settings = readSettings(deps.env);
  const store = makeFileCredentialStore(
    credentialPath(deps.env, deps.platform, deps.home),
    settings.apiUrl,
  );
  const startLogin = (): Promise<LoopbackLogin> =>
    (deps.startLogin ?? startLoopbackLogin)({
      appUrl: settings.appUrl,
      label: connectLabel(deps.hostname),
      holdProcess,
    });
  return { settings, store, startLogin };
}

export function buildServerApi(deps: CliDeps): { api: ApiClient; settings: Settings } {
  const { settings, store, startLogin } = setup(deps, false);
  const api = makeSessionClient({
    envCredential: envCredential(deps.env),
    store,
    startLogin,
    makeClient: (credential) => makeApiClient({ ...settings, ...credential }, deps.fetch, deps.now),
    warn: (message) => deps.log(`arcsync-mcp: ${message}`),
  });
  return { api, settings };
}

async function login(deps: CliDeps, store: CredentialStore, start: () => Promise<LoopbackLogin>) {
  const pending = await start();
  deps.log(`Open this link to connect arcsync-mcp to ArcSync:\n\n  ${pending.url}\n`);
  openBrowser(deps.spawn, deps.platform, pending.url);
  const credential = await pending.credential;
  await store.write(credential);
  deps.log(`Connected. Saved the credential to ${store.path}.`);
}

/** `login` / `logout`; null for anything else, which runs the MCP server. */
export async function runCommand(
  command: string | undefined,
  deps: CliDeps,
): Promise<number | null> {
  if (command !== "login" && command !== "logout") return null;
  const { settings, store, startLogin } = setup(deps, true);
  if (command === "logout") {
    await store.clear();
    deps.log(`Removed ${store.path}. Revoke the credential itself at ${settings.appUrl}/settings.`);
    return 0;
  }
  await login(deps, store, startLogin);
  return 0;
}
