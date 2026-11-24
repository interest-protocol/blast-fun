import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { cookie, seal, session, type AuthConfig } from "./auth.ts";

type Respond = (status: number, body: string | Buffer, type?: string) => void;
const PUBLIC = new Map([
  ["/dashboard.css", ["dashboard.css", "text/css"]],
  ["/dashboard.js", ["dashboard.js", "text/javascript"]],
  ["/format.js", ["format.js", "text/javascript"]],
  ["/lightweight-charts.mjs", ["lightweight-charts.mjs", "text/javascript"]],
  ["/tokens.css", ["tokens.css", "text/css"]],
  ["/controls.css", ["controls.css", "text/css"]],
  ["/page-header.css", ["page-header.css", "text/css"]],
  ["/empty-state.css", ["empty-state.css", "text/css"]],
  ["/skeleton.css", ["skeleton.css", "text/css"]],
  ["/fonts/geist.woff2", ["fonts/geist.woff2", "font/woff2"]],
  ["/fonts/geist-mono.woff2", ["fonts/geist-mono.woff2", "font/woff2"]],
  ["/fonts/bricolage.woff2", ["fonts/bricolage.woff2", "font/woff2"]],
]);
function setSecurityHeaders(response: ServerResponse, secure: boolean): void {
  for (const [name, value] of Object.entries({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
    // Native same-origin form POSTs need an Origin for the strict CSRF check.
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...(secure ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  }))
    response.setHeader(name, value);
}

/** Byte and wall-clock bounds apply here, even when a future adapter changes server timeouts. */
function readBody(
  request: IncomingMessage,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onData = (value: Buffer) => {
      bytes += value.length;
      if (bytes > 1024) finish(null);
      else chunks.push(value);
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString("utf8"));
    const onError = () => finish(null);
    function finish(value: string | null) {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onError);
      request.pause();
      resolve(value);
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onError);
  });
}

async function redeemLogin(
  request: IncomingMessage,
  response: ServerResponse,
  respond: Respond,
  config: AuthConfig,
  redeem: (code: string) => Promise<string | null>,
  bodyTimeoutMs: number,
): Promise<void> {
  if (
    request.headers["content-type"] !== "application/x-www-form-urlencoded" ||
    Number(request.headers["content-length"] ?? 0) > 1024
  ) {
    respond(400, "Invalid request");
    return;
  }
  const body = await readBody(request, bodyTimeoutMs);
  if (body === null) {
    respond(413, "Invalid request");
    return;
  }
  const form = new URLSearchParams(body);
  if ([...form.keys()].length !== 1 || !form.has("password")) {
    respond(400, "Invalid request");
    return;
  }
  const hash = await redeem(form.get("password")!);
  if (!hash) {
    response.setHeader("Location", "/?access=invalid");
    respond(303, "");
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error();
  const value = seal(config, {
    subject: `code:${hash}`,
    expires: Date.now() + 4 * 3_600_000,
  });
  response.setHeader("Set-Cookie", cookie(config, value, 4 * 3600));
  response.setHeader("Location", "/");
  respond(303, "");
}

function loginHandler(
  config: AuthConfig,
  redeem: (code: string) => Promise<string | null>,
  bodyTimeoutMs: number,
) {
  let active = 0,
    attempts = 0,
    windowStart = 0;
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    respond: Respond,
  ) => {
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      attempts = 0;
    }
    if (++attempts > 30 || active >= 2) {
      response.setHeader("Retry-After", "60");
      respond(429, "Please retry shortly");
      return;
    }
    active++;
    try {
      await redeemLogin(
        request,
        response,
        respond,
        config,
        redeem,
        bodyTimeoutMs,
      );
    } finally {
      active--;
    }
  };
}

async function serveRead(
  request: IncomingMessage,
  path: string,
  respond: Respond,
  config: AuthConfig,
  loadSummary: () => Promise<unknown>,
) {
  const asset = PUBLIC.get(path);
  if (asset) {
    respond(
      200,
      await readFile(new URL(`../public/${asset[0]}`, import.meta.url)),
      asset[1],
    );
    return;
  }
  const member = session(config, request.headers.cookie);
  if (!member) {
    if (path === "/" || path === "/?access=invalid")
      respond(
        200,
        await readFile(new URL("../public/sign-in.html", import.meta.url)),
        "text/html",
      );
    else respond(401, '{"error":"team_access_required"}', "application/json");
    return;
  }
  if (path === "/api/summary") {
    try {
      respond(200, JSON.stringify(await loadSummary()), "application/json");
    } catch {
      respond(503, '{"error":"snapshot_unavailable"}', "application/json");
    }
    return;
  }
  if (path === "/") {
    respond(
      200,
      await readFile(new URL("../public/index.html", import.meta.url)),
      "text/html",
    );
    return;
  }
  respond(404, "Not found");
}

function validRequest(request: IncomingMessage, host: string): boolean {
  const path = request.url ?? "";
  const hostHeaders = request.rawHeaders.filter(
    (_, index) =>
      index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === "host",
  ).length;
  return (
    hostHeaders === 1 &&
    request.headers.host === host &&
    path.length <= 8192 &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("#")
  );
}

async function serveWrite(
  request: IncomingMessage,
  response: ServerResponse,
  respond: Respond,
  config: AuthConfig,
  login: (
    request: IncomingMessage,
    response: ServerResponse,
    respond: Respond,
  ) => Promise<void>,
): Promise<boolean> {
  if (
    request.method !== "POST" ||
    !["/auth/login", "/auth/logout"].includes(request.url ?? "")
  )
    return false;
  response.setHeader("Connection", "close");
  if (request.headers.origin !== config.origin) {
    respond(403, "Invalid origin");
    return true;
  }
  if (request.url === "/auth/login") {
    await login(request, response, respond);
    return true;
  }
  if (
    request.headers["transfer-encoding"] ||
    (request.headers["content-length"] &&
      request.headers["content-length"] !== "0")
  ) {
    respond(400, "Invalid request");
    return true;
  }
  response.setHeader("Set-Cookie", cookie(config, "", 0));
  response.setHeader("Location", "/");
  respond(303, "");
  return true;
}

export function createDashboardHandler(
  config: AuthConfig,
  loadSummary: () => Promise<unknown>,
  redeem: (code: string) => Promise<string | null>,
  options: { bodyTimeoutMs?: number } = {},
) {
  const host = new URL(config.origin).host;
  const login = loginHandler(config, redeem, options.bodyTimeoutMs ?? 1000);
  let active = 0;
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const respond: Respond = (status, body, type = "text/plain") => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "Content-Type": `${type}; charset=utf-8` });
      response.end(body);
    };
    setSecurityHeaders(response, config.secure);
    if (request.url === "/live" && request.method === "GET") {
      respond(200, '{"status":"live"}', "application/json");
      return;
    }
    if (!validRequest(request, host)) {
      respond(400, "Invalid request");
      return;
    }
    if (active >= 32) {
      response.setHeader("Retry-After", "1");
      respond(503, "Please retry shortly");
      return;
    }
    active++;
    try {
      if (await serveWrite(request, response, respond, config, login)) return;
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        respond(405, "Method not allowed");
        return;
      }
      if (
        request.headers["transfer-encoding"] ||
        Number(request.headers["content-length"] ?? 0) > 0
      ) {
        response.setHeader("Connection", "close");
        respond(400, "Invalid request");
        return;
      }
      await serveRead(request, request.url!, respond, config, loadSummary);
    } catch {
      respond(
        503,
        "Analytics is temporarily unavailable. Please retry shortly.",
      );
    } finally {
      active--;
    }
  };
}
