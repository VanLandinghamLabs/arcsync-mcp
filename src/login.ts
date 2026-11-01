import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Credential } from "./config.js";

export interface LoopbackLogin {
  /** The ArcSync page the user opens to approve the connection. */
  url: string;
  /** Resolves with the credential the page hands back; rejects on timeout or close. */
  credential: Promise<Credential>;
  close(): void;
}

export const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY_BYTES = 4096;
const CLIENT_ID = /^arc_[A-Za-z0-9_-]{8,200}$/;
const CLIENT_SECRET = /^arcsec_[A-Za-z0-9_-]{16,200}$/;

const PAGE_HEADERS = {
  "content-security-policy": "default-src 'none'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  connection: "close",
};

export const connectLabel = (hostname: string) => `arcsync-mcp on ${hostname}`.slice(0, 60).trim();

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Listen on 127.0.0.1 for the one credential the ArcSync connect page hands
 * back. Only a form POST addressed to this exact host and port, carrying this
 * listener's `state`, is accepted; it is accepted once, and the listener
 * closes after it or after `timeoutMs`.
 *
 * `state` is what stops a forged callback. Chromium sends `Origin: null` on
 * this https-to-loopback navigation, so the origin check can only refuse a
 * request that names some other site.
 */
export function startLoopbackLogin(opts: {
  appUrl: string;
  label: string;
  timeoutMs?: number;
  /** False in the MCP server, so a pending link never outlives the agent. */
  holdProcess?: boolean;
}): Promise<LoopbackLogin> {
  const timeoutMs = opts.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const state = randomBytes(32).toString("base64url");
  const appOrigin = new URL(opts.appUrl).origin;
  let settle!: { resolve: (c: Credential) => void; reject: (e: Error) => void };
  const credential = new Promise<Credential>((resolve, reject) => {
    settle = { resolve, reject };
  });
  credential.catch(() => {});

  const server = createServer();
  let done = false;
  const finish = (err: Error | null, cred?: Credential) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    if (err) settle.reject(err);
    else settle.resolve(cred as Credential);
  };
  const timer = setTimeout(
    () => finish(new Error("The ArcSync connect link expired before it was used.")),
    timeoutMs,
  );
  timer.unref();

  const refuse = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { ...PAGE_HEADERS, "content-type": "text/plain; charset=utf-8" });
    res.end(`${text}\n`);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, port: number) => {
    if (done) return refuse(res, 410, "This connect link has already been used or has expired.");
    if (req.method !== "POST" || req.url !== "/callback") return refuse(res, 404, "Not found.");
    if (req.headers.host !== `127.0.0.1:${port}`) return refuse(res, 400, "Unexpected host.");
    const { origin } = req.headers;
    if (origin !== undefined && origin !== "null" && origin !== appOrigin) {
      return refuse(res, 403, "Unexpected origin.");
    }
    if (!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
      return refuse(res, 415, "Unexpected content type.");
    }
    const body = await readBody(req);
    if (body === null) return refuse(res, 413, "Request too large.");
    const form = new URLSearchParams(body);
    if (!sameSecret(form.get("state") ?? "", state)) return refuse(res, 403, "State mismatch.");
    const clientId = form.get("clientId") ?? "";
    const clientSecret = form.get("secret") ?? "";
    if (!CLIENT_ID.test(clientId) || !CLIENT_SECRET.test(clientSecret)) {
      return refuse(res, 400, "Malformed credential.");
    }
    res.writeHead(200, { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><title>ArcSync connected</title><h1>Connected</h1><p>arcsync-mcp is connected to ArcSync. You can close this tab and return to your coding agent.</p>",
    );
    finish(null, { clientId, clientSecret });
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      if (opts.holdProcess === false) server.unref();
      server.on("request", (req, res) => {
        handle(req, res, port).catch(() => refuse(res, 400, "Bad request."));
      });
      const params = new URLSearchParams({
        port: String(port),
        state,
        label: opts.label,
        exp: String(Math.floor((Date.now() + timeoutMs) / 1000)),
      });
      resolve({
        url: `${opts.appUrl}/settings/mcp/connect?${params}`,
        credential,
        close: () => finish(new Error("The ArcSync connect listener was closed.")),
      });
    });
  });
}
