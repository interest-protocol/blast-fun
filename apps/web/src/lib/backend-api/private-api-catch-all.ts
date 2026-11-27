import { routePattern, type RoutePath } from "@blast/core/modules/backend-api/route-path.ts";
import { backendPrivateRequest } from "@blast/server/private/relay.ts";

/** Routes arrive in Next's path priority order, with static segments first. */
export function createPrivateApiCatchAll(routes: ReadonlyArray<readonly [RoutePath, readonly string[]]>) {
  const matches = routes.map(([path, methods]) => {
    // Next also exposes HEAD through GET when a route only exports GET.
    const allowed = new Set([...methods, "OPTIONS"]);
    if (allowed.has("GET")) {
      allowed.add("HEAD");
    }
    return { pattern: routePattern(path), allowed, allow: [...allowed].sort().join(", ") };
  });

  return async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const match = matches.find(({ pattern }) => pattern.test(pathname));
    if (!match) {
      return new Response(null, { status: 404 });
    }
    if (!match.allowed.has(request.method)) {
      return new Response(null, { status: 405 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { Allow: match.allow } });
    }
    return backendPrivateRequest(request);
  };
}
