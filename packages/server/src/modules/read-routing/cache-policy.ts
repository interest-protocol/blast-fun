import { GATE_COOKIE_NAME, GATE_COOKIE_NAME_INSECURE } from "@blast/core/lib/web-security/api-gate-protocol.ts";

/**
 * CDN caching for the web app's own responses. Only an anonymous GET (or
 * HEAD) of chain-derived data, answered 200 without a cookie (the API gate's
 * cookie aside, see `carriesCookies`), is public, and
 * only briefly: the CDN may serve it for 10 s and revalidate in the
 * background for 30 s more, while browsers always revalidate. Everything else
 * is `private, no-store`, so a public cache can never hold a session, a
 * social or moderation record, a mutation's result or anything that
 * authorizes a transaction. blast-infra's `/v1` sets its own headers; the web
 * app neither proxies nor rewrites it.
 */
export type ResponseClass =
  | "chain-derived"
  | "social"
  | "authenticated"
  | "moderation"
  | "mutation"
  | "watcher"
  | "preflight";

export const PUBLIC_CHAIN_CACHE_CONTROL = "public, max-age=0, s-maxage=10, stale-while-revalidate=30";
export const PRIVATE_NO_STORE = "private, no-store";

/**
 * Cookies that never make a response personal. The API gate's cookie
 * (docs/security/bot-protection.md) rides on every same-origin request and
 * only proves a page was loaded; were it counted, nothing would ever be
 * publicly cached again. Its value never reaches a handler.
 */
const IGNORED_COOKIES: ReadonlySet<string> = new Set([GATE_COOKIE_NAME, GATE_COOKIE_NAME_INSECURE]);

/** Whether the request carries a cookie a response could depend on. */
function carriesCookies(request: Request): boolean {
  const header = request.headers.get("cookie");
  if (header === null) return false;
  return header.split(";").some((part) => {
    const trimmed = part.trim();
    if (trimmed === "") return false;
    const separator = trimmed.indexOf("=");
    return !IGNORED_COOKIES.has(separator < 0 ? trimmed : trimmed.slice(0, separator).trim());
  });
}

function isPublic(request: Request, responseClass: ResponseClass, response: Response): boolean {
  return (
    responseClass === "chain-derived" &&
    (request.method === "GET" || request.method === "HEAD") &&
    !request.headers.has("authorization") &&
    !carriesCookies(request) &&
    response.status === 200 &&
    !response.headers.has("set-cookie")
  );
}

/**
 * Sets the response's `Cache-Control` from its class and request, replacing
 * any earlier value.
 */
export function withCachePolicy(
  request: Request,
  responseClass: ResponseClass,
  response: Response,
): Response {
  response.headers.set(
    "Cache-Control",
    isPublic(request, responseClass, response) ? PUBLIC_CHAIN_CACHE_CONTROL : PRIVATE_NO_STORE,
  );
  return response;
}
