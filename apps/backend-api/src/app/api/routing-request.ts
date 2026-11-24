export const EXACT_ROUTER_CONFIG = {
  caseSensitive: true,
  ignoreDuplicateSlashes: false,
  ignoreTrailingSlash: false,
} as const;

/** Pass only the routing target to Effect. Owners retain the admitted request. */
export function routingRequest(request: Request): Request {
  const url = new URL(request.url);
  url.search = "";
  // Effect rejects malformed escapes and treats ';' as the query separator.
  // Escape only the router input. Owners receive the authenticated request.
  url.pathname = url.pathname.replaceAll("%", "%25").replaceAll(";", "%3B");
  return new Request(url, { method: request.method, signal: request.signal });
}
