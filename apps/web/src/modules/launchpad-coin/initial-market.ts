import "server-only";

import { unstable_cache } from "next/cache";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";
import { browserMarketDependencies } from "#web/components/launchpad/blast-infra-browser.ts";
import { boundedPageText } from "#web/lib/backend-api/private-page-read.ts";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import { backendFirstPartyRead } from "#web/modules/partner-api/v1/relay.ts";

const INITIAL_MARKET_TIMEOUT_MS = 1_200;
const MAX_MARKET_BYTES = 1024 * 1024;
const share = processSingleton("web.coin-initial-market", () => createPublicPresaleReader());

export function wantsInitialMarket(headers: Headers, coinPath: string): boolean {
  if (headers.has("next-router-prefetch") || headers.has("next-router-segment-prefetch")) return false;
  if (/\bprefetch\b/i.test(headers.get("sec-purpose") ?? headers.get("purpose") ?? "")) return false;
  if (headers.get("rsc") !== "1") return true;
  try {
    const from = new URL(headers.get("referer") ?? "");
    return decodeURIComponent(from.pathname) !== decodeURIComponent(coinPath);
  } catch {
    return true;
  }
}

/** The same public reads the tab uses, shared across viewers by market path and query. */
export function initialMarketDependencies(expected: ExpectedDeployment | null, requestHeaders: Headers) {
  const ingress = new Headers();
  const address = requestHeaders.get("x-vercel-forwarded-for");
  if (address) ingress.set("x-vercel-forwarded-for", address);
  const fetcher: typeof fetch = async (input) => {
    const path = String(input);
    const cached = unstable_cache(async () => {
      const response = await backendFirstPartyRead(new Request(new URL(path, SITE_ORIGIN), {
        headers: ingress,
        signal: AbortSignal.timeout(INITIAL_MARKET_TIMEOUT_MS),
      }));
      return boundedPageText(response, MAX_MARKET_BYTES, "Initial market read unavailable");
    }, ["coin-initial-market", path], { revalidate: 5 });
    return new Response(await share(path, cached, 0), { headers: { "content-type": "application/json" } });
  };
  return { ...browserMarketDependencies(expected, fetcher), timeoutMs: INITIAL_MARKET_TIMEOUT_MS };
}
