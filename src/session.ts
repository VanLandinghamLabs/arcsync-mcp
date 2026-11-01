import { type ApiClient, ApiError, CredentialRejectedError } from "./api.js";
import type { Credential } from "./config.js";
import type { CredentialStore } from "./credentialStore.js";
import type { LoopbackLogin } from "./login.js";

export interface SessionDeps {
  envCredential: Credential | null;
  store: CredentialStore;
  startLogin: () => Promise<LoopbackLogin>;
  makeClient: (credential: Credential) => ApiClient;
  warn: (message: string) => void;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * An ApiClient that finds its credential lazily: the environment, then the
 * stored file, then a browser connect link returned as the tool error, which
 * the agent relays to the user. A credential arriving through that link is
 * used from the next call on, with no restart.
 */
export function makeSessionClient(deps: SessionDeps): ApiClient {
  let client: ApiClient | null = null;
  let clientId = "";
  let fromStore = false;
  let pending: Promise<LoopbackLogin> | null = null;

  const use = (credential: Credential, stored: boolean) => {
    client = deps.makeClient(credential);
    clientId = credential.clientId;
    fromStore = stored;
    return client;
  };

  const onLinked = async (credential: Credential) => {
    use(credential, true);
    await deps.store.write(credential).catch((err: unknown) => {
      deps.warn(
        `connected, but could not save the credential to ${deps.store.path} (${reason(err)}); it lasts until this server exits`,
      );
    });
  };

  // Parallel tool calls share one listener, and so one link.
  function startOnce(): Promise<LoopbackLogin> {
    if (pending) return pending;
    const p: Promise<LoopbackLogin> = deps.startLogin().then((started) => {
      started.credential
        .then(onLinked)
        .catch(() => {})
        .finally(() => {
          if (pending === p) pending = null;
        });
      return started;
    });
    p.catch(() => {
      if (pending === p) pending = null;
    });
    pending = p;
    return p;
  }

  async function connectPrompt(): Promise<string> {
    const { url } = await startOnce();
    return `ArcSync is not connected. Ask the user to open this link and click Connect, then call this tool again: ${url}\nThe link works once and expires in 10 minutes.`;
  }

  async function current(): Promise<ApiClient> {
    if (client) return client;
    if (deps.envCredential) return use(deps.envCredential, false);
    const stored = await deps.store.read();
    if (stored) return use(stored, true);
    throw new ApiError(401, await connectPrompt());
  }

  let recovery: Promise<ApiClient | null> | null = null;

  /** Another arcsync-mcp process (or `login`) may have saved a newer
   * credential; only delete the file if it still holds the rejected one. */
  async function replacement(rejected: string): Promise<ApiClient | null> {
    const stored = await deps.store.read().catch(() => null);
    if (stored && stored.clientId !== rejected) return use(stored, true);
    await deps.store.clear().catch((err: unknown) => {
      deps.warn(`could not delete the rejected credential at ${deps.store.path} (${reason(err)})`);
    });
    return null;
  }

  async function call<T>(fn: (c: ApiClient) => Promise<T>, retried = false): Promise<T> {
    const c = await current();
    try {
      return await fn(c);
    } catch (err) {
      if (!(err instanceof CredentialRejectedError)) throw err;
      if (client === c) {
        if (!fromStore) throw err;
        client = null;
        recovery = replacement(clientId);
      }
      // Parallel calls rejected on the same credential share one recovery.
      const next = client ?? (await recovery);
      if (next && !retried) return call(fn, true);
      throw new ApiError(
        401,
        `ArcSync rejected the saved credential; it was probably revoked. ${await connectPrompt()}`,
      );
    }
  }

  return {
    get: (path) => call((c) => c.get(path)),
    post: (path, body) => call((c) => c.post(path, body)),
  };
}
