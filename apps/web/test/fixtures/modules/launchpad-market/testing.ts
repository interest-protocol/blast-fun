// Tests only: the browser's market reads through the real same-origin routes
// (`routes.ts`), to a stand-in blast-infra (the coin fixture server), with
// the key every server request carries.

import type { RateLimitPort } from "../../../../../../packages/core/src/lib/web-security/rate-limits.ts";
import { blastInfraFetch } from "../../../../../../packages/core/src/modules/read-routing/blast-infra.ts";
import { createMarketRoutes, type MarketRoutes } from "@blast/server/modules/launchpad-market/routes.ts";
import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";

/** The key the fixture server requires when started with `apiKey` (32+ printable characters). */
export const TEST_BLAST_INFRA_KEY = "test-blast-infra-key-0123456789abcdef";

/** The app's origin as the routes see it in tests. */
export const TEST_APP_ORIGIN = "http://app.test";

/** The market routes over `origin`, sending `apiKey` (none when null). */
export function testMarketRoutes(
  origin: string,
  options: Readonly<{ apiKey?: string | null; limiter?: RateLimitPort | null; fetch?: typeof fetch }> = {},
): MarketRoutes {
  const apiKey = options.apiKey === undefined ? TEST_BLAST_INFRA_KEY : options.apiKey;
  const environment = apiKey === null ? {} : { BLAST_INFRA_API_KEY: apiKey };
  return createMarketRoutes({
    limiter: options.limiter ?? null,
    upstream: () => ({ origin, fetch: blastInfraFetch({ origin, environment, fetch: options.fetch }) }),
  });
}

/**
 * A browser `fetch` for `browserMarketDependencies`: the relative route it is
 * given is answered by `routes`, as the app would answer it.
 */
export function sameOriginFetch(routes: MarketRoutes): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), TEST_APP_ORIGIN);
    if (url.origin !== TEST_APP_ORIGIN) throw new TypeError(`the browser fetched another origin: ${url.origin}`);
    return routes.handle(new Request(url, { method: init?.method ?? "GET", headers: init?.headers }), testClient());
  }) as typeof fetch;
}
